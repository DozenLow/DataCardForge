#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "chart_analysis.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

namespace {

int failures = 0;

void check(bool ok, const std::string& message) {
  if (ok) return;
  ++failures;
  std::printf("FAIL %s\n", message.c_str());
}

bool near(double actual, double expected, double tolerance = 1e-6) {
  return std::isfinite(actual) && std::abs(actual - expected) <= tolerance;
}

double value(const std::vector<Column>& columns, const std::string& name, size_t row = 0) {
  for (const Column& column : columns) {
    if (column.annotation == name && row < column.data.size()) return column.data[row];
  }
  return NAN;
}

Json params(const std::string& model,
            const std::string& weighting = "none") {
  Json out = Json::object();
  out.set("model", Json(model));
  out.set("weighting", Json(weighting));
  return out;
}

Json numberArray(const std::vector<double>& values) {
  Json out = Json::array();
  for (double value : values) out.push(Json(value));
  return out;
}

void testLinearFits() {
  const std::vector<double> x = {1, 2, 3, 4, 5};
  const std::vector<double> y = {5, 7, 9, 11, 13};
  const ChartAnalysisResult result = evaluateChartAnalysis(&x, y, params("linear"));
  check(result.errorCode.empty(), "OLS linear fit succeeds");
  check(near(value(result.summary, "slope"), 2.0), "OLS slope");
  check(near(value(result.summary, "intercept"), 3.0), "OLS intercept");
  check(near(value(result.summary, "r2"), 1.0), "OLS r2");
  check(near(value(result.summary, "lod"), 0.0), "exact-fit LOD is zero");
  check(result.series.size() == 11, "series output has the fixed diagnostic width");
  check(near(value(result.series, "fitted", 2), 9.0), "pointwise fitted values");
  check(near(value(result.series, "residual", 2), 0.0), "pointwise residuals");
  check(std::isfinite(value(result.series, "qqTheoretical", 0)), "QQ theoretical quantile");

  Json origin = params("linear");
  origin.set("throughOrigin", Json(true));
  const std::vector<double> originY = {2, 4, 6, 8, 10};
  const ChartAnalysisResult forced = evaluateChartAnalysis(&x, originY, origin);
  check(forced.errorCode.empty(), "through-origin fit succeeds");
  check(near(value(forced.summary, "slope"), 2.0), "through-origin slope");
  check(near(value(forced.summary, "intercept"), 0.0), "through-origin intercept is zero");
}

void testWeightedFit() {
  const std::vector<double> x = {1, 2, 3, 4};
  const std::vector<double> y = {2, 4, 20, 8};
  const ChartAnalysisResult result =
      evaluateChartAnalysis(&x, y, params("linear", "inverseX"));
  check(result.errorCode.empty(), "weighted fit succeeds");
  check(near(value(result.summary, "slope"), 4.172413793103452, 1e-9),
        "inverse-X weighting uses the weighted normal equations");
  check(near(value(result.summary, "intercept"), -1.9310344827586245, 1e-9),
        "weighted intercept");

  const ChartAnalysisResult inverseSquare =
      evaluateChartAnalysis(&x, y, params("linear", "inverseX2"));
  check(inverseSquare.errorCode.empty(), "inverse-X-squared fit succeeds");
  check(near(value(inverseSquare.summary, "slope"), 4.512820512820511, 1e-9),
        "inverse-X-squared slope");
  check(near(value(inverseSquare.summary, "intercept"), -2.584615384615377, 1e-9),
        "inverse-X-squared intercept");
  const double sigma = value(result.summary, "residualStandardError");
  const double slope = value(result.summary, "slope");
  check(near(value(result.summary, "lod"), 3.3 * sigma / std::abs(slope), 1e-9),
        "LOD derives from residual standard error and slope");
  check(near(value(result.summary, "loq"), 10.0 * sigma / std::abs(slope), 1e-9),
        "LOQ derives from residual standard error and slope");

  const std::vector<double> zeroX = {0, 1, 2, 3, 4};
  const ChartAnalysisResult invalid =
      evaluateChartAnalysis(&zeroX, {0, 1, 2, 3, 4}, params("linear", "inverseX"));
  check(invalid.errorCode == "fitFailed", "non-positive weighted X is a fit error");
  check(invalid.errorParams["reason"].asString() == "nonPositiveX",
        "weight refusal reason is structured");
}

void testNonlinearFits() {
  const std::vector<double> x = {0, 1, 2, 3, 4};
  std::vector<double> exponential;
  for (double value : x) exponential.push_back(2.5 * std::exp(0.45 * value));
  Json expParams = params("exponential");
  expParams.set("initial", numberArray({2.2, 0.3}));
  expParams.set("lower", numberArray({0.1, -2.0}));
  expParams.set("upper", numberArray({10.0, 2.0}));
  const ChartAnalysisResult exp = evaluateChartAnalysis(&x, exponential, expParams);
  check(exp.errorCode.empty(), "bounded exponential fit succeeds");
  check(near(value(exp.summary, "a"), 2.5, 2e-4), "exponential amplitude");
  check(near(value(exp.summary, "b"), 0.45, 2e-5), "exponential rate");

  const std::vector<double> positiveX = {1, 2, 3, 4, 5, 6};
  std::vector<double> power;
  for (double value : positiveX) power.push_back(3.0 * value * value);
  Json powerParams = params("power");
  powerParams.set("initial", numberArray({2.5, 1.7}));
  powerParams.set("lower", numberArray({0.1, 0.0}));
  powerParams.set("upper", numberArray({10.0, 5.0}));
  const ChartAnalysisResult powerFit =
      evaluateChartAnalysis(&positiveX, power, powerParams);
  check(powerFit.errorCode.empty(), "bounded power fit succeeds");
  check(near(value(powerFit.summary, "a"), 3.0, 2e-4), "power amplitude");
  check(near(value(powerFit.summary, "b"), 2.0, 2e-5), "power exponent");

  const std::vector<double> logisticX = {0.1, 0.3, 0.6, 1, 2, 4, 8, 16};
  std::vector<double> logisticY;
  for (double value : logisticX) {
    const double ratio = std::pow(value / 2.0, -1.8);
    logisticY.push_back(1.0 + 8.0 / (1.0 + ratio));
  }
  Json logisticParams = params("4pl");
  logisticParams.set("initial", numberArray({0.5, 9.5, 1.7, 1.5}));
  logisticParams.set("lower", numberArray({-2.0, 5.0, 0.05, 0.1}));
  logisticParams.set("upper", numberArray({4.0, 15.0, 20.0, 8.0}));
  const ChartAnalysisResult logistic =
      evaluateChartAnalysis(&logisticX, logisticY, logisticParams);
  check(logistic.errorCode.empty(), "bounded 4PL fit succeeds");
  check(near(value(logistic.summary, "a"), 1.0, 5e-3), "4PL bottom");
  check(near(value(logistic.summary, "b"), 9.0, 5e-3), "4PL top");
  check(near(value(logistic.summary, "c"), 2.0, 5e-3), "4PL midpoint");
  check(near(value(logistic.summary, "d"), 1.8, 5e-3), "4PL hill");
}

void testStructuredFailures() {
  const std::vector<double> x = {1, 2, 3};
  Json bad = params("power");
  bad.set("initial", numberArray({1}));
  const ChartAnalysisResult wrongCount = evaluateChartAnalysis(&x, {1, 2, 3}, bad);
  check(wrongCount.errorCode == "badSignatureParams", "wrong initial count is a parameter error");
  check(wrongCount.errorParams["reason"].asString() == "initial",
        "initial failure names the field");

  const std::vector<double> constantX = {2, 2, 2};
  const ChartAnalysisResult singular =
      evaluateChartAnalysis(&constantX, {1, 2, 3}, params("linear"));
  check(singular.errorCode == "fitFailed", "singular linear design is not a plausible line");

  Json power = params("power");
  power.set("initial", numberArray({1, 1}));
  power.set("lower", numberArray({0.1, 0}));
  power.set("upper", numberArray({0.2, 2}));
  const std::vector<double> invalidX = {-1, 0, 3};
  const ChartAnalysisResult impossible =
      evaluateChartAnalysis(&invalidX, {-1, -2, -3}, power);
  check(impossible.errorCode == "fitFailed", "unfit nonlinear data fails explicitly");
}

void testNodeOutputs() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);
  Column xc;
  xc.posName = "Pos.1";
  xc.data = {1, 2, 3, 4, 5};
  Column yc;
  yc.posName = "Pos.2";
  yc.data = {4, 6, 8, 10, 12};
  const int64_t matrix = store.insert(Matrix{{xc, yc}});

  PortBinding xb;
  xb.portId = "x";
  xb.varName = "x";
  xb.mode = "cell";
  xb.sourceMatrixId = matrix;
  xb.columnIndex = 0;
  PortBinding yb;
  yb.portId = "y";
  yb.varName = "y";
  yb.mode = "cell";
  yb.sourceMatrixId = matrix;
  yb.columnIndex = 1;
  const auto created =
      nodes.createV2(kSigChartAnalysis, {xb, yb}, params("linear"));
  check(created.nodeId > 0, "chart analysis signature registers");
  const auto dirty = nodes.get(created.nodeId);
  check(dirty && dirty->state == NodeState::Dirty, "chart analysis is explicit-compute");
  nodes.computeNow(created.nodeId);
  const auto done = nodes.get(created.nodeId);
  check(done && done->state == NodeState::Done, "chart analysis node computes");
  check(done && done->resultMatrixIds.size() == 2, "chart analysis publishes K=2");
  Matrix summary;
  Matrix series;
  check(done && store.snapshot(done->resultMatrixIds[0], &summary), "summary matrix exists");
  check(done && store.snapshot(done->resultMatrixIds[1], &series), "series matrix exists");
  check(summary.columnCount() == 14, "summary output schema is stable");
  check(series.columnCount() == 11 && series.rowCount() == 5,
        "diagnostic series aligns to five fitted observations");
}

}  // namespace

int main() {
  testLinearFits();
  testWeightedFit();
  testNonlinearFits();
  testStructuredFailures();
  testNodeOutputs();
  if (failures != 0) {
    std::printf("%d chart-analysis checks failed\n", failures);
    return 1;
  }
  std::printf("chart analysis: all checks passed\n");
  return 0;
}
