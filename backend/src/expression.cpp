#include "expression.h"
#include "matrix_value.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace dc {

namespace {

// ── tokenizer (mirrors tokenize() in expression.ts) ────────────────────

enum class Tok { Number, Ident, String, Op, LParen, RParen, Comma, Compare, Eof };

struct Token {
  Tok type;
  std::string value;
  int64_t pos;
  // `[名字]` produced this token: it is always a column reference, never a function call.
  bool quoted = false;
};

std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string toUpper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  return s;
}

bool isDigit(char c) { return c >= '0' && c <= '9'; }

bool envAdvancedMathEnabled() {
  const char* value = std::getenv("DC_ADVANCED_MATH");
  return value != nullptr && value[0] != '\0' && std::strcmp(value, "0") != 0;
}

// Identifiers are UTF-8 byte runs, and every byte >= 0x80 counts as a name byte. That is
// what makes an annotated column addressable by the spelling the card advertises
// ("时间_秒", "地面速度_μm/s" when bracketed) without pulling a Unicode tables dependency
// into either engine: the ranges are structural punctuation and are carved out below.
bool isIdentStart(char c) {
  const unsigned char u = static_cast<unsigned char>(c);
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || u >= 0x80;
}
bool isIdentChar(char c) { return isIdentStart(c) || isDigit(c) || c == '.'; }

// ── full-width / CJK punctuation ───────────────────────────────────────
//
// A Chinese IME produces （） ，× ／ － for what the grammar needs as () , * / - . Rather
// than rewriting the whole expression up front (which would corrupt names that legitimately
// contain full-width glyphs — `[温度（℃）]` must keep its parentheses), each glyph is
// mapped at the point the tokenizer classifies it.
struct FullWidthGlyph {
  const char* glyph;
  const char* ascii;
};

const FullWidthGlyph kFullWidth[] = {
    {"（", "("}, {"）", ")"}, {"，", ","}, {"、", ","}, {"＋", "+"}, {"－", "-"},
    {"−", "-"}, {"＊", "*"}, {"×", "*"}, {"／", "/"}, {"÷", "/"}, {"％", "%"},
    {"＾", "^"}, {"＝", "="}, {"＞", ">"}, {"＜", "<"}, {"≠", "!="},
    {"　", " "},  // U+3000 ideographic space
};

// Byte length of the UTF-8 sequence starting at `i` (1 for ASCII and for malformed bytes).
size_t utf8Length(const std::string& in, size_t i) {
  const unsigned char c = static_cast<unsigned char>(in[i]);
  if (c < 0x80) return 1;
  if ((c & 0xE0) == 0xC0) return 2;
  if ((c & 0xF0) == 0xE0) return 3;
  if ((c & 0xF8) == 0xF0) return 4;
  return 1;
}

// When `in[i..]` starts with a full-width glyph, consume it and report its ASCII meaning.
bool matchFullWidth(const std::string& in, size_t i, size_t* len, std::string* ascii) {
  for (const auto& entry : kFullWidth) {
    const std::string glyph(entry.glyph);
    if (in.compare(i, glyph.size(), glyph) == 0) {
      *len = glyph.size();
      *ascii = entry.ascii;
      return true;
    }
  }
  return false;
}

bool isStructuralAt(const std::string& in, size_t i) {
  size_t len = 0;
  std::string ascii;
  return matchFullWidth(in, i, &len, &ascii);
}

// Character (code point) index of a byte offset. Error positions cross the wire as "第 N 个
// 字符" and the TS engine counts UTF-16 units, so counting only non-continuation bytes is
// what keeps the two engines reporting the same position for mixed ASCII/CJK input.
int64_t codePointIndex(const std::string& in, size_t byteIndex) {
  int64_t count = 0;
  for (size_t i = 0; i < byteIndex && i < in.size(); ++i) {
    if ((static_cast<unsigned char>(in[i]) & 0xC0) != 0x80) ++count;
  }
  return count;
}

const char* const kOpenBrackets[] = {"[", "［", "【"};
const char* const kCloseBrackets[] = {"]", "］", "】"};

bool isBracketOpen(const std::string& in, size_t i) {
  for (const char* open : kOpenBrackets) {
    if (in.compare(i, std::string(open).size(), open) == 0) return true;
  }
  return false;
}

std::string trimName(std::string s) {
  auto stripFront = [&s]() {
    while (!s.empty()) {
      if (s.front() == ' ' || s.front() == '\t' || s.front() == '\r' || s.front() == '\n') {
        s.erase(0, 1);
      } else if (s.compare(0, 3, "　") == 0) {
        s.erase(0, 3);
      } else {
        break;
      }
    }
  };
  auto stripBack = [&s]() {
    while (!s.empty()) {
      const char last = s.back();
      if (last == ' ' || last == '\t' || last == '\r' || last == '\n') {
        s.pop_back();
      } else if (s.size() >= 3 && s.compare(s.size() - 3, 3, "　") == 0) {
        s.erase(s.size() - 3);
      } else {
        break;
      }
    }
  };
  stripFront();
  stripBack();
  return s;
}

/**
 * Scan a bracketed column name starting at `i` (which points at the opener).
 *
 * Everything up to the closer is taken verbatim — that is the entire point: `/`, spaces,
 * parentheses and full-width glyphs inside a name are data, not operators.
 */
bool scanBracket(const std::string& in, size_t* i, std::string* inner, int64_t* openPos) {
  size_t len = 0;
  for (const char* open : kOpenBrackets) {
    const std::string glyph(open);
    if (in.compare(*i, glyph.size(), glyph) == 0) {
      len = glyph.size();
      break;
    }
  }
  if (len == 0) return false;
  *openPos = codePointIndex(in, *i);
  const size_t contentStart = *i + len;
  size_t j = contentStart;
  while (j < in.size()) {
    for (const char* close : kCloseBrackets) {
      const std::string glyph(close);
      if (in.compare(j, glyph.size(), glyph) == 0) {
        inner->assign(in, contentStart, j - contentStart);
        *i = j + glyph.size();
        return true;
      }
    }
    j += utf8Length(in, j);
  }
  return false;  // unclosed: the caller reports "expectedClose"
}

// JS `Math.round`, which the TS reference uses for ROUND: half rounds toward +Infinity,
// whereas std::round rounds half away from zero (Math.round(-1.5) = -1 but
// std::round(-1.5) = -2), and a result landing in [-0.5, 0) is -0 rather than +0.
// Both differences are observable across tiers and were found by the differential fuzz.
inline double jsRound(double x) {
  if (!std::isfinite(x) || x == 0.0) return x;
  const double r = std::floor(x + 0.5);
  return (r == 0.0 && x < 0.0) ? -0.0 : r;
}

// JS `Math.min` / `Math.max`, which the TS reference uses for MIN/MAX and for the MOV
// window bounds: any NaN operand wins (std::min/max instead return the other operand
// whenever the NaN comes second), and ±0 is ordered so min(-0,+0) = -0, max(-0,+0) = +0.
inline double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return (std::signbit(a) || std::signbit(b)) ? -0.0 : 0.0;
  return std::min(a, b);
}

inline double jsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return (std::signbit(a) && std::signbit(b)) ? -0.0 : 0.0;
  return std::max(a, b);
}

// JS `Math.pow` (and `**`), which the TS reference uses for POW and for the `^` operator,
// differs from std::pow on two points the language specs settle differently:
//   * a NaN exponent yields NaN even for base 1 — C99 explicitly returns 1 for
//     pow(+1, y) "for any y, even a NaN" (found by the differential fuzz:
//     POW(POW(B != A, LN(A)), B) collapsed to 1 on the C++ side while TS produced NaN);
//   * base ±1 with an infinite exponent yields NaN — C99 returns 1.
// Order follows the ECMAScript algorithm, so NaN exponent wins over a NaN base.
inline double jsPow(double base, double exp) {
  if (std::isnan(exp)) return NAN;
  if (exp == 0.0) return 1.0;  // covers ±0, and applies even when the base is NaN
  if (std::isnan(base)) return NAN;
  if ((base == 1.0 || base == -1.0) && std::isinf(exp)) return NAN;
  return std::pow(base, exp);
}

std::vector<Token> tokenize(const std::string& input) {
  static const std::string kOps = "+-*/^%";
  static const std::vector<std::string> kCompares = {">=", "<=", "==", "!=", ">", "<"};
  // Positions cross the wire as a character index ("第 N 个字符"); the TS engine counts
  // UTF-16 units, this engine counts UTF-8 code points, and the two agree for everything
  // in the BMP — which is every identifier this grammar accepts.
  auto at = [&input](size_t byteIndex) { return codePointIndex(input, byteIndex); };

  std::vector<Token> tokens;
  size_t i = 0;
  while (i < input.size()) {
    char ch = input[i];
    {
      size_t wsLen = 0;
      std::string wsAscii;
      if (matchFullWidth(input, i, &wsLen, &wsAscii) && wsAscii == " ") { i += wsLen; continue; }
    }
    if (std::isspace(static_cast<unsigned char>(ch))) { ++i; continue; }
    if (ch == '\"' || ch == '\'') {
      if (!envAdvancedMathEnabled()) {
        throw ExpressionError("Unexpected character '" + std::string(1, ch) +
                                  "' at position " + std::to_string(at(i)),
                              at(i), "unexpectedChar", std::string(1, ch));
      }
      char quote = ch;
      size_t start = i;
      ++i;
      std::string value;
      while (i < input.size() && input[i] != quote) {
        value.push_back(input[i++]);
      }
      if (i >= input.size()) {
        throw ExpressionError("Expected '" + std::string(1, quote) + "' to close the string", at(start),
                              "expectedClose", "string");
      }
      ++i;
      tokens.push_back({Tok::String, value, at(start)});
      continue;
    }
    if (isDigit(ch) || (ch == '.' && i + 1 < input.size() && isDigit(input[i + 1]))) {
      size_t start = i;
      while (i < input.size() && (isDigit(input[i]) || input[i] == '.')) ++i;
      if (i < input.size() && (input[i] == 'e' || input[i] == 'E')) {
        ++i;
        if (i < input.size() && (input[i] == '+' || input[i] == '-')) ++i;
        while (i < input.size() && isDigit(input[i])) ++i;
      }
      tokens.push_back({Tok::Number, input.substr(start, i - start), at(start)});
      continue;
    }
    // Bracket-quoted column name: `[地面速度_μm/s]`. The content is data, not grammar.
    if (isBracketOpen(input, i)) {
      std::string inner;
      int64_t openPos = 0;
      if (!scanBracket(input, &i, &inner, &openPos)) {
        throw ExpressionError("Expected ']' to close the column name", openPos, "expectedClose",
                              "[");
      }
      Token tok{Tok::Ident, trimName(inner), openPos, true};
      tokens.push_back(std::move(tok));
      continue;
    }
    // Full-width punctuation stands in for its ASCII operator (（） ， × ／ － …).
    {
      size_t fwLen = 0;
      std::string fwAscii;
      if (matchFullWidth(input, i, &fwLen, &fwAscii)) {
        const int64_t pos = at(i);
        if (fwAscii == "(") tokens.push_back({Tok::LParen, "(", pos});
        else if (fwAscii == ")") tokens.push_back({Tok::RParen, ")", pos});
        else if (fwAscii == ",") tokens.push_back({Tok::Comma, ",", pos});
        else if (fwAscii == ">" || fwAscii == "<") tokens.push_back({Tok::Compare, fwAscii, pos});
        else if (fwAscii == "!=") tokens.push_back({Tok::Compare, "!=", pos});
        else if (fwAscii.size() == 1 && kOps.find(fwAscii[0]) != std::string::npos)
          tokens.push_back({Tok::Op, fwAscii, pos});
        else
          throw ExpressionError("Unexpected character '" + std::string(input, i, fwLen) +
                                    "' at position " + std::to_string(pos),
                                pos, "unexpectedChar", std::string(input, i, fwLen));
        i += fwLen;
        continue;
      }
    }
    if (isIdentStart(ch)) {
      size_t start = i;
      while (i < input.size() && isIdentChar(input[i]) && !isStructuralAt(input, i) &&
             !isBracketOpen(input, i)) ++i;
      std::string ident = input.substr(start, i - start);
      // Hard stop against a stall: an identifier branch that consumes nothing must never
      // loop forever (that is what the full-width-ordering bug above used to do).
      if (ident.empty()) {
        const std::string bad(input, i, utf8Length(input, i));
        throw ExpressionError("Unexpected character '" + bad + "' at position " +
                                  std::to_string(at(i)),
                              at(i), "unexpectedChar", bad);
      }
      // `A.[名字]` / `src.[名字]`: a qualified bracket reference is one name, so the alias
      // prefix and the quoted column are spliced here rather than in the parser.
      if (i < input.size() && isBracketOpen(input, i) && !ident.empty() && ident.back() == '.') {
        ident.pop_back();
        std::string inner;
        int64_t openPos = 0;
        if (!scanBracket(input, &i, &inner, &openPos)) {
          throw ExpressionError("Expected ']' to close the column name", openPos, "expectedClose",
                                "[");
        }
        Token tok{Tok::Ident, ident + "." + trimName(inner), at(start), true};
        tokens.push_back(std::move(tok));
        continue;
      }
      tokens.push_back({Tok::Ident, ident, at(start)});
      continue;
    }
    bool matched = false;
    for (const auto& two : kCompares) {
      if (input.compare(i, 2, two) == 0) {
        tokens.push_back({Tok::Compare, two, at(i)});
        i += 2;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (ch == '>' || ch == '<') {
      tokens.push_back({Tok::Compare, std::string(1, ch), at(i)});
      ++i;
      continue;
    }
    if (kOps.find(ch) != std::string::npos) {
      tokens.push_back({Tok::Op, std::string(1, ch), at(i)});
      ++i;
      continue;
    }
    if (ch == '(') { tokens.push_back({Tok::LParen, "(", at(i)}); ++i; continue; }
    if (ch == ')') { tokens.push_back({Tok::RParen, ")", at(i)}); ++i; continue; }
    if (ch == ',') { tokens.push_back({Tok::Comma, ",", at(i)}); ++i; continue; }
    // Report the whole code point, not one byte of it: a rejected full-width glyph has to
    // read as the character the user typed.
    const std::string bad(input, i, utf8Length(input, i));
    throw ExpressionError("Unexpected character '" + bad + "' at position " +
                              std::to_string(at(i)),
                          at(i), "unexpectedChar", bad);
  }
  tokens.push_back({Tok::Eof, "", at(input.size())});
  return tokens;
}

// ── AST ────────────────────────────────────────────────────────────────

struct Node;
using NodePtr = std::shared_ptr<Node>;

enum class NodeKind { Number, Column, Bound, String, Binary, Unary, Call };

struct Node {
  NodeKind kind;
  double number = 0;          // Number
  int column = -1;            // Column: index into the provided columns
  std::string columnName;     // Column: original spelling (for references())
  std::string op;             // Binary / Unary
  std::string name;           // Call: upper-cased function name
  std::string boundName;       // Advanced call: the identifier its first expression binds
  int64_t boundId = -1;         // Lexical identity; nested same-name variables get distinct ids
  std::string stringValue;     // String literal
  std::vector<NodePtr> children;
};

// ── parser (recursive-descent with precedence climbing, mirrors parse()) ─

struct FunctionSpec {
  int minArgs;
  int maxArgs;  // INT32_MAX for variadic
};

const std::unordered_map<std::string, FunctionSpec>& functions() {
  static const std::unordered_map<std::string, FunctionSpec> kFns = {
      {"SUM", {1, 1}},   {"AVG", {1, 1}},    {"MEAN", {1, 1}}, {"MIN", {1, INT32_MAX}},
      {"MAX", {1, INT32_MAX}}, {"MEDIAN", {1, 1}}, {"STD", {1, 1}}, {"ABS", {1, 1}},
      {"SQRT", {1, 1}},  {"LOG", {1, 1}},    {"LN", {1, 1}},   {"LOG10", {1, 1}},
      {"EXP", {1, 1}},   {"POW", {2, 2}},    {"ROUND", {1, 2}}, {"FLOOR", {1, 1}},
      {"CEIL", {1, 1}},  {"SIGN", {1, 1}},   {"MOV", {2, 2}},  {"EMA", {2, 2}},
      {"IF", {3, 3}},
      // Summary statistics (added for `builtin:summary`). Same contract as the ones
      // above: reduce the column to a scalar, then broadcast. COUNT/NAN/VAR/SEM reduce
      // like the others; QUANTILE takes a second argument (the quantile, constant or
      // column) and therefore returns a PER-ROW vector — see its branch in compileAst.
      {"COUNT", {1, 1}},
      {"NAN", {1, 1}},
      {"VAR", {1, 1}},
      {"SEM", {1, 1}},
      {"QUANTILE", {2, 2}},
      // Matrix-mode functions (only meaningful when evaluateMatrix is used; cell-mode
      // evaluate() will reject them as unknown — that's fine, they're matrix-only).
      {"TRANSPOSE", {1, 1}},
      {"DET", {1, 1}},
      {"INV", {1, 1}},
      {"SOLVE", {2, 2}},
      {"MMUL", {2, 2}},
      {"EMUL", {2, 2}},
  };
  if (!envAdvancedMathEnabled()) return kFns;

  static const std::unordered_map<std::string, FunctionSpec> kAdvancedFns = [&] {
    auto out = kFns;
    out.emplace("COMBIN", FunctionSpec{2, 2});
    out.emplace("PERMUT", FunctionSpec{2, 2});
    // Trigonometry lives under the capability too: the v1 surface (and the TS reference
    // engine that diff_fuzz compares against) stays untouched.
    out.emplace("SIN", FunctionSpec{1, 1});
    out.emplace("COS", FunctionSpec{1, 1});
    out.emplace("TAN", FunctionSpec{1, 1});
    out.emplace("ASIN", FunctionSpec{1, 1});
    out.emplace("ACOS", FunctionSpec{1, 1});
    out.emplace("ATAN", FunctionSpec{1, 1});
    out.emplace("VAR.S", FunctionSpec{1, 1});
    out.emplace("VAR.P", FunctionSpec{1, 1});
    out.emplace("STDEV.S", FunctionSpec{1, 1});
    out.emplace("STDEV.P", FunctionSpec{1, 1});
    out.emplace("PERCENTILE.INC", FunctionSpec{2, 2});
    out.emplace("PERCENTILE.EXC", FunctionSpec{2, 2});
    out.emplace("CORREL", FunctionSpec{2, 2});
    out.emplace("COVARIANCE.S", FunctionSpec{2, 2});
    out.emplace("COVARIANCE.P", FunctionSpec{2, 2});
    out.emplace("SLOPE", FunctionSpec{2, 2});
    out.emplace("INTERCEPT", FunctionSpec{2, 2});
    out.emplace("RSQ", FunctionSpec{2, 2});
    out.emplace("IRR", FunctionSpec{1, 1});
    out.emplace("COUNTIF", FunctionSpec{2, 2});
    out.emplace("SUMIF", FunctionSpec{2, 3});
    out.erase("SUM");
    out.emplace("SUM", FunctionSpec{1, 4});
    out.emplace("PRODUCT", FunctionSpec{4, 4});
    out.emplace("INTEGRAL", FunctionSpec{4, 4});
    out.emplace("DERIV", FunctionSpec{3, 3});
    return out;
  }();
  return kAdvancedFns;
}

const std::unordered_set<std::string>& aggregationNames() {
  static const std::unordered_set<std::string> kAgg = {
      "SUM", "AVG", "MEAN", "MIN", "MAX", "MEDIAN", "STD",
      // Added with the summary capability. QUANTILE is deliberately NOT here: it is the
      // one aggregation whose result is per-row (q may be a column), so it cannot share
      // the "reduce once, broadcast" branch.
      "COUNT", "NAN", "VAR", "SEM"};
  return kAgg;
}

int precedence(const std::string& op) {
  static const std::unordered_map<std::string, int> kPrec = {
      {"||", 1}, {"&&", 2}, {"==", 3}, {"!=", 3}, {">", 3}, {"<", 3}, {">=", 3}, {"<=", 3},
      {"+", 4}, {"-", 4}, {"*", 5}, {"/", 5}, {"%", 5}, {"^", 6}};
  auto it = kPrec.find(op);
  return it == kPrec.end() ? 0 : it->second;
}

struct Parser {
  const std::vector<Token>& tokens;
  const std::unordered_map<std::string, int>& columns;
  std::unordered_map<std::string, std::vector<int64_t>> boundScopes;
  int64_t nextBoundId = 0;
  size_t pos = 0;

  const Token& peek() const { return tokens[pos]; }
  const Token& advance() { return tokens[pos++]; }

  NodePtr parseExpression(int minPrec = 0) {
    NodePtr left = parseUnary();
    while (true) {
      const Token& t = peek();
      std::string op;
      if (t.type == Tok::Op || t.type == Tok::Compare) op = t.value;
      int prec = op.empty() ? 0 : precedence(op);
      if (op.empty() || !kBinaryOps.count(op) || prec < minPrec) break;
      advance();
      int nextMin = (op == "^") ? prec : prec + 1;
      NodePtr right = parseExpression(nextMin);
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Binary;
      n->op = op;
      n->children = {left, right};
      left = n;
    }
    return left;
  }

  NodePtr parseUnary() {
    const Token& t = peek();
    if (t.type == Tok::Op && (t.value == "-" || t.value == "+")) {
      advance();
      NodePtr operand = parseUnary();
      if (t.value == "+") return operand;
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Unary;
      n->op = "-";
      n->children = {operand};
      return n;
    }
    return parsePrimary();
  }

  NodePtr parsePrimary() {
    const Token& t = peek();
    if (t.type == Tok::String) {
      advance();
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::String;
      n->stringValue = t.value;
      return n;
    }
    if (t.type == Tok::Number) {
      advance();
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Number;
      n->number = std::stod(t.value);
      return n;
    }
    if (t.type == Tok::Ident) {
      advance();
      const std::string name = t.value;
      // A bracketed name is data: `[SUM](…)` is not a call, it is a column named SUM.
      if (!t.quoted && peek().type == Tok::LParen) {
        std::string upper = toUpper(name);
        const auto& fns = functions();
        auto fit = fns.find(upper);
        if (fit == fns.end()) {
          throw ExpressionError("Unknown function '" + name + "'", t.pos, "unknownFunction",
                                name);
        }
        advance();  // consume '('

        std::string boundName;
        if (upper == "SUM" || upper == "PRODUCT" || upper == "INTEGRAL" || upper == "DERIV") {
          size_t scan = pos;
          int depth = 0;
          size_t commaCount = 0;
          size_t variableIndex = upper == "SUM" || upper == "PRODUCT" || upper == "INTEGRAL" ? 1 : 1;
          for (; scan < tokens.size(); ++scan) {
            const Tok ty = tokens[scan].type;
            if (ty == Tok::LParen) ++depth;
            else if (ty == Tok::RParen) {
              if (depth == 0) break;
              --depth;
            } else if (ty == Tok::Comma && depth == 0) {
              ++commaCount;
              if (commaCount == static_cast<size_t>(variableIndex)) {
                ++scan;
                break;
              }
            }
          }
          if (scan < tokens.size() && tokens[scan].type == Tok::Ident) {
            boundName = toLower(tokens[scan].value);
            boundScopes[boundName].push_back(nextBoundId++);
          }
        }

        std::vector<NodePtr> args;
        if (peek().type != Tok::RParen) {
          args.push_back(parseExpression());
          while (peek().type == Tok::Comma) {
            advance();
            args.push_back(parseExpression());
          }
        }
        if (peek().type != Tok::RParen) {
          throw ExpressionError("Expected ')' after function arguments", peek().pos,
                                "expectedCloseAfterArgs");
        }
        if (!boundName.empty()) {
          auto scope = boundScopes.find(boundName);
          if (scope != boundScopes.end()) {
            scope->second.pop_back();
            if (scope->second.empty()) boundScopes.erase(scope);
          }
        }
        advance();  // consume ')'
        int got = static_cast<int>(args.size());
        // SUM's arity is discontiguous (1 = aggregate, 4 = bounded): reject the gap at
        // parse time with the token position, not at compute time with position 0.
        if (upper == "SUM" && (got == 2 || got == 3)) {
          ExpressionError err("SUM() takes either SUM(column) or SUM(expr, var, from, to), got " +
                                  std::to_string(got) + " arguments",
                              t.pos, "badArgCount", name);
          err.argMin = 1;
          err.argMax = 4;
          err.argGot = got;
          throw err;
        }
        if (got < fit->second.minArgs || got > fit->second.maxArgs) {
          std::string maxStr = fit->second.maxArgs == INT32_MAX
                                   ? "∞"
                                   : std::to_string(fit->second.maxArgs);
          std::string range = fit->second.minArgs == fit->second.maxArgs
                                  ? std::to_string(fit->second.minArgs)
                                  : std::to_string(fit->second.minArgs) + "–" + maxStr;
          ExpressionError err(name + "() expects " + range + " argument(s), got " +
                                  std::to_string(got),
                              t.pos, "badArgCount", name);
          // Carry the declared arity so the UI can say "「IF」需要 3 个参数，实际给了 2 个"
          // instead of a bare "argument count" — the range is kept as a range.
          err.argMin = fit->second.minArgs;
          err.argMax = fit->second.maxArgs;
          err.argGot = got;
          throw err;
        }
        auto n = std::make_shared<Node>();
        n->kind = NodeKind::Call;
        n->name = upper;
        n->children = std::move(args);
        return n;
      }
      const std::string lowerName = toLower(name);
      auto bound = boundScopes.find(lowerName);
      if (bound != boundScopes.end() && !bound->second.empty()) {
        auto n = std::make_shared<Node>();
        n->kind = NodeKind::Bound;
        n->boundName = lowerName;
        n->boundId = bound->second.back();
        return n;
      }
      auto cit = columns.find(lowerName);
      if (cit == columns.end()) {
        throw ExpressionError("Unknown column '" + name + "'", t.pos, "unknownColumn", name);
      }
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Column;
      n->column = cit->second;
      n->columnName = name;
      return n;
    }
    if (t.type == Tok::LParen) {
      advance();
      NodePtr expr = parseExpression();
      if (peek().type != Tok::RParen) {
        throw ExpressionError("Expected ')'", peek().pos, "expectedClose");
      }
      advance();
      return expr;
    }
    std::string shown = t.value.empty() ? tokName(t.type) : t.value;
    throw ExpressionError("Unexpected token '" + shown + "'", t.pos, "unexpectedToken", shown);
  }

  static std::string tokName(Tok ty) {
    switch (ty) {
      case Tok::Eof: return "eof";
      case Tok::RParen: return ")";
      case Tok::Comma: return ",";
      default: return "?";
    }
  }

  static inline const std::unordered_set<std::string> kBinaryOps = {
      "+", "-", "*", "/", "%", "^", ">", "<", ">=", "<=", "==", "!="};
};

NodePtr parseAst(const std::vector<Token>& tokens,
                 const std::unordered_map<std::string, int>& columns) {
  Parser p{tokens, columns, {}, 0, 0};
  NodePtr ast = p.parseExpression();
  if (p.peek().type != Tok::Eof) {
    throw ExpressionError("Unexpected token '" + p.peek().value + "' after expression",
                          p.peek().pos, "trailingToken", p.peek().value);
  }
  return ast;
}

// ── evaluator (mirrors compileAST(); arrays are full-length columns) ────

using EvalFn = std::function<std::vector<double>(const std::vector<std::vector<double>>&, size_t)>;

double sumFinite(const std::vector<double>& v) {
  double s = 0;
  for (double x : v)
    if (std::isfinite(x)) s += x;
  return s;
}

size_t countFinite(const std::vector<double>& v) {
  size_t n = 0;
  for (double x : v)
    if (std::isfinite(x)) ++n;
  return n;
}

double meanFinite(const std::vector<double>& v) {
  size_t n = countFinite(v);
  return n > 0 ? sumFinite(v) / static_cast<double>(n) : NAN;
}

constexpr uint64_t kMaxDiscreteN = 1000000;
constexpr uint64_t kMaxDiscreteMultiplications = 1024;

uint64_t exactInteger(double value, int64_t position, const char* name) {
  if (!std::isfinite(value) || value < 0.0 || std::floor(value) != value) {
    throw ExpressionError(std::string(name) + " requires non-negative integers", position,
                          "domainError", name);
  }
  if (value > static_cast<double>(kMaxDiscreteN)) {
    ExpressionError error(std::string(name) + " exceeded the discrete budget", position,
                          "budgetExceeded", name);
    error.budgetLimit = static_cast<int64_t>(kMaxDiscreteN);
    error.budgetActual = value > static_cast<double>(INT64_MAX)
                             ? INT64_MAX
                             : static_cast<int64_t>(value);
    throw error;
  }
  return static_cast<uint64_t>(value);
}

double combin(double nValue, double kValue, int64_t position) {
  const uint64_t n = exactInteger(nValue, position, "COMBIN");
  const uint64_t k = exactInteger(kValue, position, "COMBIN");
  if (k > n) throw ExpressionError("COMBIN has k greater than n", position,
                                   "domainError", "COMBIN");
  const uint64_t r = std::min(k, n - k);
  if (r > kMaxDiscreteMultiplications) {
    ExpressionError error("COMBIN exceeded the multiplication budget", position,
                          "budgetExceeded", "COMBIN");
    error.budgetLimit = static_cast<int64_t>(kMaxDiscreteMultiplications);
    error.budgetActual = static_cast<int64_t>(r);
    throw error;
  }
  long double out = 1.0;
  for (uint64_t i = 1; i <= r; ++i) {
    out *= static_cast<long double>(n - r + i);
    out /= static_cast<long double>(i);
    if (!std::isfinite(static_cast<double>(out))) {
      throw ExpressionError("COMBIN exceeded the numeric range", position,
                            "numericOverflow", "COMBIN");
    }
  }
  if (!std::isfinite(static_cast<double>(out))) {
    throw ExpressionError("COMBIN exceeded the numeric range", position,
                          "numericOverflow", "COMBIN");
  }
  return static_cast<double>(out);
}

double permut(double nValue, double kValue, int64_t position) {
  const uint64_t n = exactInteger(nValue, position, "PERMUT");
  const uint64_t k = exactInteger(kValue, position, "PERMUT");
  if (k > n) throw ExpressionError("PERMUT has k greater than n", position,
                                   "domainError", "PERMUT");
  if (k > kMaxDiscreteMultiplications) {
    ExpressionError error("PERMUT exceeded the multiplication budget", position,
                          "budgetExceeded", "PERMUT");
    error.budgetLimit = static_cast<int64_t>(kMaxDiscreteMultiplications);
    error.budgetActual = static_cast<int64_t>(k);
    throw error;
  }
  long double out = 1.0;
  for (uint64_t i = 0; i < k; ++i) {
    out *= static_cast<long double>(n - i);
    if (!std::isfinite(static_cast<double>(out))) {
      throw ExpressionError("PERMUT exceeded the numeric range", position,
                            "numericOverflow", "PERMUT");
    }
  }
  return static_cast<double>(out);
}

std::vector<double> finiteValues(const std::vector<double>& values) {
  std::vector<double> out;
  for (double value : values)
    if (std::isfinite(value)) out.push_back(value);
  return out;
}

bool pairedFinite(const std::vector<double>& xValues,
                  const std::vector<double>& yValues,
                  std::vector<double>* x,
                  std::vector<double>* y) {
  x->clear();
  y->clear();
  const size_t n = std::min(xValues.size(), yValues.size());
  for (size_t i = 0; i < n; ++i) {
    if (std::isfinite(xValues[i]) && std::isfinite(yValues[i])) {
      x->push_back(xValues[i]);
      y->push_back(yValues[i]);
    }
  }
  return !x->empty();
}

double covarianceFinite(const std::vector<double>& x,
                        const std::vector<double>& y,
                        bool sample) {
  if (x.empty() || x.size() != y.size()) return NAN;
  if (sample && x.size() < 2) return NAN;
  long double sumX = 0.0L;
  long double sumY = 0.0L;
  for (size_t i = 0; i < x.size(); ++i) {
    sumX += static_cast<long double>(x[i]);
    sumY += static_cast<long double>(y[i]);
  }
  const long double meanX = sumX / static_cast<long double>(x.size());
  const long double meanY = sumY / static_cast<long double>(y.size());
  long double product = 0.0L;
  for (size_t i = 0; i < x.size(); ++i) {
    product += (static_cast<long double>(x[i]) - meanX) *
               (static_cast<long double>(y[i]) - meanY);
  }
  const long double divisor = sample
                                ? static_cast<long double>(x.size() - 1)
                                : static_cast<long double>(x.size());
  return static_cast<double>(product / divisor);
}

double correlationFinite(const std::vector<double>& x,
                         const std::vector<double>& y) {
  if (x.empty() || x.size() != y.size()) return NAN;
  if (x.size() < 2) return NAN;
  long double sumX = 0.0L;
  long double sumY = 0.0L;
  for (size_t i = 0; i < x.size(); ++i) {
    sumX += static_cast<long double>(x[i]);
    sumY += static_cast<long double>(y[i]);
  }
  const long double meanX = sumX / static_cast<long double>(x.size());
  const long double meanY = sumY / static_cast<long double>(y.size());
  long double xx = 0.0L;
  long double yy = 0.0L;
  long double xy = 0.0L;
  for (size_t i = 0; i < x.size(); ++i) {
    const long double dx = static_cast<long double>(x[i]) - meanX;
    const long double dy = static_cast<long double>(y[i]) - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (!(xx > 0.0L) || !(yy > 0.0L)) return NAN;
  return static_cast<double>(xy / std::sqrt(static_cast<double>(xx * yy)));
}

// Bound variables live on a thread-local lexical stack instead of being substituted
// into cloned ASTs: the body compiles ONCE and reads its binder's current value at
// evaluation time. The old clone+recompile-per-iteration scheme made SUM/INTEGRAL cost
// O(rows^2 * terms) element work plus one AST rebuild per sample; nested binders keep
// distinct lexical ids, so shadowing resolves by id, not by name.
struct BoundSlot {
  int64_t id;
  double value;
};
thread_local std::vector<BoundSlot> boundStack;

struct BoundPush {
  BoundPush(int64_t id, double value) { boundStack.push_back({id, value}); }
  ~BoundPush() { boundStack.pop_back(); }
  BoundPush(const BoundPush&) = delete;
  BoundPush& operator=(const BoundPush&) = delete;
};

double boundValue(int64_t id) {
  for (auto it = boundStack.rbegin(); it != boundStack.rend(); ++it)
    if (it->id == id) return it->value;
  return NAN;  // parser scoping guarantees a binder; NaN keeps escapes visible, never silent 0
}

bool scalarMatches(const std::vector<double>& values, double* out) {
  if (values.empty()) return false;
  *out = values[0];
  if (!std::isfinite(*out)) return false;
  for (double value : values)
    if (value != *out) return false;
  return true;
}

constexpr uint64_t kMaxAdvancedEvaluations = 1000000;
thread_local uint64_t advancedEvaluations = 0;

void resetAdvancedBudget() { advancedEvaluations = 0; }

void consumeAdvancedBudget(uint64_t work, const std::string& name) {
  if (work > kMaxAdvancedEvaluations - advancedEvaluations) {
    ExpressionError error(name + " exceeded the evaluation budget", 0,
                          "budgetExceeded", name);
    error.budgetLimit = static_cast<int64_t>(kMaxAdvancedEvaluations);
    const uint64_t actual = advancedEvaluations > UINT64_MAX - work
                                ? UINT64_MAX
                                : advancedEvaluations + work;
    error.budgetActual = actual > static_cast<uint64_t>(INT64_MAX)
                             ? INT64_MAX
                             : static_cast<int64_t>(actual);
    throw error;
  }
  advancedEvaluations += work;
}

constexpr size_t kMaxIntegralNodes = 100000;
constexpr int kMaxIntegralDepth = 32;

EvalFn compileAst(const NodePtr& node) {
  switch (node->kind) {
    case NodeKind::String:
      // A string literal is data for COUNTIF/SUMIF criteria, never a value: compiling
      // one into a NaN column let `1+"abc"` silently produce NaN instead of refusing.
      throw ExpressionError("String literals are only valid as COUNTIF/SUMIF criteria", 0,
                            "domainError", "string");
    case NodeKind::Number: {
      double v = node->number;
      return [v](const std::vector<std::vector<double>>&, size_t len) {
        return std::vector<double>(len, v);
      };
    }
    case NodeKind::Column: {
      int idx = node->column;
      return [idx](const std::vector<std::vector<double>>& cols, size_t) { return cols[idx]; };
    }
    case NodeKind::Bound: {
      const int64_t id = node->boundId;
      return [id](const std::vector<std::vector<double>>&, size_t len) {
        return std::vector<double>(len, boundValue(id));
      };
    }
    case NodeKind::Unary: {
      EvalFn inner = compileAst(node->children[0]);
      return [inner](const std::vector<std::vector<double>>& cols, size_t len) {
        std::vector<double> v = inner(cols, len);
        for (auto& x : v) x = -x;
        return v;
      };
    }
    case NodeKind::Binary: {
      EvalFn l = compileAst(node->children[0]);
      EvalFn r = compileAst(node->children[1]);
      std::string op = node->op;
      return [l, r, op](const std::vector<std::vector<double>>& cols, size_t len) {
        std::vector<double> a = l(cols, len);
        std::vector<double> b = r(cols, len);
        std::vector<double> out(len);
        for (size_t i = 0; i < len; ++i) {
          double x = a[i], y = b[i];
          if (op == "+") out[i] = x + y;
          else if (op == "-") out[i] = x - y;
          else if (op == "*") out[i] = x * y;
          else if (op == "/") out[i] = x / y;
          else if (op == "%") out[i] = std::fmod(x, y);
          else if (op == "^") out[i] = jsPow(x, y);
          else if (op == ">") out[i] = x > y ? 1.0 : 0.0;
          else if (op == "<") out[i] = x < y ? 1.0 : 0.0;
          else if (op == ">=") out[i] = x >= y ? 1.0 : 0.0;
          else if (op == "<=") out[i] = x <= y ? 1.0 : 0.0;
          else if (op == "==") out[i] = x == y ? 1.0 : 0.0;
          else if (op == "!=") out[i] = x != y ? 1.0 : 0.0;
          else out[i] = NAN;
        }
        return out;
      };
    }
    case NodeKind::Call: {
      std::vector<EvalFn> argFns;
      for (const auto& a : node->children) {
        if (a->kind == NodeKind::String) {
          // COUNTIF/SUMIF read the criteria straight from the AST; every other position
          // keeps a refusing evaluator so a stray string can never become a NaN value.
          argFns.push_back([](const std::vector<std::vector<double>>&, size_t) -> std::vector<double> {
            throw ExpressionError("String literals are only valid as COUNTIF/SUMIF criteria", 0,
                                  "domainError", "string");
          });
        } else {
          argFns.push_back(compileAst(a));
        }
      }
      const std::string name = node->name;

      // Aggregation: reduce to scalar then broadcast. MIN/MAX multi-arg fall through to
      // element-wise (same rule as the TS side).
      bool isMultiMinMax = (name == "MIN" || name == "MAX") && argFns.size() > 1;

      if (envAdvancedMathEnabled() &&
          (name == "SUM" || name == "PRODUCT" || name == "INTEGRAL" || name == "DERIV")) {
        const bool discrete = name == "SUM" || name == "PRODUCT";
        const size_t expected = discrete ? 4 : (name == "INTEGRAL" ? 4 : 3);
        if (name == "SUM" && node->children.size() == 1) {
          // Preserve the existing aggregate SUM(c) path below.
        } else {
          if (node->children.size() != expected) {
            ExpressionError err(name + "() has the wrong advanced argument count", 0,
                                "badArgCount", name);
            err.argMin = static_cast<int64_t>(expected);
            err.argMax = static_cast<int64_t>(expected);
            err.argGot = static_cast<int64_t>(node->children.size());
            throw err;
          }
          if (!node->children[1] || node->children[1]->kind != NodeKind::Bound) {
            throw ExpressionError(name + " requires a bound variable", 0,
                                  "domainError", name);
          }
          const int64_t bound = node->children[1]->boundId;

          if (name == "SUM" || name == "PRODUCT") {
            return [bound, argFns, name](const std::vector<std::vector<double>>& cols, size_t len) {
              double startValue = NAN;
              double endValue = NAN;
              if (!scalarMatches(argFns[2](cols, len), &startValue) ||
                  !scalarMatches(argFns[3](cols, len), &endValue)) {
                throw ExpressionError(name + " bounds must be finite integers", 0,
                                      "domainError", name);
              }
              if (std::floor(startValue) != startValue || std::floor(endValue) != endValue) {
                throw ExpressionError(name + " bounds must be integers", 0,
                                      "domainError", name);
              }
              if (endValue < startValue) {
                throw ExpressionError(name + " requires start <= end", 0,
                                      "domainError", name);
              }
              // Negative bounds are legal mathematics (SUM(i, i, -3, 3) = 0); the budget
              // caps the term count and the magnitude so the int64 casts stay safe.
              if (startValue < -1000000.0 || endValue > 1000000.0) {
                ExpressionError error(name + " exceeded the discrete budget", 0,
                                      "budgetExceeded", name);
                error.budgetLimit = 1000000;
                error.budgetActual = endValue > static_cast<double>(INT64_MAX)
                                         ? INT64_MAX
                                         : static_cast<int64_t>(endValue);
                throw error;
              }
              const int64_t start = static_cast<int64_t>(startValue);
              const int64_t end = static_cast<int64_t>(endValue);
              const uint64_t itemCount = static_cast<uint64_t>(end - start + 1);
              if (itemCount > 1000000) {
                ExpressionError error(name + " exceeded the discrete budget", 0,
                                      "budgetExceeded", name);
                error.budgetLimit = 1000000;
                error.budgetActual = static_cast<int64_t>(itemCount);
                throw error;
              }
              const uint64_t rows = static_cast<uint64_t>(len);
              if (rows > 0 && itemCount > UINT64_MAX / rows) {
                ExpressionError error(name + " exceeded the evaluation budget", 0,
                                      "budgetExceeded", name);
                error.budgetLimit = static_cast<int64_t>(kMaxAdvancedEvaluations);
                error.budgetActual = INT64_MAX;
                throw error;
              }
              consumeAdvancedBudget(itemCount * rows, name);

              // One body evaluation per iteration serves every row: the binder value is
              // pushed on the lexical stack, so no AST clone or recompile happens here.
              const EvalFn body = argFns[0];
              std::vector<long double> acc(len, name == "SUM" ? 0.0L : 1.0L);
              for (int64_t value = start; value <= end; ++value) {
                const BoundPush push(bound, static_cast<double>(value));
                const std::vector<double> term = body(cols, len);
                for (size_t row = 0; row < len; ++row) {
                  const double t = term[row];
                  if (!std::isfinite(t)) {
                    throw ExpressionError(name + " produced a non-finite intermediate", 0,
                                          "domainError", name);
                  }
                  if (name == "SUM") acc[row] += static_cast<long double>(t);
                  else acc[row] *= static_cast<long double>(t);
                  if (!std::isfinite(static_cast<double>(acc[row]))) {
                    throw ExpressionError(name + " exceeded the numeric range", 0,
                                          "numericOverflow", name);
                  }
                }
              }
              std::vector<double> out(len);
              for (size_t row = 0; row < len; ++row) out[row] = static_cast<double>(acc[row]);
              return out;
            };
          }

          if (name == "INTEGRAL") {
            return [bound, argFns](const std::vector<std::vector<double>>& cols, size_t len) {
              double lower = NAN;
              double upper = NAN;
              if (!scalarMatches(argFns[2](cols, len), &lower) ||
                  !scalarMatches(argFns[3](cols, len), &upper)) {
                throw ExpressionError("INTEGRAL bounds must be finite", 0,
                                      "domainError", "INTEGRAL");
              }
              if (upper < lower) {
                throw ExpressionError("INTEGRAL requires lower <= upper", 0,
                                      "domainError", "INTEGRAL");
              }
              // Adaptive Simpson with an absolute+relative error target. The previous
              // fixed 10000-panel rule had no error control at all: a narrow Gaussian
              // (EXP(-1e8*x*x) over [-1,1]) came back 19% wrong while looking converged.
              // Endpoints are sampled once per row; subdivision stops when the Richardson
              // delta meets 15*eps, and refuses (budgetExceeded) when the node or depth
              // budget runs out instead of publishing an unverified number.
              const uint64_t rows = static_cast<uint64_t>(len);
              const EvalFn body = argFns[0];
              uint64_t nodesUsed = 0;
              std::vector<double> out(len, 0.0);
              if (upper == lower) return out;
              for (size_t row = 0; row < len; ++row) {
                auto sample = [&](double x) {
                  if (nodesUsed >= kMaxIntegralNodes) {
                    ExpressionError error("INTEGRAL exceeded its node budget", 0,
                                          "budgetExceeded", "INTEGRAL");
                    error.budgetLimit = static_cast<int64_t>(kMaxIntegralNodes);
                    error.budgetActual = static_cast<int64_t>(nodesUsed + 1);
                    throw error;
                  }
                  ++nodesUsed;
                  consumeAdvancedBudget(rows, "INTEGRAL");
                  const BoundPush push(bound, x);
                  const std::vector<double> y = body(cols, len);
                  if (!std::isfinite(y[row])) {
                    throw ExpressionError("INTEGRAL encountered a non-finite value", 0,
                                          "domainError", "INTEGRAL");
                  }
                  return y[row];
                };
                const double fa = sample(lower);
                const double fb = sample(upper);
                const double mid = lower + (upper - lower) / 2.0;
                const double fm = sample(mid);
                const double s0 = (upper - lower) / 6.0 * (fa + 4.0 * fm + fb);
                const double tol = 1e-10 * std::max(1.0, std::fabs(s0));
                auto adapt = [&](auto&& self, double a, double b, double fA, double fB,
                                 double fM, double s, double eps, int depth) -> double {
                  const double m = a + (b - a) / 2.0;
                  const double flm = sample(a + (m - a) / 2.0);
                  const double frm = sample(m + (b - m) / 2.0);
                  const double sl = (m - a) / 6.0 * (fA + 4.0 * flm + fM);
                  const double sr = (b - m) / 6.0 * (fM + 4.0 * frm + fB);
                  const double delta = sl + sr - s;
                  if (std::fabs(delta) <= 15.0 * eps) return sl + sr + delta / 15.0;
                  if (depth <= 0) {
                    ExpressionError error("INTEGRAL exceeded its subdivision budget", 0,
                                          "budgetExceeded", "INTEGRAL");
                    error.budgetLimit = kMaxIntegralDepth;
                    error.budgetActual = kMaxIntegralDepth;
                    throw error;
                  }
                  return self(self, a, m, fA, fM, flm, sl, eps / 2.0, depth - 1) +
                         self(self, m, b, fM, fB, frm, sr, eps / 2.0, depth - 1);
                };
                const double value = adapt(adapt, lower, upper, fa, fb, fm, s0, tol,
                                           kMaxIntegralDepth);
                if (!std::isfinite(value)) {
                  throw ExpressionError("INTEGRAL exceeded the numeric range", 0,
                                        "numericOverflow", "INTEGRAL");
                }
                out[row] = value;
              }
              return out;
            };
          }

          if (name == "DERIV") {
            return [bound, argFns](const std::vector<std::vector<double>>& cols, size_t len) {
              double point = NAN;
              if (!scalarMatches(argFns[2](cols, len), &point)) {
                throw ExpressionError("DERIV point must be finite", 0,
                                      "domainError", "DERIV");
              }
              const uint64_t rows = static_cast<uint64_t>(len);
              // Worst case per row: 2 initial + 2*12 cascade + 3 kink probe = 29 samples.
              constexpr uint64_t kMaxDerivLevels = 12;
              constexpr uint64_t kMaxDerivSamples = 2 + 2 * kMaxDerivLevels + 3;
              if (rows > kMaxAdvancedEvaluations / kMaxDerivSamples) {
                ExpressionError error("DERIV exceeded the evaluation budget", 0,
                                      "budgetExceeded", "DERIV");
                error.budgetLimit = static_cast<int64_t>(kMaxAdvancedEvaluations);
                error.budgetActual = static_cast<int64_t>(rows * kMaxDerivSamples);
                throw error;
              }
              const EvalFn body = argFns[0];
              const double scale = std::max(1.0, std::fabs(point));
              std::vector<double> out(len);
              for (size_t row = 0; row < len; ++row) {
                uint64_t samples = 0;
                auto sample = [&](double x) {
                  ++samples;
                  const BoundPush push(bound, x);
                  const std::vector<double> y = body(cols, len);
                  if (!std::isfinite(y[row])) {
                    throw ExpressionError("DERIV encountered a non-finite value", 0,
                                          "domainError", "DERIV");
                  }
                  return y[row];
                };
                // Richardson cascade over halved central differences: the single fixed
                // h=1e-5 step had no error estimate and silently returned 0 at kinks.
                double h = 1e-2 * scale;
                double fPlus = sample(point + h);
                double fMinus = sample(point - h);
                double central = (fPlus - fMinus) / (2.0 * h);
                double estimate = central;
                bool converged = false;
                for (uint64_t level = 0; level < kMaxDerivLevels; ++level) {
                  h /= 2.0;
                  const double nextPlus = sample(point + h);
                  const double nextMinus = sample(point - h);
                  const double nextCentral = (nextPlus - nextMinus) / (2.0 * h);
                  const double richardson = (4.0 * nextCentral - central) / 3.0;
                  if (std::fabs(richardson - estimate) <= 1e-9 * std::max(1.0, std::fabs(richardson))) {
                    estimate = richardson;
                    converged = true;
                    fPlus = nextPlus;
                    fMinus = nextMinus;
                    break;
                  }
                  estimate = richardson;
                  central = nextCentral;
                  fPlus = nextPlus;
                  fMinus = nextMinus;
                }
                if (!converged) {
                  throw ExpressionError("DERIV did not stabilise under refinement", 0,
                                        "convergenceError", "DERIV");
                }
                // Kink gate: for a smooth f the one-sided gap d(h) = f'_+(h) - f'_-(h)
                // halves with h (d ~ h*f''), while at a corner it stays O(1). Comparing
                // d(h) with d(h/2) separates the two without assuming a bound on f''.
                const double f0 = sample(point);
                const double fPlus2 = sample(point + h / 2.0);
                const double fMinus2 = sample(point - h / 2.0);
                const double d1 = (fPlus - f0) / h - (f0 - fMinus) / h;
                const double d2 = (fPlus2 - f0) / (h / 2.0) - (f0 - fMinus2) / (h / 2.0);
                if (std::fabs(d2 - d1 / 2.0) >
                    0.25 * std::fabs(d1) + 1e-9 * std::max(1.0, std::fabs(estimate))) {
                  throw ExpressionError("DERIV point is a kink: left and right derivatives disagree",
                                        0, "notDifferentiable", "DERIV");
                }
                consumeAdvancedBudget(rows * samples, "DERIV");
                if (!std::isfinite(estimate)) {
                  throw ExpressionError("DERIV exceeded the numeric range", 0,
                                        "numericOverflow", "DERIV");
                }
                out[row] = estimate;
              }
              return out;
            };
          }
        }
      }
      if (envAdvancedMathEnabled() &&
          (name == "VAR.S" || name == "VAR.P" || name == "STDEV.S" || name == "STDEV.P")) {
        EvalFn inner = argFns[0];
        const bool sample = name == "VAR.S" || name == "STDEV.S";
        const bool standardDeviation = name == "STDEV.S" || name == "STDEV.P";
        return [inner, sample, standardDeviation](const std::vector<std::vector<double>>& cols, size_t len) {
          const std::vector<double> finite = finiteValues(inner(cols, len));
          if (finite.empty() || (sample && finite.size() < 2))
            return std::vector<double>(len, NAN);
          if (finite.size() == 1) return std::vector<double>(len, 0.0);
          long double sum = 0.0L;
          for (double value : finite) sum += static_cast<long double>(value);
          const long double mean = sum / static_cast<long double>(finite.size());
          long double ss = 0.0L;
          for (double value : finite) {
            const long double delta = static_cast<long double>(value) - mean;
            ss += delta * delta;
          }
          const long double divisor = sample
                                        ? static_cast<long double>(finite.size() - 1)
                                        : static_cast<long double>(finite.size());
          double scalar = static_cast<double>(ss / divisor);
          if (standardDeviation) scalar = std::sqrt(scalar);
          return std::vector<double>(len, scalar);
        };
      }

      if (envAdvancedMathEnabled() &&
          (name == "PERCENTILE.INC" || name == "PERCENTILE.EXC")) {
        EvalFn valuesFn = argFns[0];
        EvalFn kFn = argFns[1];
        const bool exclusive = name == "PERCENTILE.EXC";
        return [valuesFn, kFn, exclusive, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> sorted = finiteValues(valuesFn(cols, len));
          double k = NAN;
          if (!scalarMatches(kFn(cols, len), &k)) {
            throw ExpressionError(name + " requires a finite scalar percentile", 0,
                                  "domainError", name);
          }
          if (exclusive ? (k <= 0.0 || k >= 1.0) : (k < 0.0 || k > 1.0)) {
            throw ExpressionError(name + " percentile is outside its accepted domain", 0,
                                  "domainError", name);
          }
          if (sorted.empty()) return std::vector<double>(len, NAN);
          std::sort(sorted.begin(), sorted.end());
          double scalar = NAN;
          if (!exclusive) {
            const double position = static_cast<double>(sorted.size() - 1) * k;
            const size_t lower = static_cast<size_t>(std::floor(position));
            const size_t upper = static_cast<size_t>(std::ceil(position));
            scalar = lower == upper
                         ? sorted[lower]
                         : sorted[lower] + (sorted[upper] - sorted[lower]) *
                                               (position - static_cast<double>(lower));
          } else {
            const double rank = k * static_cast<double>(sorted.size() + 1);
            if (rank < 1.0 || rank > static_cast<double>(sorted.size())) {
              throw ExpressionError(name + " percentile is outside the exclusive ranks", 0,
                                    "domainError", name);
            }
            if (rank >= 1.0 && rank <= static_cast<double>(sorted.size())) {
              const size_t lower = static_cast<size_t>(std::floor(rank)) - 1;
              const size_t upper = std::min(lower + 1, sorted.size() - 1);
              const double fraction = rank - std::floor(rank);
              scalar = lower == upper
                           ? sorted[lower]
                           : sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
            }
          }
          return std::vector<double>(len, scalar);
        };
      }

      if (envAdvancedMathEnabled() &&
          (name == "CORREL" || name == "COVARIANCE.S" || name == "COVARIANCE.P" ||
           name == "SLOPE" || name == "INTERCEPT" || name == "RSQ")) {
        EvalFn xFn = argFns[1];
        EvalFn yFn = argFns[0];
        return [xFn, yFn, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> x;
          std::vector<double> y;
          pairedFinite(xFn(cols, len), yFn(cols, len), &x, &y);
          double scalar = NAN;
          if (name == "CORREL") {
            scalar = correlationFinite(x, y);
          } else if (name == "COVARIANCE.S") {
            scalar = covarianceFinite(x, y, true);
          } else if (name == "COVARIANCE.P") {
            scalar = covarianceFinite(x, y, false);
          } else if (x.size() >= 2) {
            long double sumX = 0.0L;
            long double sumY = 0.0L;
            for (size_t i = 0; i < x.size(); ++i) {
              sumX += static_cast<long double>(x[i]);
              sumY += static_cast<long double>(y[i]);
            }
            const long double meanX = sumX / static_cast<long double>(x.size());
            const long double meanY = sumY / static_cast<long double>(y.size());
            long double xx = 0.0L;
            long double xy = 0.0L;
            long double yy = 0.0L;
            for (size_t i = 0; i < x.size(); ++i) {
              const long double dx = static_cast<long double>(x[i]) - meanX;
              const long double dy = static_cast<long double>(y[i]) - meanY;
              xx += dx * dx;
              xy += dx * dy;
              yy += dy * dy;
            }
            if (xx > 0.0L) {
              const double slope = static_cast<double>(xy / xx);
              const double intercept = static_cast<double>(meanY - static_cast<long double>(slope) * meanX);
              if (name == "SLOPE") scalar = slope;
              else if (name == "INTERCEPT") scalar = intercept;
              // RSQ is the squared correlation (frozen contract): a constant y has no
              // correlation, so it must stay NaN exactly like CORREL — the previous
              // `xy == 0 => 1.0` branch invented a perfect fit for a horizontal cloud.
              else if (yy > 0.0L) scalar = static_cast<double>((xy * xy) / (xx * yy));
            }
          }
          return std::vector<double>(len, scalar);
        };
      }

      if (envAdvancedMathEnabled() && (name == "COUNTIF" || name == "SUMIF")) {
        if (name == "SUMIF" && argFns.size() == 2) {
          // SUMIF(range, criteria) uses range as the sum_range.
        }
        EvalFn rangeFn = argFns[0];
        const NodePtr criteriaNode = node->children[1];
        EvalFn sumFn = argFns.size() >= 3 ? argFns[2] : rangeFn;
        return [rangeFn, sumFn, criteriaNode, name](const std::vector<std::vector<double>>& cols, size_t len) {
          if (!criteriaNode ||
              (criteriaNode->kind != NodeKind::String && criteriaNode->kind != NodeKind::Number)) {
            throw ExpressionError(name + " requires a numeric or string criteria", 0,
                                  "domainError", name);
          }
          // A numeric literal criteria keeps its full double precision: round-tripping it
          // through std::to_string (%f, six decimals) silently rewrote 0.123456789 to
          // 0.123457 and 1e-9 to 0, so equality tests compared against the wrong number.
          const bool directNumber = criteriaNode->kind == NodeKind::Number;
          std::string op = "=";
          double numericLiteral = 0.0;
          if (directNumber) {
            numericLiteral = criteriaNode->number;
            if (!std::isfinite(numericLiteral)) {
              throw ExpressionError(name + " criteria must be numeric in v1", 0,
                                    "domainError", name);
            }
          } else {
            std::string literal = trimName(criteriaNode->stringValue);
            for (const std::string& prefix : {">=", "<=", "<>", "!=", "=", "<", ">"}) {
              if (literal.rfind(prefix, 0) == 0) {
                op = prefix;
                literal = literal.substr(prefix.size());
                break;
              }
            }
            if (literal.find('*') != std::string::npos || literal.find('?') != std::string::npos) {
              throw ExpressionError(name + " wildcard criteria are not implemented", 0,
                                    "unsupportedCriteria", name);
            }
            char* end = nullptr;
            numericLiteral = std::strtod(literal.c_str(), &end);
            const bool isNumericLiteral = end != literal.c_str() && end != nullptr && *end == '\0';
            if (!isNumericLiteral || !std::isfinite(numericLiteral)) {
              throw ExpressionError(name + " criteria must be numeric in v1", 0,
                                    "domainError", name);
            }
          }

          const std::vector<double> rangeValues = rangeFn(cols, len);
          const std::vector<double> sumValues = sumFn(cols, len);
          if (rangeValues.size() != sumValues.size()) {
            throw ExpressionError(name + " requires matching range sizes", 0,
                                  "shapeMismatch", name);
          }
          double scalar = 0.0;
          for (size_t i = 0; i < rangeValues.size(); ++i) {
            bool matches = false;
            const double value = rangeValues[i];
            if (std::isfinite(value)) {
              if (op == "=") matches = value == numericLiteral;
              else if (op == "!=" || op == "<>") matches = value != numericLiteral;
              else if (op == "<") matches = value < numericLiteral;
              else if (op == "<=") matches = value <= numericLiteral;
              else if (op == ">") matches = value > numericLiteral;
              else if (op == ">=") matches = value >= numericLiteral;
            }
            if (matches) {
              if (name == "COUNTIF") ++scalar;
              else if (std::isfinite(sumValues[i])) scalar += sumValues[i];
            }
          }
          return std::vector<double>(len, scalar);
        };
      }

      if (envAdvancedMathEnabled() && name == "IRR") {
        EvalFn inner = argFns[0];
        return [inner](const std::vector<std::vector<double>>& cols, size_t len) {
          const std::vector<double> values = inner(cols, len);
          if (values.empty()) {
            throw ExpressionError("IRR requires cash flows", 0, "domainError", "IRR");
          }
          bool hasPositive = false;
          bool hasNegative = false;
          for (double value : values) {
            if (!std::isfinite(value)) {
              throw ExpressionError("IRR requires finite cash flows", 0,
                                    "domainError", "IRR");
            }
            if (value > 0.0) hasPositive = true;
            if (value < 0.0) hasNegative = true;
          }
          if (!hasPositive || !hasNegative) {
            throw ExpressionError("IRR requires positive and negative cash flows", 0,
                                  "domainError", "IRR");
          }
          auto npv = [&values](double rate) {
            long double out = 0.0L;
            long double factor = 1.0L;
            for (double cf : values) {
              if (std::isfinite(cf)) out += static_cast<long double>(cf) / factor;
              factor *= static_cast<long double>(1.0 + rate);
            }
            return static_cast<double>(out);
          };
          double low = -0.99;
          double high = 100.0;
          double lowValue = npv(low);
          double highValue = npv(high);
          if (!std::isfinite(lowValue) || !std::isfinite(highValue)) {
            throw ExpressionError("IRR encountered a non-finite residual", 0,
                                  "convergenceError", "IRR");
          }
          if ((lowValue > 0.0) == (highValue > 0.0)) {
            throw ExpressionError("IRR has no bracketed root in its frozen search interval", 0,
                                  "convergenceError", "IRR");
          }
          double scalar = NAN;
          bool converged = false;
          for (int i = 0; i < 128; ++i) {
              const double mid = low + (high - low) / 2.0;
              const double midValue = npv(mid);
              if (!std::isfinite(midValue)) {
                throw ExpressionError("IRR encountered a non-finite residual", 0,
                                      "convergenceError", "IRR");
              }
              if (std::fabs(midValue) < 1e-12) {
                low = high = mid;
                converged = true;
                break;
              }
              if ((lowValue > 0.0) == (midValue > 0.0)) {
                low = mid;
                lowValue = midValue;
              } else {
                high = mid;
                highValue = midValue;
              }
            }
          const double candidate = low + (high - low) / 2.0;
          if (std::fabs(npv(candidate)) <= 1e-10) {
            scalar = candidate;
            converged = true;
          }
          if (!converged) {
            ExpressionError error("IRR exceeded its iteration budget", 0,
                                  "budgetExceeded", "IRR");
            error.budgetLimit = 128;
            error.budgetActual = 128;
            throw error;
          }
          return std::vector<double>(len, scalar);
        };
      }

      if (aggregationNames().count(name) && !isMultiMinMax) {
        EvalFn inner = argFns[0];
        return [inner, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> v = inner(cols, len);
          double scalar = NAN;
          if (name == "SUM") scalar = sumFinite(v);
          else if (name == "AVG" || name == "MEAN") scalar = meanFinite(v);
          else if (name == "MIN") {
            double m = INFINITY;
            for (double x : v)
              if (std::isfinite(x) && x < m) m = x;
            scalar = m == INFINITY ? NAN : m;
          } else if (name == "MAX") {
            double m = -INFINITY;
            for (double x : v)
              if (std::isfinite(x) && x > m) m = x;
            scalar = m == -INFINITY ? NAN : m;
          } else if (name == "MEDIAN") {
            std::vector<double> sorted;
            for (double x : v)
              if (std::isfinite(x)) sorted.push_back(x);
            std::sort(sorted.begin(), sorted.end());
            size_t mid = sorted.size() / 2;
            if (sorted.empty()) scalar = NAN;
            else if (sorted.size() % 2) scalar = sorted[mid];
            else scalar = (sorted[mid - 1] + sorted[mid]) / 2.0;
          } else if (name == "STD") {
            size_t n = countFinite(v);
            double mean = n > 0 ? sumFinite(v) / static_cast<double>(n) : NAN;
            double ss = 0;
            for (double x : v)
              if (std::isfinite(x)) ss += (x - mean) * (x - mean);
            // n = 0 has no spread to report → NaN (undefined), never 0. Only n = 1 is
            // "0 by convention" (one sample cannot show spread). The statistical table
            // and the frozen reference (stats.ts variance(n=0) = NaN ⇒ stdDev = NaN)
            // both say so; the previous "0.0 for n ≤ 1" conflated the two cases.
            scalar = n > 1 ? std::sqrt(ss / static_cast<double>(n - 1))
                           : (n == 1 ? 0.0 : NAN);
          } else if (name == "COUNT") {
            // Finite values only: NaN and ±Infinity are NOT observations (the same rule
            // every other aggregation here uses, and the one stats.ts finite() encodes).
            scalar = static_cast<double>(countFinite(v));
          } else if (name == "NAN") {
            // Deliberately narrower than "non-finite": this counts NaN ONLY. ±Infinity is
            // a different defect (1/0 vs 0/0) and is not silently folded into this number.
            size_t n = 0;
            for (double x : v)
              if (std::isnan(x)) ++n;
            scalar = static_cast<double>(n);
          } else if (name == "VAR") {
            // Sample variance, the primitive stats.ts variance() uses (ddof = n-1).
            // n = 1 has no spread to estimate → 0 (not NaN); n = 0 → NaN (undefined).
            size_t n = countFinite(v);
            if (n == 0) {
              scalar = NAN;
            } else if (n == 1) {
              scalar = 0.0;
            } else {
              double mean = sumFinite(v) / static_cast<double>(n);
              double ss = 0;
              for (double x : v)
                if (std::isfinite(x)) ss += (x - mean) * (x - mean);
              scalar = ss / static_cast<double>(n - 1);
            }
          } else if (name == "SEM") {
            // Standard error of the mean, sd/sqrt(n). Fewer than two observations cannot
            // estimate it at all → 0 (stats.ts standardError(), same choice).
            size_t n = countFinite(v);
            if (n < 2) {
              scalar = 0.0;
            } else {
              double mean = sumFinite(v) / static_cast<double>(n);
              double ss = 0;
              for (double x : v)
                if (std::isfinite(x)) ss += (x - mean) * (x - mean);
              scalar = std::sqrt(ss / static_cast<double>(n - 1)) /
                       std::sqrt(static_cast<double>(n));
            }
          }
          return std::vector<double>(len, scalar);
        };
      }

      // QUANTILE(col, q) — R-7 (linear interpolation between closest ranks), the exact
      // definition the frozen reference stats.ts:quantile() implements. It is NOT a
      // scalar-broadcast aggregation: q may be a column, so the result is evaluated per
      // row. Out-of-range q clamps to [0,1] like the reference; a non-finite q yields NaN
      // instead of indexing junk (the TS reference would evaluate data[NaN] → undefined,
      // so its mirror must guard explicitly too — this case is in the xlayer fixtures).
      if (name == "QUANTILE") {
        EvalFn valuesFn = argFns[0];
        EvalFn quantileFn = argFns[1];
        return [valuesFn, quantileFn](const std::vector<std::vector<double>>& cols, size_t len) {
          const std::vector<double> values = valuesFn(cols, len);
          std::vector<double> sorted;
          for (double x : values)
            if (std::isfinite(x)) sorted.push_back(x);
          std::sort(sorted.begin(), sorted.end());
          const std::vector<double> quantiles = quantileFn(cols, len);
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            double q = quantiles[i];
            if (!std::isfinite(q) || sorted.empty()) {
              out[i] = NAN;
              continue;
            }
            if (q < 0.0) q = 0.0;
            if (q > 1.0) q = 1.0;
            const double position = static_cast<double>(sorted.size() - 1) * q;
            const size_t lower = static_cast<size_t>(std::floor(position));
            const size_t upper = static_cast<size_t>(std::ceil(position));
            if (lower == upper) {
              out[i] = sorted[lower];
              continue;
            }
            const double fraction = position - static_cast<double>(lower);
            out[i] = sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
          }
          return out;
        };
      }

      if (name == "COMBIN" || name == "PERMUT") {
        if (!envAdvancedMathEnabled()) {
          throw ExpressionError("Unknown function '" + name + "'", node->children.empty() ? 0 : 0,
                                "unknownFunction", name);
        }
        EvalFn nFn = argFns[0];
        EvalFn kFn = argFns[1];
        return [nFn, kFn, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> nValues = nFn(cols, len);
          std::vector<double> kValues = kFn(cols, len);
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            out[i] = name == "COMBIN"
                         ? combin(nValues[i], kValues[i], 0)
                         : permut(nValues[i], kValues[i], 0);
          }
          return out;
        };
      }

      if (isMultiMinMax) {
        bool wantMin = name == "MIN";
        return [argFns, wantMin](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<std::vector<double>> arrays;
          for (const auto& fn : argFns) arrays.push_back(fn(cols, len));
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            double result = arrays[0][i];
            for (size_t a = 1; a < arrays.size(); ++a) {
              // jsMin/jsMax carry the Math.min/Math.max semantics the TS reference relies
              // on (NaN wins, ±0 ordered) — std::min/max returned the non-NaN operand
              // whenever the NaN came second, so MIN(EXP(8.96), LN(B)) yielded 7785.36
              // instead of NaN. Found by the differential fuzz gate.
              result = wantMin ? jsMin(result, arrays[a][i]) : jsMax(result, arrays[a][i]);
            }
            out[i] = result;
          }
          return out;
        };
      }

      if (name == "ABS" || name == "SQRT" || name == "LOG" || name == "LN" ||
          name == "LOG10" || name == "EXP" || name == "POW" || name == "FLOOR" ||
          name == "CEIL" || name == "SIGN" || name == "ROUND" ||
          name == "SIN" || name == "COS" || name == "TAN" ||
          name == "ASIN" || name == "ACOS" || name == "ATAN") {
        return [argFns, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<std::vector<double>> arrays;
          for (const auto& fn : argFns) arrays.push_back(fn(cols, len));
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            double a0 = arrays[0][i];
            double a1 = arrays.size() > 1 ? arrays[1][i] : 0.0;
            if (name == "ABS") out[i] = std::fabs(a0);
            else if (name == "SQRT") out[i] = std::sqrt(a0);
            else if (name == "LOG" || name == "LN") out[i] = std::log(a0);
            else if (name == "LOG10") out[i] = std::log10(a0);
            else if (name == "EXP") out[i] = std::exp(a0);
            else if (name == "SIN") out[i] = std::sin(a0);
            else if (name == "COS") out[i] = std::cos(a0);
            else if (name == "TAN") out[i] = std::tan(a0);
            else if (name == "ASIN") out[i] = std::asin(a0);
            else if (name == "ACOS") out[i] = std::acos(a0);
            else if (name == "ATAN") out[i] = std::atan(a0);
            else if (name == "POW") out[i] = jsPow(a0, a1);
            else if (name == "FLOOR") out[i] = std::floor(a0);
            else if (name == "CEIL") out[i] = std::ceil(a0);
            else if (name == "SIGN") {
              // Must match Math.sign exactly (the TS side is the reference): NaN → NaN,
              // ±0 → ±0, otherwise ±1. The previous `(a0 > 0) - (a0 < 0)` returned 0 for
              // NaN (both comparisons false), silently breaking NaN propagation — found by
              // the differential fuzz (diff_fuzz gate), not by the hand-written fixtures.
              if (std::isnan(a0) || a0 == 0.0) out[i] = a0;
              else out[i] = (a0 > 0) - (a0 < 0);
            }
            else if (name == "ROUND") {
              // Faithful port of the TS reference `Math.round(v * f) / f` with `f = 10 ** d`:
              // the exponent is used as-is (the previous static_cast<int> truncated
              // fractional digits — ROUND(6.66, 6.62) diverged), and the rounding must be
              // Math.round, not std::round (see jsRound).
              const double f = jsPow(10.0, a1);
              out[i] = jsRound(a0 * f) / f;
            }
          }
          return out;
        };
      }

      if (name == "MOV") {
        EvalFn dataFn = argFns[0];
        EvalFn windowFn = argFns[1];
        return [dataFn, windowFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> data = dataFn(cols, len);
          // Faithful port of the TS reference, which stays in doubles end to end:
          // `const w = Math.round(x); if (w <= 1) return data; const half = Math.floor(w/2);`
          // with `lo = Math.max(0, j-half)` and `hi = Math.min(len, j+half+1)`.
          // Using llround() here was undefined behaviour for a non-finite window
          // (llround(NaN/±Inf) is unspecified; on x86 it returned LLONG_MIN, so `w <= 1`
          // held and the smoothing silently became a no-op while the TS side averaged the
          // whole series). A NaN window must also yield NaN cells, exactly like the TS side.
          const double w = jsRound(windowFn(cols, len)[0]);
          if (w <= 1) return data;  // NaN compares false and falls through, as in the TS side
          const double half = std::floor(w / 2);
          std::vector<double> out(len);
          for (size_t j = 0; j < len; ++j) {
            const double jd = static_cast<double>(j);
            const double lo = jsMax(0.0, jd - half);
            const double hi = jsMin(static_cast<double>(len), jd + half + 1);
            double sum = 0;
            for (double k = lo; k < hi; k += 1.0) sum += data[static_cast<size_t>(k)];
            out[j] = sum / (hi - lo);  // NaN window → NaN/(NaN) → NaN, matching the TS side
          }
          return out;
        };
      }

      if (name == "EMA") {
        EvalFn dataFn = argFns[0];
        EvalFn alphaFn = argFns[1];
        return [dataFn, alphaFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> data = dataFn(cols, len);
          double alpha = alphaFn(cols, len)[0];
          std::vector<double> out(len);
          if (len == 0) return out;
          out[0] = data[0];
          for (size_t i = 1; i < len; ++i) out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
          return out;
        };
      }

      if (name == "IF") {
        EvalFn condFn = argFns[0], trueFn = argFns[1], falseFn = argFns[2];
        return [condFn, trueFn, falseFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> cond = condFn(cols, len);
          std::vector<double> tv = trueFn(cols, len);
          std::vector<double> fv = falseFn(cols, len);
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) out[i] = cond[i] != 0.0 ? tv[i] : fv[i];
          return out;
        };
      }

      return [](const std::vector<std::vector<double>>&, size_t) { return std::vector<double>{}; };
    }
  }
  return nullptr;
}

// Every spelling a column answers to, in preference order (first = its display label).
//
// The display label of an annotated column is "Pos.1 时间_秒", so before this a table whose
// columns had headers was addressable by NO name at all: the bare annotation did not
// tokenise (`时间_秒` was "Unexpected character"), and `Pos.1` missed because the position
// name had been concatenated with the annotation into one key. The card advertises both
// spellings, so both have to resolve.
std::vector<std::string> keysForColumn(const std::string& label) {
  const std::string lower = toLower(label);
  std::vector<std::string> keys{lower};
  const size_t space = lower.find(' ');
  if (lower.rfind("pos.", 0) == 0) {
    const std::string posName = space == std::string::npos ? lower : lower.substr(0, space);
    keys.push_back(posName);  // "pos.1" — the name the input zone prints
    if (posName.size() > 4) keys.push_back(posName.substr(4));  // its number: "1"
    if (space != std::string::npos && space + 1 < lower.size())
      keys.push_back(lower.substr(space + 1));  // bare annotation
  } else if (space != std::string::npos && space + 1 < lower.size()) {
    keys.push_back(lower.substr(space + 1));
  }
  return keys;
}

std::unordered_map<std::string, int> buildColumnMap(const std::vector<std::string>& names,
                                                   const std::vector<AliasRange>& aliases = {}) {
  std::unordered_map<std::string, int> map;
  std::vector<std::vector<std::string>> keysByColumn(names.size());
  for (size_t i = 0; i < names.size(); ++i) {
    keysByColumn[i] = keysForColumn(names[i]);
    // The full label keeps last-wins (duplicate labels resolve to the last one, as before);
    // every alias is additive and first-wins, so an earlier column is never shadowed.
    map[toLower(names[i])] = static_cast<int>(i);
    for (size_t k = 1; k < keysByColumn[i].size(); ++k) {
      map.emplace(keysByColumn[i][k], static_cast<int>(i));
    }
  }
  // Qualified references (`A.pos.1`, `A.时间_秒`, `A.[地面速度_μm/s]`) — a card with more
  // than one table input needs to say which table a column belongs to.
  for (const AliasRange& range : aliases) {
    if (range.alias.empty()) continue;
    const std::string prefix = toLower(range.alias) + ".";
    const size_t end = std::min(names.size(), range.first + range.count);
    for (size_t i = range.first; i < end && i < keysByColumn.size(); ++i) {
      for (const std::string& key : keysByColumn[i]) {
        map.emplace(prefix + key, static_cast<int>(i));
      }
    }
  }
  return map;
}

void collectRefs(const NodePtr& node, std::vector<std::string>* out) {
  if (!node) return;
  switch (node->kind) {
    case NodeKind::Column:
      if (std::find(out->begin(), out->end(), node->columnName) == out->end())
        out->push_back(node->columnName);
      break;
    case NodeKind::Binary:
    case NodeKind::Call:
      for (const auto& c : node->children) collectRefs(c, out);
      break;
    case NodeKind::Unary:
      collectRefs(node->children[0], out);
      break;
    case NodeKind::Bound:
    case NodeKind::String:
      // Binders and criteria literals are not column references; listed explicitly so a
      // future node kind cannot silently fall through this switch.
      break;
    case NodeKind::Number:
      break;
  }
}

// ── auto unit conversion (units L2b) ───────────────────────────────────
// Mirrored one-for-one in web/src/core/expression.ts (`applyAutoConvert`). The visit order is
// the node's own children in order (pre-order, left before right), which is both the order
// `compileAst` builds the closures in and the order the TS side walks its AST — a conversion
// list indexed by that order is therefore comparable across the two engines.
NodePtr makeFactorNode(double factor) {
  auto n = std::make_shared<Node>();
  n->kind = NodeKind::Number;
  n->number = factor;
  return n;
}

bool convertibleUnit(const ExprEngine::AutoConvertContext& ctx, int64_t column, size_t* index) {
  if (column < 0) return false;
  const size_t i = static_cast<size_t>(column);
  if (i >= ctx.columnUnits.size() || i >= ctx.columnDimensions.size() ||
      i >= ctx.columnFactors.size()) {
    return false;
  }
  if (ctx.columnUnits[i].empty() || ctx.columnDimensions[i].empty()) return false;
  if (!(ctx.columnFactors[i] > 0.0) || !std::isfinite(ctx.columnFactors[i])) return false;
  *index = i;
  return true;
}

// 1 when the operator pair converts, 0 when it provably does not. Anything not decidable
// (cross-dimension, equal unit, unknown unit, non-direct operand) is 0 — the rule is "convert
// only what the headers prove", never "convert when in doubt".
double autoConvertFactor(const ExprEngine::AutoConvertContext& ctx, int64_t leftColumn,
                         int64_t rightColumn) {
  size_t left = 0;
  size_t right = 0;
  if (!convertibleUnit(ctx, leftColumn, &left)) return 0.0;
  if (!convertibleUnit(ctx, rightColumn, &right)) return 0.0;
  // Cross-dimension is NEVER converted: `MPa + s` stays a warning, not a silent product.
  if (ctx.columnDimensions[left] != ctx.columnDimensions[right]) return 0.0;
  if (ctx.columnUnits[left] == ctx.columnUnits[right]) return 0.0;
  // Multiplicative units only (both factors are strictly positive by construction).
  return ctx.columnFactors[right] / ctx.columnFactors[left];
}

void applyAutoConvert(const NodePtr& node, const ExprEngine::AutoConvertContext& ctx,
                      std::vector<ExprEngine::UnitConversion>* found) {
  if (!node) return;
  if (node->kind == NodeKind::Binary && node->children.size() == 2 &&
      (node->op == "+" || node->op == "-")) {
    NodePtr& left = node->children[0];
    NodePtr& right = node->children[1];
    // DIRECT column operands only: a nested call, a literal, a negation or a sub-expression
    // has no unit of its own that this tier dares to name.
    if (left && right && left->kind == NodeKind::Column && right->kind == NodeKind::Column) {
      const double factor = autoConvertFactor(ctx, left->column, right->column);
      if (factor > 0.0) {
        size_t leftIndex = 0;
        size_t rightIndex = 0;
        convertibleUnit(ctx, left->column, &leftIndex);
        convertibleUnit(ctx, right->column, &rightIndex);
        found->push_back(ExprEngine::UnitConversion{
            static_cast<int64_t>(found->size()), factor, ctx.columnUnits[rightIndex],
            ctx.columnUnits[leftIndex]});
        // TWO left-to-right operations per value — `value * factorRight / factorLeft` — the
        // same locked order the unit-convert card uses. Precomputing a single ratio would
        // change the last bit for some pairs, and the TS reference would then disagree.
        const double factorRight = ctx.columnFactors[rightIndex];
        const double factorLeft = ctx.columnFactors[leftIndex];
        auto convert = std::make_shared<Node>();
        convert->kind = NodeKind::Binary;
        convert->op = "*";
        convert->children = {right, makeFactorNode(factorRight)};
        auto scale = std::make_shared<Node>();
        scale->kind = NodeKind::Binary;
        scale->op = "/";
        scale->children = {convert, makeFactorNode(factorLeft)};
        right = scale;
      }
    }
  }
  for (auto& child : node->children) applyAutoConvert(child, ctx, found);
}

}  // namespace

bool ExprEngine::advancedMathEnabled() {
  const char* value = std::getenv("DC_ADVANCED_MATH");
  return value != nullptr && value[0] != '\0' && std::strcmp(value, "0") != 0;
}

std::vector<double> ExprEngine::evaluate(const std::string& expression,
                                         const std::vector<std::string>& columnNames,
                                         const std::vector<std::vector<double>>& columns,
                                         size_t length,
                                         const std::vector<AliasRange>& aliases) {
  resetAdvancedBudget();
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames, aliases);
  NodePtr ast = parseAst(tokens, colMap);
  EvalFn fn = compileAst(ast);
  return fn(columns, length);
}

std::vector<double> ExprEngine::evaluateAuto(const std::string& expression,
                                             const std::vector<std::string>& columnNames,
                                             const std::vector<std::vector<double>>& columns,
                                             size_t length, const std::vector<AliasRange>& aliases,
                                             const AutoConvertRequest* request,
                                             std::vector<UnitConversion>* conversions) {
  if (conversions != nullptr) conversions->clear();
  resetAdvancedBudget();
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames, aliases);
  NodePtr ast = parseAst(tokens, colMap);
  // Everything below only READS the tree. The `auto` rewrite is therefore confined to the
  // returned numbers: it cannot touch a column vector owned by the caller, so the source table
  // a card reads is never rewritten by a policy tier.
  if (request != nullptr && request->policy == "auto") {
    std::vector<UnitConversion> found;
    applyAutoConvert(ast, request->context, &found);
    if (conversions != nullptr) *conversions = found;
  }
  EvalFn fn = compileAst(ast);
  return fn(columns, length);
}

std::vector<std::string> ExprEngine::references(const std::string& expression,
                                                const std::vector<std::string>& columnNames) {
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames);
  NodePtr ast = parseAst(tokens, colMap);
  std::vector<std::string> refs;
  collectRefs(ast, &refs);
  return refs;
}

namespace {

// Only a bare column node counts as a "direct" operand. `-A` is NOT one: negation is a
// function of the operand, and a unit checker that silently unwrapped it would be guessing
// (the checker's contract is to report only what it can prove).
int64_t directColumn(const NodePtr& node) {
  if (node && node->kind == NodeKind::Column) return static_cast<int64_t>(node->column);
  return -1;
}

// Walk the AST and emit one pair per unit-relevant operator. Branching is structural, the
// same way compileAst compiles: a nested operator is its own pair, so `(A+B)/C` reports the
// `A + B` pair and nothing about `/` (unit algebra is not modelled here).
void collectOperandPairs(const NodePtr& node, std::vector<ExprEngine::OperandPair>* out) {
  if (!node) return;
  if (node->kind == NodeKind::Binary && node->children.size() == 2) {
    const std::string& op = node->op;
    const bool relevant = op == "+" || op == "-" || op == ">" || op == "<" || op == ">=" ||
                          op == "<=" || op == "==" || op == "!=";
    if (relevant) {
      ExprEngine::OperandPair pair;
      pair.op = op;
      pair.leftColumn = directColumn(node->children[0]);
      pair.rightColumn = directColumn(node->children[1]);
      out->push_back(std::move(pair));
    }
  }
  if (node->kind == NodeKind::Call && node->name == "IF" && node->children.size() == 3) {
    ExprEngine::OperandPair pair;
    pair.op = "IF";
    pair.branch = 1;  // the two values the branch chooses between
    pair.leftColumn = directColumn(node->children[1]);
    pair.rightColumn = directColumn(node->children[2]);
    out->push_back(std::move(pair));
  }
  for (const auto& child : node->children) collectOperandPairs(child, out);
}

}  // namespace

std::vector<ExprEngine::OperandPair> ExprEngine::operandPairs(
    const std::string& expression, const std::vector<std::string>& columnNames,
    const std::vector<AliasRange>& aliases) {
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames, aliases);
  NodePtr ast = parseAst(tokens, colMap);
  std::vector<OperandPair> pairs;
  collectOperandPairs(ast, &pairs);
  return pairs;
}

// ── matrix-mode evaluator ──────────────────────────────────────────────
// Parallel AST walker that produces MatVal instead of vector<double>.
// Reuses the same tokenizer/parser/AST; only the evaluation semantics differ.

namespace {

using MatEvalFn = std::function<MatVal(const std::vector<MatVal>&)>;

bool unsupportedAdvancedMatrixCall(const NodePtr& node) {
  if (!envAdvancedMathEnabled() || !node || node->kind != NodeKind::Call) return false;
  static const std::unordered_set<std::string> kNames = {
      "PRODUCT", "INTEGRAL", "DERIV", "COMBIN", "PERMUT",
      "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN",
      "VAR.S", "VAR.P", "STDEV.S", "STDEV.P", "PERCENTILE.INC",
      "PERCENTILE.EXC", "CORREL", "COVARIANCE.S", "COVARIANCE.P",
      "SLOPE", "INTERCEPT", "RSQ", "COUNTIF", "SUMIF", "IRR"};
  return kNames.count(node->name) != 0 ||
         (node->name == "SUM" && node->children.size() != 1);
}

MatEvalFn compileAstMatrix(const NodePtr& node) {
  switch (node->kind) {
    case NodeKind::String:
    case NodeKind::Bound:
      throw ExpressionError("This node kind is unavailable in matrix mode", 0,
                            "unsupportedFunctionMode");
    case NodeKind::Number: {
      double v = node->number;
      return [v](const std::vector<MatVal>&) {
        return MatVal(Eigen::MatrixXd::Constant(1, 1, v));
      };
    }
    case NodeKind::Column: {
      int idx = node->column;
      return [idx](const std::vector<MatVal>& inputs) { return inputs[idx]; };
    }
    case NodeKind::Unary: {
      MatEvalFn inner = compileAstMatrix(node->children[0]);
      return [inner](const std::vector<MatVal>& inputs) {
        return MatVal::negate(inner(inputs));
      };
    }
    case NodeKind::Binary: {
      MatEvalFn l = compileAstMatrix(node->children[0]);
      MatEvalFn r = compileAstMatrix(node->children[1]);
      std::string op = node->op;
      return [l, r, op](const std::vector<MatVal>& inputs) {
        MatVal a = l(inputs);
        MatVal b = r(inputs);
        if (op == "+") return MatVal::add(a, b);
        if (op == "-") return MatVal::sub(a, b);
        if (op == "*") return MatVal::matmul(a, b);  // matrix mode: * = matmul
        if (op == "/") return MatVal::divElementwise(a, b);
        if (op == "%") return MatVal::modElementwise(a, b);
        if (op == "^") return MatVal::powElementwise(a, b);
        // Comparisons in matrix mode: element-wise, result is 0/1 matrix.
        auto cmpOp = [&](const std::function<bool(double,double)>& fn) {
          int64_t rows, cols;
          MatVal::broadcastShapes(a, b, &rows, &cols);
          // A scalar operand broadcasts: read it at (0,0), never at (i,j) — indexing
          // the raw 1×1 buffer at the result shape read past its end (heap overread).
          const bool aScalar = a.isScalar(), bScalar = b.isScalar();
          Eigen::MatrixXd r(rows, cols);
          for (int64_t i = 0; i < rows; ++i)
            for (int64_t j = 0; j < cols; ++j)
              r(i,j) = fn(aScalar ? a.scalar() : a.eigen()(i,j),
                          bScalar ? b.scalar() : b.eigen()(i,j)) ? 1.0 : 0.0;
          return MatVal(r);
        };
        if (op == ">")  return cmpOp([](double x, double y){ return x > y; });
        if (op == "<")  return cmpOp([](double x, double y){ return x < y; });
        if (op == ">=") return cmpOp([](double x, double y){ return x >= y; });
        if (op == "<=") return cmpOp([](double x, double y){ return x <= y; });
        if (op == "==") return cmpOp([](double x, double y){ return x == y; });
        if (op == "!=") return cmpOp([](double x, double y){ return x != y; });
        return MatVal();
      };
    }
    case NodeKind::Call: {
      const std::string name = node->name;
      if (unsupportedAdvancedMatrixCall(node)) {
        throw ExpressionError(name + " is unavailable in matrix mode", 0,
                              "unsupportedFunctionMode", name);
      }
      std::vector<MatEvalFn> argFns;
      for (const auto& a : node->children) argFns.push_back(compileAstMatrix(a));

      // Matrix-specific functions.
      if (name == "TRANSPOSE") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          return MatVal::transpose(inner(inputs));
        };
      }
      if (name == "DET") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          double d = MatVal::determinant(inner(inputs));
          return MatVal(Eigen::MatrixXd::Constant(1, 1, d));
        };
      }
      if (name == "INV") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          return MatVal::inverse(inner(inputs));
        };
      }
      if (name == "SOLVE") {
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::solve(aFn(inputs), bFn(inputs));
        };
      }
      if (name == "MMUL") {
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::matmul(aFn(inputs), bFn(inputs));
        };
      }
      if (name == "EMUL") {
        // Explicit element-wise multiply (for when * means matmul).
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::mulElementwise(aFn(inputs), bFn(inputs));
        };
      }

      // Aggregations in matrix mode: reduce entire matrix to scalar, broadcast as 1×1.
      if (aggregationNames().count(name) && !((name == "MIN" || name == "MAX") && argFns.size() > 1)) {
        MatEvalFn inner = argFns[0];
        return [inner, name](const std::vector<MatVal>& inputs) {
          MatVal m = inner(inputs);
          const auto& e = m.eigen();
          double scalar = NAN;
          if (name == "SUM") {
            scalar = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) scalar += e(i,j);
          } else if (name == "AVG" || name == "MEAN") {
            double s = 0; int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) { s += e(i,j); ++n; }
            scalar = n > 0 ? s / n : NAN;
          } else if (name == "MIN") {
            double mv = INFINITY;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j)) && e(i,j) < mv) mv = e(i,j);
            scalar = mv == INFINITY ? NAN : mv;
          } else if (name == "MAX") {
            double mv = -INFINITY;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j)) && e(i,j) > mv) mv = e(i,j);
            scalar = mv == -INFINITY ? NAN : mv;
          } else if (name == "MEDIAN") {
            std::vector<double> sorted;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) sorted.push_back(e(i,j));
            std::sort(sorted.begin(), sorted.end());
            size_t mid = sorted.size() / 2;
            scalar = sorted.empty() ? NAN
                   : sorted.size() % 2 ? sorted[mid]
                   : (sorted[mid-1] + sorted[mid]) / 2.0;
          } else if (name == "STD") {
            double s = 0; int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) { s += e(i,j); ++n; }
            double mean = n > 0 ? s / n : NAN;
            double ss = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) ss += (e(i,j) - mean) * (e(i,j) - mean);
            scalar = n > 1 ? std::sqrt(ss / (n - 1)) : (n == 1 ? 0.0 : NAN);
          } else if (name == "COUNT") {
            int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) ++n;
            scalar = static_cast<double>(n);
          } else if (name == "NAN") {
            int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isnan(e(i,j))) ++n;
            scalar = static_cast<double>(n);
          } else if (name == "VAR" || name == "SEM") {
            double s = 0; int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) { s += e(i,j); ++n; }
            double mean = n > 0 ? s / n : NAN;
            double ss = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) ss += (e(i,j) - mean) * (e(i,j) - mean);
            if (name == "VAR") {
              scalar = n == 0 ? NAN : n == 1 ? 0.0 : ss / static_cast<double>(n - 1);
            } else {
              scalar = n < 2 ? 0.0
                             : std::sqrt(ss / static_cast<double>(n - 1)) /
                                   std::sqrt(static_cast<double>(n));
            }
          }
          return MatVal(Eigen::MatrixXd::Constant(1, 1, scalar));
        };
      }

      // Element-wise math functions applied to every element of the matrix.
      if (name == "ABS" || name == "SQRT" || name == "LOG" || name == "LN" ||
          name == "LOG10" || name == "EXP" || name == "FLOOR" || name == "CEIL" ||
          name == "SIGN" || name == "ROUND" || name == "POW") {
        return [argFns, name](const std::vector<MatVal>& inputs) {
          MatVal m = argFns[0](inputs);
          const auto& e = m.eigen();
          if (name == "POW") {
            MatVal exp = argFns[1](inputs);
            // The exponent must be scalar (broadcast) or match the base shape;
            // indexing a mismatched exponent per element read past its buffer.
            int64_t rows, cols;
            MatVal::broadcastShapes(m, exp, &rows, &cols);
            const bool mScalar = m.isScalar(), expScalar = exp.isScalar();
            Eigen::MatrixXd pr(rows, cols);
            for (int64_t i = 0; i < rows; ++i)
              for (int64_t j = 0; j < cols; ++j)
                pr(i,j) = jsPow(mScalar ? m.scalar() : e(i,j),
                                expScalar ? exp.scalar() : exp.eigen()(i,j));
            return MatVal(pr);
          }
          Eigen::MatrixXd r(e.rows(), e.cols());
          if (name == "ROUND") {
            double f = 1.0;
            if (argFns.size() > 1) {
              MatVal d = argFns[1](inputs);
              // Digits must be scalar: a matrix argument silently used element (0,0)
              // (and read (0,0) of an empty matrix). Refuse like other shape errors.
              if (!d.isScalar())
                throw ShapeError("ROUND requires scalar digits, got " +
                                 std::to_string(d.rows()) + "×" + std::to_string(d.cols()));
              f = jsPow(10.0, d.scalar());  // exponent as-is, matching the TS reference
            }
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                r(i,j) = jsRound(e(i,j) * f) / f;
          } else {
            auto fn = [&](double v) -> double {
              if (name == "ABS") return std::fabs(v);
              if (name == "SQRT") return std::sqrt(v);
              if (name == "LOG" || name == "LN") return std::log(v);
              if (name == "LOG10") return std::log10(v);
              if (name == "EXP") return std::exp(v);
              if (name == "FLOOR") return std::floor(v);
              if (name == "CEIL") return std::ceil(v);
              if (name == "SIGN") return (std::isnan(v) || v == 0.0) ? v : static_cast<double>((v > 0) - (v < 0));
              return v;
            };
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                r(i,j) = fn(e(i,j));
          }
          return MatVal(r);
        };
      }

      // IF in matrix mode: element-wise conditional over matrices.
      if (name == "IF") {
        MatEvalFn condFn = argFns[0], trueFn = argFns[1], falseFn = argFns[2];
        return [condFn, trueFn, falseFn](const std::vector<MatVal>& inputs) {
          MatVal c = condFn(inputs);
          MatVal t = trueFn(inputs);
          MatVal f = falseFn(inputs);
          // Result shape is the broadcast of condition AND both branches: a scalar
          // condition must not truncate matrix branches to 1×1, and a non-scalar
          // condition must match the branches it indexes.
          int64_t rows, cols;
          if (c.isScalar()) {
            MatVal::broadcastShapes(t, f, &rows, &cols);
          } else {
            MatVal::broadcastShapes(c, t, &rows, &cols);
            MatVal::broadcastShapes(c, f, &rows, &cols);
          }
          const bool cScalar = c.isScalar(), tScalar = t.isScalar(), fScalar = f.isScalar();
          Eigen::MatrixXd r(rows, cols);
          for (int64_t i = 0; i < rows; ++i)
            for (int64_t j = 0; j < cols; ++j) {
              double cv = cScalar ? c.scalar() : c.eigen()(i,j);
              double tv = tScalar ? t.scalar() : t.eigen()(i,j);
              double fv = fScalar ? f.scalar() : f.eigen()(i,j);
              r(i,j) = cv != 0.0 ? tv : fv;
            }
          return MatVal(r);
        };
      }

      // MOV/EMA not meaningful for matrices in v1; fall through to identity.
      return [](const std::vector<MatVal>&) { return MatVal(); };
    }
  }
  return nullptr;
}

}  // namespace

std::vector<double> ExprEngine::evaluateMatrix(
    const std::string& expression,
    const std::vector<std::string>& varNames,
    const std::vector<MatVal>& inputs,
    int64_t* outRows, int64_t* outCols) {
  // Build column map: varName → index. Matrix mode uses exact-case matching
  // (the variable declaration is explicit; no Pos.N aliasing needed).
  std::unordered_map<std::string, int> colMap;
  for (size_t i = 0; i < varNames.size(); ++i) {
    colMap[toLower(varNames[i])] = static_cast<int>(i);
  }
  auto tokens = tokenize(expression);
  NodePtr ast = parseAst(tokens, colMap);
  MatEvalFn fn = compileAstMatrix(ast);
  MatVal result = fn(inputs);
  *outRows = result.rows();
  *outCols = result.cols();
  return result.toColumnMajor();
}

}  // namespace dc
