// Auto-convert fixtures (units L2b) — the C++ referee for web/tests/fixtures/units/auto-convert.json,
// the same file web/tests/unitsAutoConvert.test.ts judges the TS reference with.
//
// What the tier is allowed to do is narrow on purpose, and every clause of it has a case here:
//
//   * an `auto` policy converts a `+`/`-` pair of two DIRECT column operands when both carry a
//     convertible unit of the SAME dimension and the units differ, as
//     `value * factorRight / factorLeft` (two left-to-right operations, never a ratio);
//   * cross-dimension NEVER converts (the warning path reports it instead);
//   * `strict`, `free`, an absent request and any unknown policy never convert;
//   * nested, function-wrapped, negated and literal operands never convert.
//
// The property that matters most is not any single number but that the plain `evaluate()`
// — the function every existing card calls — is UNCHANGED. `runCase` therefore evaluates each
// case twice through the no-policy path and requires both to equal `expectDefault` bit for
// bit, then requires `expected` only from the auto path.
//
// The node-level property (source matrices are never rewritten) is checked separately in
// `runNodeChecks`: the real `builtin:expression-columns` card recomputes the same input table
// under `auto` and the source revision and bytes must be exactly what they were.
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

// Bit-for-bit: NaN == NaN, ±Infinity equal to themselves, everything else exact. "Close
// enough" would let a reordered multiplication pass, which is exactly what L2b forbids.
bool sameNumber(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  if (a == 0.0 && b == 0.0) return std::signbit(a) == std::signbit(b);
  return a == b;
}

std::string numbersText(const std::vector<double>& values) {
  std::string out = "[";
  char buffer[64];
  for (size_t i = 0; i < values.size(); ++i) {
    if (i != 0) out += ",";
    std::snprintf(buffer, sizeof(buffer), "%.17g", values[i]);
    out += buffer;
  }
  return out + "]";
}

bool sameValues(const std::vector<double>& got, const std::vector<double>& want) {
  if (got.size() != want.size()) return false;
  for (size_t i = 0; i < got.size(); ++i) {
    if (!sameNumber(got[i], want[i])) return false;
  }
  return true;
}

std::vector<double> jsonNumbers(const Json& array) {
  std::vector<double> out;
  for (const Json& v : array.items()) out.push_back(v.asNumber());
  return out;
}

// The unit context a case describes: `columnUnits[i]` names a canonical registry unit or "".
ExprEngine::AutoConvertContext contextFor(const Json& c) {
  ExprEngine::AutoConvertContext ctx;
  for (const Json& unit : c["columnUnits"].items()) {
    const std::string name = unit.isString() ? unit.asString() : std::string();
    UnitCandidate candidate;
    if (name.empty() || !candidateByUnit(name, &candidate)) {
      ctx.columnUnits.push_back("");
      ctx.columnDimensions.push_back("");
      ctx.columnFactors.push_back(0.0);
      continue;
    }
    ctx.columnUnits.push_back(candidate.unit);
    ctx.columnDimensions.push_back(candidate.dimension);
    ctx.columnFactors.push_back(candidate.factor);
  }
  return ctx;
}

void runCase(const Json& c) {
  const std::string name = c["name"].asString();
  std::vector<std::string> labels;
  std::vector<std::vector<double>> data;
  for (const Json& column : c["columns"].items()) {
    Column col;
    col.posName = column["posName"].isString() ? column["posName"].asString() : "Pos.1";
    col.annotation = column["annotation"].isString() ? column["annotation"].asString() : "";
    col.data = jsonNumbers(column["data"]);
    labels.push_back(Matrix::label(col));
    data.push_back(col.data);
  }
  size_t rows = 0;
  for (const auto& column : data) rows = std::max(rows, column.size());

  // The fixture expressions use the qualified port spelling; the node layer registers both
  // the declaration letter and the port id.
  const std::vector<AliasRange> aliases = {AliasRange{"A", 0, labels.size()},
                                           AliasRange{"src", 0, labels.size()}};
  const std::string expression = c["expression"].asString();
  const std::vector<double> expectedDefault = jsonNumbers(c["expectDefault"]);
  const std::vector<double> expected = jsonNumbers(c["expect"]);

  const std::string policy = c.find("policy") != nullptr && c["policy"].isString()
                                 ? c["policy"].asString()
                                 : std::string();
  const bool isAuto = policy == "auto";

  // ── 1. the no-policy path is unchanged, twice over ──
  const std::vector<double> plain = ExprEngine::evaluate(expression, labels, data, rows, aliases);
  check(sameValues(plain, expectedDefault),
        name + ": evaluate() returned " + numbersText(plain) + ", expected " +
            numbersText(expectedDefault));
  // A request that is NOT 'auto' takes the identical path — numbers and the conversion list.
  if (!isAuto) {
    ExprEngine::AutoConvertRequest request;
    request.policy = policy;
    request.context = contextFor(c);
    std::vector<ExprEngine::UnitConversion> conversions;
    const std::vector<double> other =
        ExprEngine::evaluateAuto(expression, labels, data, rows, aliases, &request, &conversions);
    check(sameValues(other, expectedDefault),
          name + ": a non-auto policy ('" + policy + "') changed the numbers to " +
              numbersText(other));
    check(conversions.empty(), name + ": a non-auto policy reported a conversion");
  }

  // ── 2. the auto path produces exactly what the fixture says ──
  // `expect` is the value UNDER THE CASE'S OWN POLICY, so it is only compared for `auto`
  // cases; a non-auto case has already been proven above to ignore the request entirely.
  ExprEngine::AutoConvertRequest request;
  request.policy = "auto";
  request.context = contextFor(c);
  std::vector<ExprEngine::UnitConversion> conversions;
  const std::vector<double> auto_ =
      ExprEngine::evaluateAuto(expression, labels, data, rows, aliases, &request, &conversions);
  if (isAuto) {
    check(sameValues(auto_, expected),
          name + ": auto returned " + numbersText(auto_) + ", expected " + numbersText(expected));
  }
  // A non-auto case is not required to produce an empty conversion list HERE: the request
  // built above is this test saying "auto", not the case's own tier. Its guarantee is the one
  // proven in step 1 — under its own policy it neither converts nor reports a conversion.

  // ── 3. the conversion report (auto cases only — see step 2) ──
  if (!isAuto) return;
  const Json& wantConversions = c["conversions"];
  check(wantConversions.isArray(), name + ": fixture has no conversions array");
  const auto& want = wantConversions.items();
  check(conversions.size() == want.size(),
        name + ": reported " + std::to_string(conversions.size()) + " conversion(s), expected " +
            std::to_string(want.size()));
  for (size_t i = 0; i < want.size() && i < conversions.size(); ++i) {
    const ExprEngine::UnitConversion& got = conversions[i];
    check(static_cast<double>(got.pair) == want[i]["pair"].asNumber(),
          name + ": conversion " + std::to_string(i) + " has pair " + std::to_string(got.pair));
    check(sameNumber(got.factor, want[i]["factor"].asNumber()),
          name + ": conversion " + std::to_string(i) + " has factor " + numbersText({got.factor}));
    check(got.fromUnit == want[i]["fromUnit"].asString(),
          name + ": conversion " + std::to_string(i) + " from '" + got.fromUnit + "'");
    check(got.toUnit == want[i]["toUnit"].asString(),
          name + ": conversion " + std::to_string(i) + " to '" + got.toUnit + "'");
  }
}

// The card-level property the fixture cannot state: an `auto` card derives a NEW table and
// leaves its source matrix byte-identical (same revision, same data). "Never rewrite the
// source" is the whole reason this tier is opt-in.
void runNodeChecks() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);
  std::vector<Column> columns;
  // `height_km` / `height_cm` are UNAMBIGUOUS tokens: a single-letter or colliding suffix
  // (`m`, `mm`, `ms`) resolves to `ambiguous` and therefore proves nothing — the tier never
  // converts what the header does not prove, and neither does this test.
  columns.push_back(Column{"Pos.1", "height_km", {1.0, 2.0}});
  columns.push_back(Column{"Pos.2", "height_cm", {150.0, 200.0}});
  Matrix source(std::move(columns));
  const int64_t sourceId = store.insert(source);
  int64_t beforeRevision = -1;
  store.withMatrix(sourceId, [&](const Matrix& m) { beforeRevision = m.revision; });

  PortBinding binding;
  binding.portId = "src";
  binding.varName = "src";
  binding.mode = "matrix";
  binding.sourceMatrixId = sourceId;

  Json formula = Json::object({{"name", Json("out")},
                               {"expression", Json(std::string("src.pos.1 + src.pos.2"))}});
  Json params = Json::object();
  params.set("formulas", Json::array({formula}));

  auto created = nodes.createV2(kSigExpressionColumns, {binding}, params);
  check(created.nodeId > 0 && created.errorCode.empty(),
        std::string("auto card could not be created (") + created.errorCode + ")");
  if (created.nodeId <= 0) return;
  nodes.computeNow(created.nodeId);
  const auto node = nodes.get(created.nodeId);
  check(node.has_value(), "auto card vanished");
  if (!node) return;
  check(node->state == NodeState::Done,
        std::string("default policy must stay done, got ") + nodeName(node->state));

  Matrix result;
  if (node->resultMatrixIds.empty()) {
    check(false, "auto card produced no result matrix");
    return;
  }
  check(store.snapshot(node->resultMatrixIds[0], &result), "auto card produced no result");
  if (result.columnCount() == 1) {
    const std::vector<double> expected = {151.0, 202.0};
    check(sameValues(result.column(0).data, expected),
          "default policy must compute the plain sum, got " +
              numbersText(result.column(0).data));
  }

  // ── the same table under `unitPolicy: "auto"` derives a converted copy ──
  Json autoParams = Json::object();
  Json autoFormula = Json::object({{"name", Json("out")},
                                   {"expression", Json(std::string("src.pos.1 + src.pos.2"))}});
  autoParams.set("formulas", Json::array({autoFormula}));
  autoParams.set("unitPolicy", Json(std::string("auto")));
  auto createdAuto = nodes.createV2(kSigExpressionColumns, {binding}, autoParams);
  check(createdAuto.nodeId > 0 && createdAuto.errorCode.empty(),
        std::string("auto-policy card could not be created (") + createdAuto.errorCode + ")");
  if (createdAuto.nodeId > 0) {
    nodes.computeNow(createdAuto.nodeId);
    const auto autoNode = nodes.get(createdAuto.nodeId);
    check(autoNode.has_value() && autoNode->state == NodeState::Done,
          "auto policy must leave the card done");
    if (autoNode) {
      Matrix autoResult;
      if (autoNode->resultMatrixIds.empty()) {
        check(false, "auto-policy card produced no result matrix");
      } else {
        check(store.snapshot(autoNode->resultMatrixIds[0], &autoResult),
              "auto-policy card produced no result");
      }
      if (autoResult.columnCount() == 1) {
        // The right operand is converted to the LEFT operand's unit (km): 150 cm = 0.0015 km,
        // 200 cm = 0.002 km, added to 1 km and 2 km.
        const std::vector<double> expected = {1.0015, 2.002};
        check(sameValues(autoResult.column(0).data, expected),
              "auto policy must convert the right operand, got " +
                  numbersText(autoResult.column(0).data));
      }
    }
    bool autoDependents = false;
    nodes.remove(createdAuto.nodeId, &autoDependents);
  }

  // ── `strict` and `free` produce exactly the default numbers ──
  for (const char* policy : {"strict", "free"}) {
    Json tierParams = Json::object();
    tierParams.set("formulas", Json::array({formula}));
    tierParams.set("unitPolicy", Json(std::string(policy)));
    auto createdTier = nodes.createV2(kSigExpressionColumns, {binding}, tierParams);
    check(createdTier.nodeId > 0, std::string("tier card failed for ") + policy);
    if (createdTier.nodeId <= 0) continue;
    nodes.computeNow(createdTier.nodeId);
    Matrix tierResult;
    const auto tierNode = nodes.get(createdTier.nodeId);
    const bool hasResult = tierNode.has_value() && !tierNode->resultMatrixIds.empty();
    check(hasResult, std::string("policy '") + policy + "' produced no result matrix");
    if (hasResult) {
      check(store.snapshot(tierNode->resultMatrixIds[0], &tierResult) &&
                tierResult.columnCount() == 1 &&
                sameValues(tierResult.column(0).data, {151.0, 202.0}),
            std::string("policy '") + policy + "' must compute the plain sum");
    }
    bool tierDependents = false;
    nodes.remove(createdTier.nodeId, &tierDependents);
  }

  // The source is untouched: same revision, same bytes.
  int64_t afterRevision = -1;
  Matrix after;
  const bool sourceAlive = store.withMatrix(sourceId, [&](const Matrix& m) {
    afterRevision = m.revision;
    after = m;
  });
  check(sourceAlive, "source matrix vanished");
  check(beforeRevision == afterRevision,
        "the card advanced the source revision from " + std::to_string(beforeRevision) + " to " +
            std::to_string(afterRevision));
  check(after.columnCount() == 2 && sameValues(after.column(1).data, {150.0, 200.0}) &&
            after.column(1).annotation == "height_cm",
        "the card rewrote the source column");
}

/**
 * The strongest statement this tier has to make: for a table the project already treats as a
 * golden case (xlayer `expression.v1.json`), the AUTO policy must not move a single number of
 * any expression it has no provable conversion for. The fixture's columns carry their own unit
 * context only when a case supplies one, so this check runs WITHOUT any unit context for the
 * auto policy: "auto + nothing provable" must equal "no policy at all", bit for bit.
 */
void runXlayerParity(const std::string& path) {
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
  int compared = 0;
  for (const Json& testCase : root["cases"].items()) {
    if (!testCase["expression"].isString() || !testCase["columns"].isArray()) continue;
    std::vector<std::string> labels;
    std::vector<std::vector<double>> data;
    size_t rows = 1;
    for (const Json& column : testCase["columns"].items()) {
      const std::string name =
          column["name"].isString() ? column["name"].asString() : std::string("Pos.1");
      labels.push_back(name);
      std::vector<double> values;
      if (column["data"].isArray()) {
        for (const Json& v : column["data"].items()) values.push_back(v.asNumber());
      }
      rows = std::max(rows, values.size());
      data.push_back(std::move(values));
    }
    // The fixture also pins errors (unknown column, bad arity …): those cases have no unit
    // context to reproduce and belong to the error path, which the xlayer runner owns.
    if (testCase.find("error") != nullptr) continue;
    const std::string expression = testCase["expression"].asString();
    const std::string name = testCase["name"].isString() ? testCase["name"].asString() : expression;
    std::vector<double> plain;
    std::vector<double> tiered;
    // Expected failures are the error path's business: both calls must fail the same way,
    // which the fixtures already pin. Here only the successful evaluations are compared.
    bool plainOk = true;
    try {
      plain = ExprEngine::evaluate(expression, labels, data, rows);
    } catch (const ExpressionError&) {
      plainOk = false;
    }
    if (!plainOk) continue;
    // A context of the right SHAPE but no provable unit: every column is empty, so nothing is
    // convertible and `auto` has no operand pair it may touch.
    ExprEngine::AutoConvertRequest request;
    request.policy = "auto";
    request.context.columnUnits.assign(labels.size(), std::string());
    request.context.columnDimensions.assign(labels.size(), std::string());
    request.context.columnFactors.assign(labels.size(), 0.0);
    std::vector<ExprEngine::UnitConversion> conversions;
    try {
      tiered = ExprEngine::evaluateAuto(expression, labels, data, rows, {}, &request, &conversions);
    } catch (const ExpressionError&) {
      check(false, name + ": auto threw where evaluate() succeeded");
      continue;
    }
    ++compared;
    check(conversions.empty(), name + ": auto invented a conversion with no provable unit");
    check(sameValues(tiered, plain),
          name + ": auto changed " + numbersText(plain) + " into " + numbersText(tiered));
  }
  std::printf("xlayer parity (auto with no provable unit): %d expression(s)\n", compared);
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
    ++cases;
    runCase(c);
  }
  std::printf("units_autoconvert fixture: %d case(s)\n", cases);
}

}  // namespace

int main(int argc, char** argv) {
  runNodeChecks();
  if (argc < 2) {
    std::fprintf(stderr,
                 "usage: dc_units_autoconvert_test <auto-convert.json> [expression.v1.json]\n");
    return 2;
  }
  runFixture(argv[1]);
  // An optional second argument: the xlayer expression fixture, replayed under `auto` with no
  // provable unit, which must reproduce `evaluate()` exactly.
  if (argc > 2) runXlayerParity(argv[2]);
  if (g_failures != 0) {
    std::printf("FAILED: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("PASS units_autoconvert\n");
  return 0;
}