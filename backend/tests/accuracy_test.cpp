// accuracy_test.cpp — the on-demand accuracy estimate must agree with what the engine
// actually published, and must decline rather than guess when it cannot.
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "accuracy.h"
#include "json.h"
#include "matrix_store.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

static int failures = 0;

#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);   \
      ++failures;                                                  \
    }                                                              \
  } while (0)

static Json expressionParams(const std::string& name, const std::string& expression) {
  Json formulas = Json::array();
  formulas.push(Json::object({{"name", Json(name)}, {"expression", Json(expression)}}));
  return Json::object({{"formulas", std::move(formulas)}});
}

int main() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);

  // A column of measurements centred at 1e6 with a 1e-3 spread: the shape that destroys
  // the textbook sum-of-squares variance formula while leaving the two-pass one intact.
  const size_t n = 5000;
  Column c;
  c.posName = "Pos.1";
  c.annotation = "A";
  c.data.resize(n);
  for (size_t i = 0; i < n; ++i) {
    const double t = static_cast<double>(i) / static_cast<double>(n) - 0.5;
    c.data[i] = 1e6 + 1e-4 + t * 2e-3;
  }
  const int64_t m = store.insert(Matrix({c}));

  PortBinding binding;
  binding.portId = "src";
  binding.varName = "A";
  binding.mode = "matrix";
  binding.sourceMatrixId = m;

  // 1) builtin VAR — two-pass, so a coherent rescale of the data barely moves it.
  const auto good = nodes.createV2(kSigExpressionColumns, {binding},
                                   expressionParams("v", "VAR(A)"));
  CHECK(good.nodeId > 0);
  nodes.recomputeSubtree(good.nodeId);
  const AccuracyReport goodReport = checkAccuracy(&nodes, &store, good.nodeId);
  std::printf("VAR(A)        status=%s digits=%.1f gap=%.2e reason=%s\n",
              goodReport.status.c_str(), goodReport.digits, goodReport.relativeGap,
              goodReport.reason.c_str());
  CHECK(goodReport.status == "ok");

  // 2) The textbook formula on the same column — two ~5e15 intermediates cancelling to a
  //    1e-3 answer. Feeding the SAME values in a different row order changes only the
  //    rounding, and that rounding is the whole answer, so the jitter is enormous.
  const auto bad = nodes.createV2(
      kSigExpressionColumns, {binding},
      expressionParams("v", "(SUM(A*A) - COUNT(A)*AVG(A)*AVG(A)) / (COUNT(A)-1)"));
  CHECK(bad.nodeId > 0);
  nodes.recomputeSubtree(bad.nodeId);
  const AccuracyReport badReport = checkAccuracy(&nodes, &store, bad.nodeId);
  std::printf("naive ss      status=%s digits=%.1f gap=%.2e reason=%s\n",
              badReport.status.c_str(), badReport.digits, badReport.relativeGap,
              badReport.reason.c_str());
  CHECK(badReport.status == "degraded");
  CHECK(badReport.digits < 8.0);
  CHECK(badReport.relativeGap > 1e-6);

  // 3) A chained input must decline: this measurement is node-local and would be blind to
  //    inherited error. "unsupported" is the honest answer, and the client renders nothing.
  const auto chained = nodes.create({binding}, "A * 2");
  CHECK(chained.nodeId > 0);
  nodes.recomputeSubtree(chained.nodeId);
  PortBinding fromNode;
  fromNode.portId = "src";
  fromNode.varName = "A";
  fromNode.mode = "matrix";
  fromNode.sourceNodeId = chained.nodeId;
  const auto downstream = nodes.create({fromNode}, "A + 1");
  CHECK(downstream.nodeId > 0);
  nodes.recomputeSubtree(downstream.nodeId);
  const AccuracyReport chainReport = checkAccuracy(&nodes, &store, downstream.nodeId);
  std::printf("chained input status=%s reason=%s\n", chainReport.status.c_str(),
              chainReport.reason.c_str());
  CHECK(chainReport.status == "unsupported");
  CHECK(chainReport.reason == "chainedInput");

  // 4) A node that has never been computed has nothing to estimate.
  const auto idle = nodes.createV2(kSigSummary, {binding}, Json::object());
  CHECK(idle.nodeId > 0);
  const AccuracyReport idleReport = checkAccuracy(&nodes, &store, idle.nodeId);
  CHECK(idleReport.status == "unsupported");
  std::printf("not computed  status=%s reason=%s\n", idleReport.status.c_str(),
              idleReport.reason.c_str());

  // 5) MOV/EMA read their neighbours: permuting the rows changes the ANSWER, not just the
  //    rounding, so any "gap" measured there would be a false alarm.
  const auto smoothed =
      nodes.createV2(kSigExpressionColumns, {binding}, expressionParams("v", "MOV(A, 3)"));
  CHECK(smoothed.nodeId > 0);
  nodes.recomputeSubtree(smoothed.nodeId);
  const AccuracyReport movReport = checkAccuracy(&nodes, &store, smoothed.nodeId);
  std::printf("MOV(A, 3)     status=%s reason=%s\n", movReport.status.c_str(),
              movReport.reason.c_str());
  CHECK(movReport.status == "unsupported");
  CHECK(movReport.reason == "orderDependent");

  std::printf("%s\n", failures == 0 ? "accuracy: ok" : "accuracy: FAILED");
  return failures == 0 ? 0 : 1;
}
