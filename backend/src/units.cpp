// Column units v1 — registry, suffix resolver and the `builtin:unit-convert` arithmetic.
//
// This is a semantic port of `web/src/core/units.ts`. The port is *literal* on purpose: the
// factor constants, the order of the lookup tables, the ambiguity overrides and the suffix
// grammar are transcribed one-for-one, because `web/tests/fixtures/units/parse.json` is judged
// by both resolvers and any "improvement" here becomes a silent TS/C++ divergence. Every
// non-obvious decision below carries the TS line it mirrors.
#include "units.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace dc {

namespace {

// ── Registry ────────────────────────────────────────────────────────────────────────────
//
// An entry is spelled several ways (`u`+symbol and `µ`+symbol, `lpm` and `L_min`); exact
// spelling wins over case folding, so `Nm` (N·m) and `nm` (nanometre) are different entries.
struct Entry {
  std::string unit;
  std::string dimension;
  double factor = 0.0;
  bool scalar = false;
  std::vector<std::string> spellings;
};

struct PrefixFactor {
  const char* prefix;
  double factor;
};

// units.ts PREFIX_FACTOR. Order is irrelevant for exact lookup but kept as published.
const std::vector<PrefixFactor>& prefixFactors() {
  static const std::vector<PrefixFactor> kTable = {
      {"n", 1e-9}, {"\u00b5", 1e-6}, {"m", 1e-3}, {"c", 1e-2}, {"d", 1e-1},
      {"h", 1e2},  {"k", 1e3},       {"M", 1e6},  {"G", 1e9},
  };
  return kTable;
}

struct BaseDef {
  const char* symbol;
  const char* dimension;
  double factor;
  std::vector<const char*> prefixes;  // curated: `mV` exists, `MV` does not
};

// units.ts BASES — same order (it decides the order of `candidates` for a folded collision).
const std::vector<BaseDef>& bases() {
  static const std::vector<BaseDef> kTable = {
      {"m", "length", 1.0, {"n", "\u00b5", "m", "c", "k", "M"}},
      {"g", "mass", 1e-3, {"\u00b5", "m", "k"}},
      {"s", "time", 1.0, {"n", "\u00b5", "m", "k", "M"}},
      {"A", "current", 1.0, {"\u00b5", "m", "k"}},
      {"V", "voltage", 1.0, {"\u00b5", "m", "k"}},
      {"W", "power", 1.0, {"\u00b5", "m", "k", "M", "G"}},
      {"J", "energy", 1.0, {"m", "k", "M", "G"}},
      {"N", "force", 1.0, {"\u00b5", "m", "k", "M"}},
      {"Pa", "pressure", 1.0, {"m", "h", "k", "M", "G"}},
      {"Hz", "frequency", 1.0, {"m", "k", "M", "G"}},
      {"L", "volume", 1e-3, {"\u00b5", "m", "d"}},
      {"mol", "amount", 1.0, {"n", "\u00b5", "m"}},
      {"K", "temperature_absolute", 1.0, {"m"}},
      {"bar", "pressure", 1e5, {"m"}},
  };
  return kTable;
}

double prefixFactorFor(const std::string& prefix) {
  for (const PrefixFactor& p : prefixFactors()) {
    if (prefix == p.prefix) return p.factor;
  }
  return 0.0;
}

// units.ts EXTRAS — composite / non-prefix units, table entries with no grammar behind them.
std::vector<Entry> extras() {
  const std::string micro = "\u00b5";
  return {
      {"min", "time", 60.0, true, {"min"}},
      {"h", "time", 3600.0, true, {"h"}},
      {"d", "time", 86400.0, true, {"d"}},
      // 1.0/60.0, written as the same expression as TS so the compile-time constant is the
      // same double (a literal 0.016666666666666666 would also be, but this cannot drift).
      {"rpm", "frequency", 1.0 / 60.0, true, {"rpm"}},
      {"L/min", "flow", 1e-3 / 60.0, true, {"L/min", "L_min", "lpm"}},
      {"m/s", "velocity", 1.0, true, {"m/s", "m_s", "ms"}},
      {"mm/s", "velocity", 1e-3, true, {"mm/s", "mm_s"}},
      {"km/h", "velocity", 1.0 / 3.6, true, {"km/h", "km_h", "kmh"}},
      {"N\u00b7m", "torque", 1.0, true, {"N\u00b7m", "N_m", "Nm"}},
      {"A\u00b7h", "charge", 3600.0, true, {"A\u00b7h", "Ah", "AH"}},
      {"kWh", "energy", 3.6e6, true, {"kWh"}},
      {"kWh/m\u00b2", "energy_per_area", 3.6e6, true,
       {"kWh/m\u00b2", "kWh_m2", "kwh_m2"}},
      {"W/m\u00b2", "power_per_area", 1.0, true, {"W/m\u00b2", "W_m2", "wm2"}},
      {"mg/L", "mass_concentration", 1e-3, true, {"mg/L", "mg_l"}},
      {micro + "g/m\u00b3", "mass_concentration", 1e-9, true,
       {micro + "g/m\u00b3", "ug/m3", "ugm3"}},
      {micro + "mol/min", "molar_flow", 1e-6 / 60.0, true, {micro + "mol/min", "umol_min"}},
      {"mM", "molar_concentration", 1.0, true, {"mM"}},
      {"pct", "ratio", 1e-2, true, {"pct", "%"}},
      {"ppm", "ratio", 1e-6, true, {"ppm"}},
      {"ppb", "ratio", 1e-9, true, {"ppb"}},
      {micro + "\u03b5", "strain", 1e-6, true, {micro + "\u03b5", "ue"}},
      {"kUSD", "currency_usd", 1e3, true, {"kUSD", "kusd"}},
      // Opaque: readable label, no conversion, no algebra.
      {"AU", "", 0.0, false, {"AU", "au"}},
      // Non-scalar: affine / logarithmic / empirical scales — the v1 decision keeps them labels.
      {"\u00b0C", "", 0.0, false,
       {"\u2103", "\u00b0C", "\u00b0c", "c", "C", "degC", "degc"}},
      {"\u00b0F", "", 0.0, false, {"\u2109", "\u00b0F", "\u00b0f", "degF", "degf"}},
      {"pH", "", 0.0, false, {"pH", "ph"}},
      {"dB", "", 0.0, false, {"dB", "db"}},
      {"dBm", "", 0.0, false, {"dBm", "dbm"}},
      {"HRC", "", 0.0, false, {"HRC", "hrc"}},
      {"HV", "", 0.0, false, {"HV", "hv"}},
      {"HB", "", 0.0, false, {"HB", "hb"}},
  };
}

// Generated once from BASES × prefixes, then the extras — exactly the order units.ts
// registers in, because `BY_UNIT` and the folded bucket list depend on it.
const std::vector<Entry>& registry() {
  static const std::vector<Entry> kEntries = [] {
    std::vector<Entry> out;
    for (const BaseDef& base : bases()) {
      Entry plain;
      plain.unit = base.symbol;
      plain.dimension = base.dimension;
      plain.factor = base.factor;
      plain.scalar = true;
      plain.spellings = {base.symbol};
      out.push_back(std::move(plain));
      for (const char* prefix : base.prefixes) {
        const double multiplier = prefixFactorFor(prefix);
        if (multiplier == 0.0) continue;
        Entry pre;
        pre.unit = std::string(prefix) + base.symbol;
        pre.dimension = base.dimension;
        pre.factor = base.factor * multiplier;
        pre.scalar = true;
        pre.spellings = {pre.unit};
        // `um` is how half the world types `µm`; both must resolve to the same entry.
        if (std::string(prefix) == "\u00b5") pre.spellings.push_back(std::string("u") + base.symbol);
        out.push_back(std::move(pre));
      }
    }
    for (Entry extra : extras()) out.push_back(std::move(extra));
    return out;
  }();
  return kEntries;
}

// ASCII-only lower-casing, because JS `String.prototype.toLowerCase` only ever *adds* a mapping
// for non-ASCII (µ → µ, ℃ → ℃ in this table), so an ASCII fold reproduces every key the
// registry actually contains while staying independent of the host locale. std::tolower is
// deliberately not used: it is locale-sensitive and would fold `I` to a dotless `ı` under tr_TR.
std::string foldAscii(const std::string& s) {
  std::string out = s;
  for (char& ch : out) {
    const unsigned char uc = static_cast<unsigned char>(ch);
    if (uc < 0x80) ch = static_cast<char>(std::tolower(uc));
  }
  return out;
}

const std::unordered_map<std::string, const Entry*>& exactIndex() {
  static const std::unordered_map<std::string, const Entry*> kIndex = [] {
    std::unordered_map<std::string, const Entry*> map;
    for (const Entry& entry : registry()) {
      for (const std::string& spelling : entry.spellings) {
        // First registration wins (map.has check in TS).
        map.emplace(spelling, &entry);
      }
    }
    return map;
  }();
  return kIndex;
}

const std::unordered_map<std::string, std::vector<const Entry*>>& foldedIndex() {
  static const std::unordered_map<std::string, std::vector<const Entry*>> kIndex = [] {
    std::unordered_map<std::string, std::vector<const Entry*>> map;
    for (const Entry& entry : registry()) {
      for (const std::string& spelling : entry.spellings) {
        std::vector<const Entry*>& bucket = map[foldAscii(spelling)];
        // `bucket.includes(entry)` in TS compares entry identity; here every entry has a
        // distinct canonical unit, so identity is the pointer.
        if (std::find(bucket.begin(), bucket.end(), &entry) == bucket.end()) {
          bucket.push_back(&entry);
        }
      }
    }
    return map;
  }();
  return kIndex;
}

const std::unordered_map<std::string, const Entry*>& byUnitIndex() {
  static const std::unordered_map<std::string, const Entry*> kIndex = [] {
    std::unordered_map<std::string, const Entry*> map;
    for (const Entry& entry : registry()) map.emplace(entry.unit, &entry);
    return map;
  }();
  return kIndex;
}

// Tokens whose one spelling has two readings. They stay ambiguous even when the exact spelling
// would resolve, because the collision is semantic (`time_ms` vs `wind_ms`).
const std::map<std::string, std::vector<std::string>>& ambiguousTokens() {
  static const std::map<std::string, std::vector<std::string>> kTable = {
      {"ms", {"ms", "m/s"}},
      {"mm", {"mm", "mM"}},
      {"mw", {"mW", "MW"}},
      {"ph", {"pH"}},
  };
  return kTable;
}

// Header suffixes that are never units (`batch_no`, `sample_id`, `line_a_units`).
const std::set<std::string>& stopTokens() {
  static const std::set<std::string> kSet = {"id",   "no",    "num", "nr",   "index",
                                             "idx",  "unit",  "units", "qty", "count"};
  return kSet;
}

// ── Small predicates used by the grammar ──────────────────────────────────────────────

bool isAsciiAlpha(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

bool isAsciiDigit(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return c >= '0' && c <= '9';
}

bool isSpaceChar(char ch) {
  // JS `\s` plus trim(): space, tab, LF, CR, VT, FF, NBSP. Enough for header text; the
  // resolver never trims anything else.
  return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\v' || ch == '\f';
}

std::string trimAscii(const std::string& s) {
  size_t begin = 0;
  size_t end = s.size();
  while (begin < end && isSpaceChar(s[begin])) ++begin;
  while (end > begin && isSpaceChar(s[end - 1])) --end;
  return s.substr(begin, end - begin);
}

// units.ts SINGLE_LETTER = /^[A-Za-z]$/ — one ASCII letter, nothing more.
bool isSingleLetter(const std::string& s) { return s.size() == 1 && isAsciiAlpha(s[0]); }

// units.ts NUMERIC = /^\d+(?:[.,]\d+)?$/ — `001`, `1.5`: a column counter, not a unit.
bool isNumericToken(const std::string& s) {
  if (s.empty()) return false;
  size_t i = 0;
  while (i < s.size() && isAsciiDigit(s[i])) ++i;
  if (i == 0) return false;
  if (i == s.size()) return true;
  if (s[i] != '.' && s[i] != ',') return false;
  ++i;
  if (i == s.size()) return false;
  while (i < s.size() && isAsciiDigit(s[i])) ++i;
  return i == s.size();
}

// ── Byte helpers for the UTF-8 aware suffix scan ──────────────────────────────────────

// Length of the UTF-8 sequence starting at `i` (1 for a malformed lead byte, so the scan
// always advances).
size_t utf8Length(const std::string& s, size_t i) {
  const unsigned char c = static_cast<unsigned char>(s[i]);
  size_t len = 1;
  if (c >= 0xF0) len = 4;
  else if (c >= 0xE0) len = 3;
  else if (c >= 0xC0) len = 2;
  if (i + len > s.size()) return 1;
  // Well-formed sequences only; a truncated tail is treated as one byte.
  for (size_t k = 1; k < len; ++k) {
    if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return 1;
  }
  return len;
}

// The one member of `cps` (an opening or closing bracket glyph) starting at `i`, or "".
std::string matchCodePoint(const std::string& s, size_t i, const std::vector<std::string>& cps) {
  for (const std::string& cp : cps) {
    if (s.compare(i, cp.size(), cp) == 0) return cp;
  }
  return std::string();
}

const std::vector<std::string>& openBrackets() {
  static const std::vector<std::string> kSet = {
      "(", "\uff08", "[", "\uff3b", "\u3010"};  // ( （ [ ［ 【
  return kSet;
}

const std::vector<std::string>& closeBrackets() {
  static const std::vector<std::string> kSet = {
      ")", "\uff09", "]", "\uff3d", "\u3011"};  // ) ） ] ］ 】
  return kSet;
}

// units.ts BRACKET_SUFFIX = /[(（[［【]\s*([^()（）[\]［］【】]+?)\s*[)）\]］】]\s*$/ with the JS
// semantics that make it work: `.` does not cross a newline, `\s*` is greedy but backtracks,
// and `[...]+?` (lazy) is anchored by `$`, so for a given closing bracket the LAST opening
// bracket before it wins. That is why this is not a left-to-right regex scan.
struct BracketSuffix {
  size_t innerStart = 0;
  size_t innerLength = 0;
};

bool bracketSuffix(const std::string& s, BracketSuffix* out) {
  // Tokenise once into code points, then reason in index space — measuring lengths backwards
  // through a UTF-8 byte string is exactly the kind of arithmetic that silently lands mid-glyph.
  std::vector<std::pair<size_t, size_t>> cps;  // (byte offset, byte length) per code point
  for (size_t i = 0; i < s.size();) {
    const size_t len = utf8Length(s, i);
    cps.emplace_back(i, len);
    i += len;
  }
  size_t n = cps.size();

  // `\s*$` after the closing bracket.
  while (n > 0 && cps[n - 1].second == 1 && isSpaceChar(s[cps[n - 1].first])) --n;
  if (n == 0) return false;

  // The closing bracket must END the trimmed string.
  const std::string closeGlyph = matchCodePoint(s, cps[n - 1].first, closeBrackets());
  if (closeGlyph.empty() || cps[n - 1].second != closeGlyph.size()) return false;
  const size_t contentEndCp = n - 1;  // exclusive upper bound of the inner text (code points)

  // The LAST opening bracket before it wins (the lazy `[^…]+?` is anchored by `$`). Whatever
  // sits between the two must be free of bracket glyphs; an empty body is not a match, but an
  // earlier opening bracket may still be.
  for (size_t openCp = contentEndCp; openCp-- > 0;) {
    const std::string openGlyph = matchCodePoint(s, cps[openCp].first, openBrackets());
    if (openGlyph.empty()) continue;
    size_t innerFirst = openCp + 1;
    while (innerFirst < contentEndCp && cps[innerFirst].second == 1 &&
           isSpaceChar(s[cps[innerFirst].first])) {
      ++innerFirst;
    }
    if (innerFirst >= contentEndCp) continue;  // `+?` needs at least one character
    const size_t innerStart = cps[innerFirst].first;
    const size_t innerEnd = cps[contentEndCp].first;
    out->innerStart = innerStart;
    out->innerLength = innerEnd - innerStart;
    return true;
  }
  return false;
}

// ── Suffix enumeration ────────────────────────────────────────────────────────────────

struct Suffix {
  std::string token;
  size_t start = 0;
  size_t end = 0;
};

// Candidate unit suffixes of one annotation, longest first.
//
// `vibration_mm_s` offers `mm_s` before `s`; the bracket form (`压力 (MPa)`) is tried after
// every underscore suffix so `压力_MPa (bar)` cannot silently read as `bar`.
std::vector<Suffix> suffixes(const std::string& annotation) {
  std::vector<Suffix> out;

  std::vector<std::pair<std::string, size_t>> parts;  // text + start offset (bytes)
  size_t start = 0;
  for (size_t i = 0; i <= annotation.size(); ++i) {
    if (i == annotation.size() || annotation[i] == '_') {
      parts.emplace_back(annotation.substr(start, i - start), start);
      start = i + 1;
    }
  }
  // `for (let count = parts.length - 1; count >= 1; count -= 1)` in units.ts. Kept as a signed
  // loop on purpose: the same condition on an unsigned size_t underflows to SIZE_MAX and spins
  // forever once it reaches zero.
  for (long count = static_cast<long>(parts.size()); count >= 1; --count) {
    const size_t from = parts.size() - static_cast<size_t>(count);
    std::string token = parts[from].first;
    for (size_t k = from + 1; k < parts.size(); ++k) {
      token += "_";
      token += parts[k].first;
    }
    out.push_back({token, parts[from].second, annotation.size()});
  }

  BracketSuffix bracket;
  if (bracketSuffix(annotation, &bracket)) {
    out.push_back({annotation.substr(bracket.innerStart, bracket.innerLength), bracket.innerStart,
                   bracket.innerStart + bracket.innerLength});
  }
  return out;
}

UnitCandidate toCandidate(const Entry& entry) {
  UnitCandidate c;
  c.unit = entry.unit;
  c.dimension = entry.dimension;
  c.factor = entry.factor;
  c.scalar = entry.scalar;
  return c;
}

UnitResolution makeUnknown(const std::string& token, const Suffix* span) {
  UnitResolution r;
  r.state = UnitState::Unknown;
  r.unit.clear();
  r.token = token;
  if (span != nullptr) {
    r.hasSpan = true;
    r.span = {span->start, span->end};
  }
  return r;
}

UnitResolution makeAmbiguous(const std::string& token, const Suffix& span,
                             const std::vector<const Entry*>& candidates) {
  UnitResolution r;
  r.state = UnitState::Ambiguous;
  r.unit.clear();
  r.token = token;
  r.hasSpan = true;
  r.span = {span.start, span.end};
  for (const Entry* entry : candidates) r.candidates.push_back(toCandidate(*entry));
  return r;
}

UnitResolution makeRecognized(const Entry& entry, const std::string& token, const Suffix& span) {
  UnitResolution r;
  r.state = UnitState::Recognized;
  r.unit = entry.unit;
  r.token = token;
  r.hasSpan = true;
  r.span = {span.start, span.end};
  r.scalar = entry.scalar;
  r.dimension = entry.dimension;
  r.factor = entry.factor;
  return r;
}

// units.ts lookup(): exact spelling first, then the unique (or not) case-folded bucket.
std::vector<const Entry*> lookup(const std::string& token) {
  const auto& exact = exactIndex();
  const auto exactIt = exact.find(token);
  if (exactIt != exact.end()) return {exactIt->second};
  const auto& folded = foldedIndex();
  const auto foldedIt = folded.find(foldAscii(token));
  if (foldedIt == folded.end()) return {};
  return foldedIt->second;
}

}  // namespace

const char* unitStateName(UnitState s) {
  switch (s) {
    case UnitState::Recognized:
      return "recognized";
    case UnitState::Ambiguous:
      return "ambiguous";
    case UnitState::Unknown:
      return "unknown";
  }
  return "unknown";
}

std::string normalizeUnitToken(const std::string& raw) {
  // units.ts normalizeToken: trim, then U+03BC → U+00B5.
  std::string out = trimAscii(raw);
  const std::string greekMu = "\u03bc";
  const std::string microSign = "\u00b5";
  size_t pos = 0;
  while ((pos = out.find(greekMu, pos)) != std::string::npos) {
    out.replace(pos, greekMu.size(), microSign);
    pos += microSign.size();
  }
  return out;
}

UnitResolution resolveUnit(const std::string& annotation) {
  const std::string text = trimAscii(annotation);
  if (text.empty()) return makeUnknown("", nullptr);

  for (const Suffix& suffix : suffixes(text)) {
    const std::string token = normalizeUnitToken(suffix.token);
    if (token.empty() || isNumericToken(token) || stopTokens().count(foldAscii(token)) != 0) {
      continue;
    }

    const auto& overrides = ambiguousTokens();
    const auto overrideIt = overrides.find(foldAscii(token));
    if (overrideIt != overrides.end()) {
      std::vector<const Entry*> candidates;
      for (const std::string& unit : overrideIt->second) {
        const auto& byUnit = byUnitIndex();
        const auto entryIt = byUnit.find(unit);
        if (entryIt != byUnit.end()) candidates.push_back(entryIt->second);
      }
      return makeAmbiguous(token, suffix, candidates);
    }

    const std::vector<const Entry*> hits = lookup(token);
    if (hits.empty()) continue;
    if (hits.size() > 1) return makeAmbiguous(token, suffix, hits);

    const Entry& entry = *hits[0];
    // Single ASCII letters are index/group names far more often than units (`sensor_a`).
    if (isSingleLetter(token)) return makeAmbiguous(token, suffix, {&entry});
    return makeRecognized(entry, token, suffix);
  }

  return makeUnknown("", nullptr);
}

bool candidateByUnit(const std::string& unit, UnitCandidate* out) {
  const auto& byUnit = byUnitIndex();
  const auto it = byUnit.find(unit);
  if (it == byUnit.end()) return false;
  if (out != nullptr) *out = toCandidate(*it->second);
  return true;
}

std::string rewriteUnitAnnotation(const std::string& annotation, const UnitResolution& resolution,
                                  const std::string& to) {
  if (!resolution.hasSpan || resolution.span.start > resolution.span.end ||
      resolution.span.end > annotation.size()) {
    // No unit suffix to replace: append the canonical target instead of guessing a position.
    return annotation.empty() ? to : annotation + "_" + to;
  }
  return annotation.substr(0, resolution.span.start) + to +
         annotation.substr(resolution.span.end);
}

// ── `builtin:unit-convert` ──────────────────────────────────────────────────────────────

namespace {

UnitConvertResult failConvert(const char* code, const std::string& name, const Json& value = Json()) {
  UnitConvertResult result;
  result.errorCode = code;
  if (!name.empty()) result.errorParams = Json::object({{name, value}});
  return result;
}

// One validated `params.targets` entry.
struct Target {
  size_t column = 0;
  UnitCandidate from;
  UnitCandidate to;
  UnitResolution annotationResolution;  // used to rewrite the output annotation
};

// Resolves `from` (explicit or from the annotation) and `to`, rejecting anything that is not a
// registered, convertible unit. Runs BEFORE any arithmetic, so a rejection cannot leave a
// half-converted table behind.
bool resolveTarget(const std::vector<Column>& input, const Json& spec, Target* target,
                   UnitConvertResult* error) {
  if (!spec.isObject()) {
    *error = failConvert("badSignatureParams", "name", Json(std::string("targets")));
    return false;
  }
  const Json* column = spec.find("column");
  if (column == nullptr || !column->isNumber()) {
    *error = failConvert("badSignatureParams", "name", Json(std::string("targets")));
    return false;
  }
  const double columnValue = column->asNumber();
  // A fractional or negative index is not a column; nor is a header-wide 2.0 typed as such.
  if (columnValue < 0 || columnValue != static_cast<double>(static_cast<int64_t>(columnValue)) ||
      static_cast<int64_t>(columnValue) >= static_cast<int64_t>(input.size())) {
    *error = failConvert("badSignatureParams", "name", Json(std::string("targets")));
    return false;
  }
  target->column = static_cast<size_t>(columnValue);

  // `to` must at least be a string before anything else is attempted.
  const Json* toParam = spec.find("to");
  if (toParam == nullptr || !toParam->isString()) {
    *error = failConvert("badSignatureParams", "name", Json(std::string("targets")));
    return false;
  }

  const Column& source = input[target->column];
  const Json* fromParam = spec.find("from");
  if (fromParam != nullptr && !fromParam->isNull()) {
    // An explicit `from` is the user's confirmation: it bypasses the annotation parse entirely,
    // which is exactly how an `ambiguous` header (`current_a`) becomes convertible.
    if (!fromParam->isString()) {
      *error = failConvert("badSignatureParams", "name", Json(std::string("targets")));
      return false;
    }
    if (!candidateByUnit(fromParam->asString(), &target->from)) {
      *error = failConvert("unknownUnit", "unit", Json(fromParam->asString()));
      return false;
    }
    if (!target->from.scalar) {
      *error = failConvert("unitNotScalar", "unit", Json(target->from.unit));
      return false;
    }
    // The annotation still has to be rewritten, so its own parse is kept (for the span).
    target->annotationResolution = resolveUnit(source.annotation);
  } else {
    const UnitResolution resolution = resolveUnit(source.annotation);
    if (resolution.state == UnitState::Unknown) {
      *error = failConvert("unitUnknown", "column",
                           Json(static_cast<int64_t>(target->column)));
      return false;
    }
    if (resolution.state == UnitState::Ambiguous) {
      *error = failConvert("unitAmbiguous", "column",
                           Json(static_cast<int64_t>(target->column)));
      error->errorParams.set("token", Json(resolution.token));
      return false;
    }
    // A recognised non-scalar annotation (°C/dB/HRC/AU) has no multiplicative conversion.
    if (!resolution.scalar) {
      *error = failConvert("unitNotScalar", "unit", Json(resolution.unit));
      error->errorParams.set("column", Json(static_cast<int64_t>(target->column)));
      return false;
    }
    (void)candidateByUnit(resolution.unit, &target->from);
    target->annotationResolution = resolution;
  }

  // Precedence (lock): the SOURCE unit is settled first, so `level_db -> Pa` reports
  // unitNotScalar (the dB column is the problem) instead of unitMismatch (which would blame the
  // pair). Only then is the target looked up and its scalar-ness checked.
  if (!candidateByUnit(toParam->asString(), &target->to)) {
    // Not in the registry at all. A registered-but-non-scalar target is unitNotScalar below —
    // `unknownUnit` is specifically "this name is not a unit we know".
    *error = failConvert("unknownUnit", "unit", Json(toParam->asString()));
    return false;
  }
  if (!target->to.scalar) {
    *error = failConvert("unitNotScalar", "unit", Json(target->to.unit));
    return false;
  }

  if (target->from.dimension != target->to.dimension) {
    // Never a silent conversion across dimensions: `MPa` and `kN` are both "a number", and
    // multiplying one into the other is how a pressure silently becomes a force.
    *error = failConvert("unitMismatch", "column", Json(static_cast<int64_t>(target->column)));
    error->errorParams.set("from", Json(target->from.unit));
    error->errorParams.set("to", Json(target->to.unit));
    return false;
  }
  return true;
}

}  // namespace

UnitConvertResult evaluateUnitConvert(const std::vector<Column>& input, const Json& params) {
  const Json* targetsParam = params.find("targets");
  if (targetsParam == nullptr) {
    return failConvert("badSignatureParams", "name", Json(std::string("targets")));
  }
  if (!targetsParam->isArray() || targetsParam->items().empty()) {
    // An empty list would be a card that does nothing; say so instead of emitting a copy.
    return failConvert("badSignatureParams", "name", Json(std::string("targets")));
  }
  if (input.empty()) {
    // No columns to address: any target is out of range, which `resolveTarget` reports.
    return failConvert("badSignatureParams", "name", Json(std::string("targets")));
  }

  // ── Step 1: validate every target before touching a number ──
  std::vector<Target> targets;
  size_t count = targetsParam->items().size();
  targets.resize(count);
  for (size_t i = 0; i < count; ++i) {
    UnitConvertResult error;
    if (!resolveTarget(input, targetsParam->items()[i], &targets[i], &error)) return error;
  }
  // The last entry for a column wins; earlier ones are redundant, never cumulative (converting
  // twice in one card is not a chained conversion, it is a typo).
  std::map<size_t, size_t> byColumn;
  for (size_t i = 0; i < targets.size(); ++i) byColumn[targets[i].column] = i;

  // ── Step 2: the output IS the input table ──
  // Same width, same row count, every untouched column byte-identical (values and annotation).
  // A pass-through column is never resolved: an unconfirmed `temp_c` must survive a card that
  // does not touch it.
  UnitConvertResult result;
  result.columns = input;
  for (const auto& kv : byColumn) {
    const Target& target = targets[kv.second];
    Column& out = result.columns[target.column];
    const Column& source = input[target.column];
    out.data.resize(source.data.size());
    // LOCKED evaluation order: two left-to-right operations per value.
    //   out = (value * factorFrom) / factorTo
    // Precomputing `factorFrom / factorTo` would change the rounding (ppm→ppb of 2 must be
    // 1999.9999999999998, not 2000), so the ratio is never formed and fast-math stays off.
    for (size_t r = 0; r < source.data.size(); ++r) {
      const double value = source.data[r];
      const double scaled = value * target.from.factor;
      out.data[r] = scaled / target.to.factor;
    }
    out.posName = source.posName;
    out.annotation = rewriteUnitAnnotation(source.annotation, target.annotationResolution,
                                           target.to.unit);
  }
  return result;
}

// ── Unit warnings (L1b) ────────────────────────────────────────────────────────────────

Json unitWarningToJson(const UnitWarning& warning) {
  return Json::object({{"code", Json(warning.code)},
                       {"left", Json(warning.left)},
                       {"right", Json(warning.right)},
                       {"op", Json(warning.op)}});
}

namespace {

// The unit of one direct column operand, or nullptr when the column proves nothing.
// `label` is the flattened display label ("Pos.1 pressure_kpa"); labelParsed() is the same
// splitter the summary / unit-convert cards use, so the checker reads the annotation the
// way every other card does instead of inventing a second header grammar.
const UnitResolution* provableUnit(const std::vector<std::string>& labels,
                                   const std::vector<UnitResolution>& resolutions,
                                   const std::vector<bool>& resolvable, int64_t column) {
  if (column < 0 || static_cast<size_t>(column) >= labels.size()) return nullptr;
  if (!resolvable[static_cast<size_t>(column)]) return nullptr;
  const UnitResolution& r = resolutions[static_cast<size_t>(column)];
  if (r.state != UnitState::Recognized) return nullptr;
  // Affine/log/empirical units register with an empty dimension: they are labels, not
  // quantities, so "°C + kPa" is provable of nothing. Comparing them would warn on every
  // temperature column.
  if (r.dimension.empty()) return nullptr;
  return &r;
}

}  // namespace

std::vector<UnitWarning> checkExpressionUnitWarnings(
    const std::string& expression, const std::vector<std::string>& columnLabels,
    const std::vector<AliasRange>& aliases) {
  std::vector<UnitWarning> warnings;
  std::vector<ExprEngine::OperandPair> pairs;
  try {
    pairs = ExprEngine::operandPairs(expression, columnLabels, aliases);
  } catch (const ExpressionError&) {
    // An expression that does not parse has no provable operands. The caller already turned
    // that failure into an error state; the checker must not raise a second one.
    return warnings;
  }

  // Resolve every column once: the same column usually appears in several operators, and
  // resolveUnit walks the suffix grammar each time.
  std::vector<UnitResolution> resolutions(columnLabels.size());
  std::vector<bool> resolvable(columnLabels.size(), false);
  for (size_t i = 0; i < columnLabels.size(); ++i) {
    std::string posName;
    std::string annotation;
    Matrix::labelParsed(columnLabels[i], &posName, &annotation);
    resolutions[i] = resolveUnit(annotation);
    resolvable[i] = !annotation.empty();
  }

  auto labelOf = [&columnLabels](int64_t column) -> const std::string& {
    return columnLabels[static_cast<size_t>(column)];
  };

  for (const auto& pair : pairs) {
    const UnitResolution* left = provableUnit(columnLabels, resolutions, resolvable, pair.leftColumn);
    const UnitResolution* right =
        provableUnit(columnLabels, resolutions, resolvable, pair.rightColumn);
    if (left == nullptr || right == nullptr) continue;
    if (left->dimension == right->dimension) continue;
    UnitWarning warning;
    warning.code = "unitMismatch";
    warning.left = labelOf(pair.leftColumn);
    warning.right = labelOf(pair.rightColumn);
    warning.op = pair.op;
    warnings.push_back(std::move(warning));
  }
  return warnings;
}

}  // namespace dc
