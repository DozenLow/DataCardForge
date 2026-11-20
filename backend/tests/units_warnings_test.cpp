// Unit WARNING fixtures (units L1b / B1) — the C++ referee.
//
// Reads web/tests/fixtures/units/warnings.json and requires the static checker
// (`dc::checkExpressionUnitWarnings`, units.cpp) to produce EXACTLY the listed warnings for
// each card's expression — same length, same order, same code/left/right/op. `[]` means the
// checker must stay silent, which is the half of the contract that is easy to get wrong: a
// checker that warns on an ambiguous token ("mm" is `mm` or `mM`) or on a nested operand is
// worse than no checker, because it trains the user to dismiss the warning bar.
//
// Two properties beyond the shared fixture, because the fixture (a JSON file) cannot state
// them:
//
//   1. ADDITIVE. A warning never changes the numbers, the error code or the state: every
//      case here must still compute the same values the expression engine produces on its
//      own, and must end in `done` — not `error`, not `dirty`.
//   2. DTO SHAPE. The node carries the warnings as a JSON array of `{code,left,right,op}`
//      (+ the 0-based `formula` index), and a card with nothing to report carries an EMPTY
//      array — absent from the HTTP DTO, so existing clients and fixtures see no new field.
//
// A case that cannot parse is not a warning case: the parser's error belongs to the error
// path (xlayer fixtures own it), so the checker must stay silent there rather than raise a
// second failure.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "expression.h"
#include "json.h"
#include "matrix_store.h"
#include "nodes.h"
#include "signature.h"
#include "units.h"

using namespace dc;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
  if (!ok) {
    ++g_failures;
    std::printf("FAIL %s\n", what.c_str());
  }
}

bool sameNumber(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  if (!std::isfinite(a) || !std::isfinite(b)) return a == b;
  return a == b;
}

std::string warningsText(const Json& warnings) {
  if (!warnings.isArray()) return "<not an array>";
  return warnings.dump();
}

// The fixture's table, built as one Matrix. Labels are flattened exactly the way the node
// layer flattens them ("Pos.1 pressure_kpa"), because that string is what the checker parses.
Matrix makeMatrix(const Json& columns, std::vector<std::string>* labels) {
  std::vector<Column> cols;
  for (const Json& c : columns.items()) {
    Column column;
    column.posName = c["posName"].isString() ? c["posName"].asString() : "Pos.1";
    column.annotation = c["annotation"].isString() ? c["annotation"].asString() : "";
    for (const Json& v : c["data"].items()) column.data.push_back(v.asNumber());
    labels->push_back(Matrix::label(column));
    cols.push_back(std::move(column));
  }
  return Matrix(std::move(cols));
}

// Compare the produced warnings against the fixture's expected list, in order.
bool warningsMatch(const Json& produced, const Json& expected, const std::string& name,
                   std::string* why) {
  if (!produced.isArray()) {
    *why = "warnings is not an array";
    return false;
  }
  const auto& want = expected.items();
  const auto& got = produced.items();
  if (got.size() != want.size()) {
    *why = "warned " + std::to_string(got.size()) + " time(s), expected " +
           std::to_string(want.size());
    return false;
  }
  for (size_t i = 0; i < want.size(); ++i) {
    for (const char* field : {"code", "left", "right", "op"}) {
      const Json* gotField = got[i].find(field);
      if (!gotField || !gotField->isString() ||
          gotField->asString() != want[i][field].asString()) {
        *why = std::string("warning ") + std::to_string(i) + " field '" + field + "' is '" +
               (gotField && gotField->isString() ? gotField->asString() : std::string("<missing>")) +
               "', expected '" + want[i][field].asString() + "'";
        return false;
      }
    }
  }
  (void)name;
  return true;
}

// One case through the REAL node path (builtin:expression-columns), so the warnings are
// judged where the user sees them and not only inside the checker.
void runCaseThroughNode(const Json& c, const std::string& name) {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);

  std::vector<std::string> labels;
  Matrix matrix = makeMatrix(c["columns"], &labels);
  const int64_t matrixId = store.insert(std::move(matrix));

  PortBinding binding;
  binding.portId = "src";
  binding.varName = "src";
  binding.mode = "matrix";
  binding.sourceMatrixId = matrixId;

  const std::string expression = c["expression"].asString();
  Json formula = Json::object({{"name", Json("out")}, {"expression", Json(expression)}});
  Json params = Json::object();
  params.set("formulas", Json::array({formula}));

  auto created = nodes.createV2(kSigExpressionColumns, {binding}, params);
  check(created.nodeId > 0 && created.errorCode.empty() && created.cyclePath.empty(),
        name + ": card could not be created (" + created.errorCode + ")");
  if (created.nodeId <= 0) return;
  nodes.computeNow(created.nodeId);

  const auto node = nodes.get(created.nodeId);
  check(node.has_value(), name + ": node vanished");
  if (!node) return;

  // ── 1. the warnings themselves ──
  std::string why;
  if (!warningsMatch(node->warnings, c["expectWarnings"], name, &why)) {
    check(false, name + ": " + why + " (got " + warningsText(node->warnings) + ")");
  }

  // ── 2. additive: state, codes and numbers are exactly the expression engine's ──
  check(node->state == NodeState::Done,
        name + ": state became " + nodeName(node->state) + " (a warning must never change it)");
  check(node->errorCode.empty(), name + ": errorCode became '" + node->errorCode + "'");

  Matrix produced;
  const bool found = store.snapshot(node->resultMatrixIds[0], &produced);
  check(found && produced.columnCount() == 1, name + ": result matrix is missing");
  if (found && produced.columnCount() == 1) {
    // The same labels, evaluated directly: the node's numbers must be bit-identical.
    std::vector<std::vector<double>> data;
    for (const Json& column : c["columns"].items()) {
      std::vector<double> values;
      for (const Json& v : column["data"].items()) values.push_back(v.asNumber());
      data.push_back(std::move(values));
    }
    // The node layer registers both the declaration letter (`A`) and the port id
    // (`varName`); the fixture expressions use the qualified port spelling.
    std::vector<AliasRange> aliases;
    aliases.push_back(AliasRange{"A", 0, labels.size()});
    aliases.push_back(AliasRange{"src", 0, labels.size()});
    const size_t rows = produced.column(0).data.size();
    const std::vector<double> direct = ExprEngine::evaluate(expression, labels, data, rows, aliases);
    bool same = direct.size() == produced.column(0).data.size();
    for (size_t r = 0; same && r < direct.size(); ++r) {
      same = sameNumber(direct[r], produced.column(0).data[r]);
    }
    check(same, name + ": a warning changed the numbers");
  }
}

void runFixture(const std::string& path) {
  std::ifstream in(path);
  if (!in) {
    std::printf("FAIL cannot open %s\n", path.c_str());
    ++g_failures;
    return;
  }
  std::stringstream buffer;
  buffer << in.rdbuf();
  Json root;
  std::string err;
  if (!Json::parse(buffer.str(), &root, &err)) {
    std::printf("FAIL bad JSON in %s: %s\n", path.c_str(), err.c_str());
    ++g_failures;
    return;
  }

  int cases = 0;
  for (const Json& c : root["cases"].items()) {
    const std::string name = c["name"].asString();
    ++cases;
    if (!c["expectWarnings"].isArray()) {
      check(false, name + ": fixture case has no expectWarnings array");
      continue;
    }
    runCaseThroughNode(c, name);
  }
  std::printf("units_warnings fixture: %d case(s)\n", cases);
}

// Direct checks of the checker's own contract that the fixture table (one card per shape)
// does not spell out: silence where nothing is provable, and one warning per operator.
void runCheckerChecks() {
  const std::vector<std::string> labels = {
      "Pos.1 pressure_kpa", "Pos.2 height_cm", "Pos.3 mass_kg",
      "Pos.4 time_min",     "Pos.5 temp_c",    "Pos.6 tensile_mpa",
      "Pos.7 sensor",
  };
  const std::vector<AliasRange> aliases = {{"A", 0, labels.size()}};

  // Non-scalar / label-only units carry no dimension: two of them prove nothing.
  check(checkExpressionUnitWarnings("A.pos.5 + A.pos.5", labels, aliases).empty(),
        "temp_c + temp_c (empty dimension) must not warn");
  // An ambiguous token is not a conclusion.
  check(checkExpressionUnitWarnings("A.pos.6 + A.pos.1", labels, aliases).empty(),
        "ambiguous operand must not warn");
  // A literal operand is not a column.
  check(checkExpressionUnitWarnings("A.pos.1 + 5", labels, aliases).empty(),
        "a numeric literal operand must not warn");
  // Unary minus is not a direct column reference.
  check(checkExpressionUnitWarnings("-A.pos.1 + A.pos.2", labels, aliases).empty(),
        "a negated operand must not warn");
  // * and / are not checked: unit algebra is not modelled in L1b.
  check(checkExpressionUnitWarnings("A.pos.1 * A.pos.4", labels, aliases).empty(),
        "multiplication must not warn");
  // One warning PER operator, in source order. `A + B + C` parses as `(A + B) + C`, so only
  // the inner pair has two DIRECT column operands — the outer one's left side is a
  // sub-expression and stays silent (that is the nested rule, applied to the same line).
  const auto chained = checkExpressionUnitWarnings("A.pos.1 + A.pos.2 + A.pos.3", labels, aliases);
  check(chained.size() == 1, "A + B + C must warn once, for the inner pair only");
  if (chained.size() == 1) {
    check(chained[0].op == "+" && chained[0].left == "Pos.1 pressure_kpa" &&
              chained[0].right == "Pos.2 height_cm",
          "the inner pair of a chain must be the one reported");
  }
  // Independent operators each get their own warning, in source order.
  const auto two =
      checkExpressionUnitWarnings("(A.pos.1 + A.pos.2) * (A.pos.3 - A.pos.4)", labels, aliases);
  check(two.size() == 2, "two independent operators must produce two warnings");
  if (two.size() == 2) {
    check(two[0].op == "+" && two[0].left == "Pos.1 pressure_kpa" &&
              two[0].right == "Pos.2 height_cm",
          "the first warning must describe the first operator");
    check(two[1].op == "-" && two[1].left == "Pos.3 mass_kg" &&
              two[1].right == "Pos.4 time_min",
          "the second warning must describe the second operator");
  }
  // An unparsable expression is the error path's business, not the checker's.
  check(checkExpressionUnitWarnings("A.pos.1 <> nonsense", labels, aliases).empty(),
        "an unparsable expression must yield no warnings");
  // The bare (unqualified) spelling resolves to the same column as the qualified one.
  const auto bare = checkExpressionUnitWarnings("pressure_kpa + time_min", labels, aliases);
  check(bare.size() == 1, "bare column names must be checked like qualified ones");
  if (bare.size() == 1) {
    check(bare[0].left == "Pos.1 pressure_kpa" && bare[0].right == "Pos.4 time_min",
          "bare-name warning must name both column labels");
  }
  // The DTO shape is exactly {code,left,right,op}.
  const Json dto =
      unitWarningToJson(UnitWarning{"unitMismatch", "Pos.1 a_m", "Pos.2 b_s", "+"});
  check(dto.members().size() == 4 && dto["code"].asString() == "unitMismatch" &&
            dto["left"].asString() == "Pos.1 a_m" && dto["right"].asString() == "Pos.2 b_s" &&
            dto["op"].asString() == "+",
        "unitWarningToJson must carry exactly code/left/right/op");
}

}  // namespace

int main(int argc, char** argv) {
  runCheckerChecks();
  if (argc < 2) {
    std::fprintf(stderr, "usage: dc_units_warnings_test <warnings.json>\n");
    return 2;
  }
  for (int i = 1; i < argc; ++i) runFixture(argv[i]);
  if (g_failures != 0) {
    std::printf("FAILED: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("PASS units_warnings\n");
  return 0;
}