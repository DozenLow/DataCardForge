#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

#include "chart_filter.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

namespace {

constexpr double kPi = 3.14159265358979323846;
int failures = 0;

void check(bool ok, const std::string& message) {
  if (ok) return;
  ++failures;
  std::printf("FAIL %s\n", message.c_str());
}

double value(const std::vector<Column>& columns, const std::string& name, size_t row = 0) {
  for (const Column& column : columns) {
    if (column.annotation == name && row < column.data.size()) return column.data[row];
  }
  return NAN;
}

const std::vector<double>* values(const std::vector<Column>& columns,
                                  const std::string& name) {
  for (const Column& column : columns) {
    if (column.annotation == name) return &column.data;
  }
  return nullptr;
}

Json lowpass(double cutoff, int order, double sampleRate = NAN) {
  Json out = Json::object();
  out.set("mode", Json(std::string("lowpass")));
  out.set("cutoffHz", Json(cutoff));
  out.set("order", Json(static_cast<int64_t>(order)));
  if (std::isfinite(sampleRate)) out.set("sampleRateHz", Json(sampleRate));
  return out;
}

void testLowPass() {
  const size_t n = 400;
  std::vector<double> x(n);
  std::vector<double> raw(n);
  std::vector<double> desired(n);
  for (size_t index = 0; index < n; ++index) {
    const double t = static_cast<double>(index) / 100.0;
    x[index] = t;
    desired[index] = std::sin(2.0 * kPi * 5.0 * t);
    raw[index] = desired[index] + 0.6 * std::sin(2.0 * kPi * 30.0 * t);
  }
  const ChartFilterResult result =
      evaluateChartFilter(&x, raw, lowpass(10.0, 4));
  check(result.errorCode.empty(), "regular-X low pass succeeds");
  check(std::abs(value(result.summary, "sampleRateHz") - 100.0) < 1e-9,
        "sample rate is inferred from X");
  const std::vector<double>* filtered = values(result.series, "filtered");
  check(filtered && filtered->size() == n, "low pass preserves row count");
  if (filtered) {
    double rawError = 0.0;
    double filteredError = 0.0;
    for (size_t index = 30; index + 30 < n; ++index) {
      const double rawDelta = raw[index] - desired[index];
      const double filteredDelta = (*filtered)[index] - desired[index];
      rawError += rawDelta * rawDelta;
      filteredError += filteredDelta * filteredDelta;
    }
    check(std::sqrt(filteredError / (n - 60)) <
              0.3 * std::sqrt(rawError / (n - 60)),
          "low pass strongly attenuates the high-frequency component");
    int bestLag = 0;
    double bestCorrelation = -std::numeric_limits<double>::infinity();
    for (int lag = -5; lag <= 5; ++lag) {
      double correlation = 0.0;
      for (size_t index = 40; index + 40 < n; ++index) {
        const size_t filteredIndex =
            static_cast<size_t>(static_cast<long>(index) + lag);
        correlation += desired[index] * (*filtered)[filteredIndex];
      }
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }
    check(bestLag == 0, "zero-phase filter keeps the highest correlation at lag zero");
  }

  const ChartFilterResult withoutX =
      evaluateChartFilter(nullptr, raw, lowpass(10.0, 2, 100.0));
  check(withoutX.errorCode.empty(), "row-index data accepts an explicit sample rate");
  check(std::abs(value(withoutX.summary, "sampleRateHz") - 100.0) < 1e-12,
        "explicit sample rate is reported");
  const std::vector<double>* rowIndex = values(withoutX.series, "x");
  check(rowIndex && rowIndex->front() == 1.0 && rowIndex->back() == 400.0,
        "implicit row X follows the chart's one-based No.N contract");
}

void testDetrend() {
  const std::vector<double> x = {0, 0.5, 1, 1.5, 2, 2.5, 3};
  std::vector<double> y;
  for (double value : x) y.push_back(4.0 + 3.0 * value);
  Json params = Json::object();
  params.set("mode", Json(std::string("detrend")));
  const ChartFilterResult result = evaluateChartFilter(&x, y, params);
  check(result.errorCode.empty(), "linear detrend succeeds");
  check(std::abs(value(result.summary, "trendSlope") - 3.0) < 1e-12,
        "detrend publishes the linear slope");
  const std::vector<double>* filtered = values(result.series, "filtered");
  check(filtered &&
            std::all_of(filtered->begin(), filtered->end(),
                        [](double v) { return std::abs(v) < 1e-12; }),
        "detrending an exact line leaves numerical zero");

  const std::vector<double> irregular = {0, 0.2, 0.9, 1.7, 3.4};
  std::vector<double> irregularY;
  for (double value : irregular) irregularY.push_back(2.0 - 0.5 * value);
  const ChartFilterResult irregularFit =
      evaluateChartFilter(&irregular, irregularY, params);
  check(irregularFit.errorCode.empty(), "detrend allows a non-uniform finite X");
}

void testFailures() {
  const std::vector<double> y(100, 1.0);
  const std::vector<double> irregular = [] {
    std::vector<double> x;
    for (int index = 0; index < 100; ++index) {
      x.push_back(static_cast<double>(index) * (index == 50 ? 1.01 : 1.0));
    }
    return x;
  }();
  const ChartFilterResult grid =
      evaluateChartFilter(&irregular, y, lowpass(1.0, 4, 100.0));
  check(grid.errorCode == "filterFailed", "irregular X fails explicitly");
  check(grid.errorParams["reason"].asString() == "nonUniformX",
        "irregular X identifies the reason");

  const ChartFilterResult nyquist =
      evaluateChartFilter(nullptr, y, lowpass(60.0, 4, 100.0));
  check(nyquist.errorCode == "filterFailed", "cutoff above Nyquist is refused");
  Json badOrder = lowpass(10.0, 0, 100.0);
  const ChartFilterResult order =
      evaluateChartFilter(nullptr, y, badOrder);
  check(order.errorCode == "badSignatureParams", "invalid order is a parameter error");
}

void testNodeOutputs() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);
  Column y;
  y.posName = "Pos.1";
  y.data = std::vector<double>(100, 0.0);
  const int64_t matrix = store.insert(Matrix{{y}});
  PortBinding binding;
  binding.portId = "y";
  binding.varName = "y";
  binding.mode = "cell";
  binding.sourceMatrixId = matrix;
  binding.columnIndex = 0;
  const auto created =
      nodes.createV2(kSigChartFilter, {binding}, lowpass(10.0, 2, 100.0));
  check(created.nodeId > 0, "chart filter signature registers without an X port");
  nodes.computeNow(created.nodeId);
  const auto node = nodes.get(created.nodeId);
  check(node && node->state == NodeState::Done, "chart filter node computes");
  check(node && node->resultMatrixIds.size() == 2, "chart filter has fixed K=2");
}

}  // namespace

int main() {
  testLowPass();
  testDetrend();
  testFailures();
  testNodeOutputs();
  if (failures != 0) {
    std::printf("%d chart-filter checks failed\n", failures);
    return 1;
  }
  std::printf("chart filter: all checks passed\n");
  return 0;
}
