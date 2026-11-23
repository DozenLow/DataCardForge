// Advanced math capability — first capability-card gate.
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <string>
#include <vector>

#include "expression.h"
#include "matrix_store.h"
#include "matrix_value.h"
#include "nodes.h"
#include "signature.h"

using namespace dc;

static int failures = 0;

#define CHECK(cond) \
  do { \
    if (!(cond)) { \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      ++failures; \
    } \
  } while (0)

static void clearAdvancedMathEnv() {
#ifdef _WIN32
  _putenv_s("DC_ADVANCED_MATH", "");
#else
  ::unsetenv("DC_ADVANCED_MATH");
#endif
}

static void enableAdvancedMath() {
#ifdef _WIN32
  _putenv_s("DC_ADVANCED_MATH", "1");
#else
  ::setenv("DC_ADVANCED_MATH", "1", 1);
#endif
}

static std::vector<std::string> names() { return {"A"}; }

int main() {
  const std::vector<std::vector<double>> cols{{1.0, 2.0, 3.0}};

  clearAdvancedMathEnv();
  try {
    (void)ExprEngine::evaluate("COMBIN(10, 4)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "unknownFunction");
  }

  try {
    (void)ExprEngine::evaluate("\"abc\"", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "unexpectedChar");
  }

  enableAdvancedMath();
  CHECK(ExprEngine::advancedMathEnabled());
  const auto comb = ExprEngine::evaluate("COMBIN(10, 4)", names(), cols, 3);
  CHECK(comb == std::vector<double>({210.0, 210.0, 210.0}));
  const auto perm = ExprEngine::evaluate("PERMUT(10, 4)", names(), cols, 3);
  CHECK(perm == std::vector<double>({5040.0, 5040.0, 5040.0}));

  const auto sumSquares = ExprEngine::evaluate("SUM(i*i, i, 1, 4)", names(), cols, 3);
  CHECK(sumSquares == std::vector<double>({30.0, 30.0, 30.0}));
  const auto factorial = ExprEngine::evaluate("PRODUCT(i, i, 1, 5)", names(), cols, 3);
  CHECK(factorial == std::vector<double>({120.0, 120.0, 120.0}));
  const auto nested = ExprEngine::evaluate(
      "SUM(SUM(i, i, 1, 2) + i, i, 1, 2)", names(), cols, 3);
  CHECK(nested == std::vector<double>({9.0, 9.0, 9.0}));
  // Dependent inner bounds resolve through the lexical stack, not AST substitution.
  const auto triangular = ExprEngine::evaluate(
      "SUM(SUM(i*j, j, 1, i), i, 1, 3)", names(), cols, 3);
  CHECK(triangular == std::vector<double>({25.0, 25.0, 25.0}));
  const auto nestedIntegral = ExprEngine::evaluate(
      "SUM(INTEGRAL(x*i, x, 0, 1), i, 1, 3)", names(), cols, 3);
  CHECK(std::fabs(nestedIntegral[0] - 3.0) < 1e-9);
  const auto integral = ExprEngine::evaluate("INTEGRAL(x*x, x, 0, 1)", names(), cols, 3);
  CHECK(std::fabs(integral[0] - 1.0 / 3.0) < 1e-10);
  const auto derivative = ExprEngine::evaluate("DERIV(x*x, x, 3)", names(), cols, 3);
  CHECK(std::fabs(derivative[0] - 6.0) < 1e-6);

  const std::vector<double> samples = {1.0, 2.0, 3.0, 4.0};
  const std::vector<std::vector<double>> statsCols{{1.0, 2.0, 3.0, 4.0}};
  const auto varS = ExprEngine::evaluate("VAR.S(A)", {"A"}, statsCols, 4);
  CHECK(std::fabs(varS[0] - 5.0 / 3.0) < 1e-12);
  const std::vector<std::vector<double>> one{{5.0}};
  const auto varSingle = ExprEngine::evaluate("VAR.S(A)", {"A"}, one, 1);
  CHECK(std::isnan(varSingle[0]));
  const auto varP = ExprEngine::evaluate("VAR.P(A)", {"A"}, statsCols, 4);
  CHECK(std::fabs(varP[0] - 1.25) < 1e-12);
  const auto stdevS = ExprEngine::evaluate("STDEV.S(A)", {"A"}, statsCols, 4);
  CHECK(std::fabs(stdevS[0] - std::sqrt(5.0 / 3.0)) < 1e-12);
  const auto percentileInc = ExprEngine::evaluate("PERCENTILE.INC(A, 0.25)", {"A"}, statsCols, 4);
  CHECK(std::fabs(percentileInc[0] - 1.75) < 1e-12);
  const auto percentileExc = ExprEngine::evaluate("PERCENTILE.EXC(A, 0.25)", {"A"}, statsCols, 4);
  CHECK(std::fabs(percentileExc[0] - 1.25) < 1e-12);

  const std::vector<std::vector<double>> relation{{1.0, 2.0, 3.0}, {2.0, 4.0, 6.0}};
  const auto correl = ExprEngine::evaluate("CORREL(A, B)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(correl[0] - 1.0) < 1e-12);
  const auto covarianceS = ExprEngine::evaluate("COVARIANCE.S(A, B)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(covarianceS[0] - 2.0) < 1e-12);
  const auto covarianceP = ExprEngine::evaluate("COVARIANCE.P(A, B)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(covarianceP[0] - 4.0 / 3.0) < 1e-12);
  const auto slope = ExprEngine::evaluate("SLOPE(B, A)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(slope[0] - 2.0) < 1e-12);
  const auto intercept = ExprEngine::evaluate("INTERCEPT(B, A)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(intercept[0]) < 1e-12);
  const auto rsq = ExprEngine::evaluate("RSQ(A, B)", {"A", "B"}, relation, 3);
  CHECK(std::fabs(rsq[0] - 1.0) < 1e-12);

  // Degenerate columns: RSQ must refuse exactly like CORREL (frozen: RSQ = corr^2).
  const std::vector<std::vector<double>> constY{{1.0, 2.0, 3.0}, {5.0, 5.0, 5.0}};
  const auto rsqConstY = ExprEngine::evaluate("RSQ(B, A)", {"A", "B"}, constY, 3);
  CHECK(std::isnan(rsqConstY[0]));
  const auto correlConstY = ExprEngine::evaluate("CORREL(A, B)", {"A", "B"}, constY, 3);
  CHECK(std::isnan(correlConstY[0]));
  const auto slopeConstX = ExprEngine::evaluate("SLOPE(B, A)", {"A", "B"},
                                                std::vector<std::vector<double>>{{7.0, 7.0, 7.0}, {1.0, 2.0, 3.0}}, 3);
  CHECK(std::isnan(slopeConstX[0]));

  const std::vector<std::vector<double>> irrCols{{-100.0, 110.0}};
  const auto irr = ExprEngine::evaluate("IRR(A)", {"A"}, irrCols, 2);
  CHECK(std::fabs(irr[0] - 0.1) < 1e-12);
  try {
    (void)ExprEngine::evaluate("IRR(A)", {"A"}, {{100.0, 110.0}}, 2);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "domainError");
  }

  const std::vector<std::vector<double>> criteriaCols{{1.0, 2.0, 3.0, 4.0}};
  const auto countIf = ExprEngine::evaluate("COUNTIF(A, \">2\")", {"A"}, criteriaCols, 4);
  CHECK(countIf == std::vector<double>({2.0, 2.0, 2.0, 2.0}));
  const auto sumIf = ExprEngine::evaluate("SUMIF(A, \">2\")", {"A"}, criteriaCols, 4);
  CHECK(sumIf == std::vector<double>({7.0, 7.0, 7.0, 7.0}));
  const auto countIfNumber = ExprEngine::evaluate("COUNTIF(A, 2)", {"A"}, criteriaCols, 4);
  CHECK(countIfNumber == std::vector<double>({1.0, 1.0, 1.0, 1.0}));
  const auto countIfNotEqual = ExprEngine::evaluate("COUNTIF(A, \"<>2\")", {"A"}, criteriaCols, 4);
  CHECK(countIfNotEqual == std::vector<double>({3.0, 3.0, 3.0, 3.0}));

  // Numeric criteria keep full double precision (regression: std::to_string round-trip
  // rewrote 0.123456789 to 0.123457 and 1e-9 to 0, silently comparing the wrong number).
  const std::vector<std::vector<double>> precise{{0.123456789}};
  const auto countPrecise = ExprEngine::evaluate("COUNTIF(A, 0.123456789)", {"A"}, precise, 1);
  CHECK(countPrecise == std::vector<double>({1.0}));
  const std::vector<std::vector<double>> tiny{{1e-9}};
  const auto countTiny = ExprEngine::evaluate("COUNTIF(A, 0.000000001)", {"A"}, tiny, 1);
  CHECK(countTiny == std::vector<double>({1.0}));
  const auto sumPrecise = ExprEngine::evaluate("SUMIF(A, 0.123456789)", {"A"}, precise, 1);
  CHECK(std::fabs(sumPrecise[0] - 0.123456789) < 1e-15);

  // Strings are criteria data, not values: arithmetic on them must refuse, not NaN.
  try {
    (void)ExprEngine::evaluate("1+\"abc\"", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "domainError");
  }
  try {
    (void)ExprEngine::evaluate("\"abc\"", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "domainError");
  }
  const auto sumIfThree = ExprEngine::evaluate("SUMIF(A, \">2\", B)", {"A", "B"},
                                               std::vector<std::vector<double>>{{1,2,3,4},{10,20,30,40}}, 4);
  CHECK(sumIfThree == std::vector<double>({70.0, 70.0, 70.0, 70.0}));

  try {
    (void)ExprEngine::evaluate("PERCENTILE.INC(A, 2)", {"A"}, statsCols, 4);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "domainError");
  }

  try {
    (void)ExprEngine::evaluate("SUM(SUM(i, i, 1, 1000000), i, 1, 2)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "budgetExceeded");
    CHECK(e.budgetLimit == 1000000);
  }

  try {
    const std::vector<double> integralRows(101, 1.0);
    (void)ExprEngine::evaluate("INTEGRAL(1, x, 0, 1)", {"A"}, {integralRows}, 101);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "budgetExceeded");
    CHECK(e.budgetActual == 1010101);
  }

  try {
    const std::vector<std::vector<double>> manyRows{{1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0}};
    (void)ExprEngine::evaluate("SUM(i, i, 1, 100000)", {"A"}, manyRows, 11);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "budgetExceeded");
    CHECK(e.budgetLimit == 1000000);
    CHECK(e.budgetActual == 1100000);
  }

  try {
    (void)ExprEngine::evaluate("COMBIN(10.5, 2)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "domainError");
  }

  try {
    (void)ExprEngine::evaluate("SUM(i, i, 1, 1000001)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "budgetExceeded");
    CHECK(e.budgetLimit == 1000000);
    CHECK(e.budgetActual == 1000001);
  }

  try {
    (void)ExprEngine::evaluate("COMBIN(1000001, 2)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "budgetExceeded");
  }

  try {
    (void)ExprEngine::evaluate("PERMUT(1024, 1024)", names(), cols, 3);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "numericOverflow");
  }

  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);
  Column sourceColumn;
  sourceColumn.posName = "Pos.1";
  sourceColumn.annotation = "A";
  sourceColumn.data = {1.0};
  const int64_t matrixId = store.insert(Matrix({sourceColumn}));
  PortBinding binding;
  binding.portId = "src";
  binding.varName = "A";
  binding.mode = "matrix";
  binding.sourceMatrixId = matrixId;
  Json formulas = Json::array();
  formulas.push(Json::object({{"name", Json("budget")},
                              {"expression", Json("SUM(i, i, 1, 1000001)")}}));
  const auto created = nodes.createV2(
      kSigExpressionColumns, {binding}, Json::object({{"formulas", std::move(formulas)}}));
  CHECK(created.nodeId > 0);
  nodes.recomputeSubtree(created.nodeId);
  const auto budgetNode = nodes.get(created.nodeId);
  CHECK(budgetNode && budgetNode->state == NodeState::Error);
  CHECK(budgetNode && budgetNode->errorCode == "budgetExceeded");
  CHECK(budgetNode && budgetNode->errorParams["limit"].asNumber() == 1000000);
  CHECK(budgetNode && budgetNode->errorParams["actual"].asNumber() == 1000001);
  CHECK(budgetNode && budgetNode->errorParams["name"].asString() == "SUM");

  try {
    int64_t rows = -1;
    int64_t columns = -1;
    (void)ExprEngine::evaluateMatrix("SUM(i, i, 1, 2)", {}, {}, &rows, &columns);
    CHECK(false);
  } catch (const ExpressionError& e) {
    CHECK(e.code == "unsupportedFunctionMode");
  }

  clearAdvancedMathEnv();
  if (failures == 0) {
    std::puts("advanced_math: all checks passed");
    return 0;
  }
  return 1;
}
