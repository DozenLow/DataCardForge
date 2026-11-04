// kappa_probe_test.cpp — P0 prototype. Not shipped, not wired into the product.
//
// The question this answers, before any UI or API is written:
//
//   Can a perturbation of the LEAF data measure the end-to-end condition number of a
//   multi-node chain — and does per-node local verification really miss it?
//
// The chain is the one that motivated the whole investigation, expressed exactly as the
// engine runs it (two nodes, with a double materialized in between):
//
//   node 1:  n1 = AVG(A)            <- n1 is stored as a double: this is the truncation point
//   node 2:  n2 = N1 - 1000000      <- a scalar expression over node 1's output
//
// Node 2's own arithmetic is EXACT: subtracting two doubles of similar magnitude is exact
// (Sterbenz), so a per-node dd check must report "15 digits". Yet the chain is wrong,
// because node 1's rounding error arrives already amplified by the subtraction.
//
// Nothing here touches backend/src. If this test cannot demonstrate the gap, the design is
// wrong and the feature should not be built.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <random>
#include <vector>

#include "dd_oracle.h"
#include "expression.h"

namespace {

constexpr double kU = std::numeric_limits<double>::epsilon() / 2.0;
int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

// Node 1: the aggregation. Its result is a double, and that double is all node 2 ever sees.
double step1(const std::vector<double>& col) {
  const std::vector<double> out = dc::ExprEngine::evaluate("AVG(A)", {"A"}, {col}, 1);
  return out.empty() ? NAN : out[0];
}

// Node 2: a scalar expression over node 1's output, evaluated through the same engine the
// product uses (so this is not a hand-written "- 1e6" that might behave differently).
double step2(double n1) {
  const std::vector<double> out =
      dc::ExprEngine::evaluate("N1 - 1000000", {"N1"}, {{n1}}, 1);
  return out.empty() ? NAN : out[0];
}

double chain(const std::vector<double>& col) { return step2(step1(col)); }

// The exact value of the whole chain, computed in double-double. This is the truth the
// FP64 chain is judged against — it is *not* available at runtime, which is the entire
// reason a perturbation estimate is interesting.
dd::DD exactChain(const std::vector<double>& col) {
  const dd::DD mean = dd::div(oracle::sum(col), dd::fromDouble(static_cast<double>(col.size())));
  return dd::sub(mean, dd::fromDouble(1e6));
}

// What a per-node checker sees: node 1's OUTPUT as a double, then "is this step accurate?"
// In dd, (double n1) - 1e6 is exact, so the answer is always "yes".
double localErrorOfStep2(double n1) {
  const dd::DD ref = dd::sub(dd::fromDouble(n1), dd::fromDouble(1e6));
  return dd::relDiff(dd::fromDouble(step2(n1)), ref);
}

// Coherent perturbation: EVERY element scaled by the same factor. This measures the
// worst-case relative condition number — for a sum that is the direction in which nothing
// cancels.
//
// A per-element random sign was tried first and is WRONG here: the signs cancel inside the
// sum, so the mean moves by only ~delta/sqrt(n). It reported kappa = 4.8e7 against a true
// 1.0e10 — a factor of sqrt(n). Recorded because a first implementation will make exactly
// this mistake, and it fails in the safe-looking direction (under-estimates the danger).
std::vector<double> scaleAll(const std::vector<double>& a, double relative) {
  std::vector<double> out(a.size());
  for (size_t i = 0; i < a.size(); ++i) out[i] = a[i] * (1.0 + relative);
  return out;
}

// Central difference on the relative perturbation, so the second-order term cancels.
template <typename Fn>
double conditionNumber(Fn&& run, double base, const std::vector<double>& a, double delta) {
  if (base == 0.0) return std::numeric_limits<double>::infinity();
  const double hi = run(scaleAll(a, delta));
  const double lo = run(scaleAll(a, -delta));
  if (!std::isfinite(hi) || !std::isfinite(lo)) return std::numeric_limits<double>::infinity();
  return std::fabs((hi - lo) / base) / (2.0 * delta);
}

void line(const char* label, double value, const char* fmt) {
  char buf[64];
  std::snprintf(buf, sizeof buf, fmt, value);
  std::printf("  %-34s %s\n", label, buf);
}

}  // namespace

int main() {
  const size_t n = 100000;
  const double delta = 1e-8;

  // 1e6 centre, 1e-3 spread, shifted by 1e-4 so the chain's answer is a controlled ~1e-4
  // rather than whatever the sample mean happens to be.
  std::mt19937_64 gen(20261104ULL);
  std::vector<double> a(n);
  for (size_t i = 0; i < n; ++i) {
    const double u = static_cast<double>(gen() >> 11) * (1.0 / 9007199254740992.0);
    a[i] = 1e6 + 1e-4 + (u - 0.5) * 2e-3;
  }

  std::printf("chain:  n1 = AVG(A)   ->   n2 = n1 - 1000000\n");
  std::printf("data :  %zu rows centred at 1e6 + 1e-4, spread +/-1e-3\n\n", n);

  const double n1 = step1(a);
  const double n2 = step2(n1);
  const dd::DD exact = exactChain(a);
  const double trueRel = dd::relDiff(dd::fromDouble(n2), exact);
  const double localRel = localErrorOfStep2(n1);

  line("n1 (double, node 1 output)", n1, "%.17g");
  line("n2 (double, node 2 output)", n2, "%.17g");
  line("n2 exact (double-double)", exact.hi, "%.17g");
  line("true relative error of chain", trueRel, "%.3e");
  line("  => digits left (true)", -std::log10(trueRel), "%.1f");
  line("local dd check of node 2", localRel, "%.3e");
  line("  => digits left (local check)", localRel > 0 ? -std::log10(localRel) : 16.0, "%.1f");

  const double kappa = conditionNumber([&](const std::vector<double>& p) { return chain(p); },
                                       n2, a, delta);
  const double kappaControl =
      conditionNumber([&](const std::vector<double>& p) { return step1(p); }, n1, a, delta);

  line("kappa, whole chain (perturbed)", kappa, "%.3e");
  line("kappa, node 1 alone (control)", kappaControl, "%.3e");
  std::printf("\n");

  line("kappa * u                (bound)", kappa * kU, "%.3e");
  line("kappa * sqrt(n) * u      (bound)", kappa * std::sqrt(static_cast<double>(n)) * kU, "%.3e");
  std::printf("\n");

  // 1) The blind spot exists: node 2's own arithmetic is exact, so a per-node check is
  //    blind even though the chain lost almost everything.
  CHECK(localRel < 1e-15);
  CHECK(-std::log10(localRel > 0 ? localRel : 1e-300) -
            -std::log10(trueRel > 0 ? trueRel : 1e-300) >
        5.0);

  // 2) The perturbation sees it, and sees nothing where there is nothing: node 1 alone has
  //    a condition number near 1.
  CHECK(kappa > 1e9);
  CHECK(kappaControl < 10.0);

  // 3) The chain really is broken, not merely amplified in theory.
  CHECK(trueRel > 1e-6);

  // 4) Loose consistency: kappa alone UNDER-predicts, because a naive n-term sum carries
  //    its own backward error of about sqrt(n)*u. The product should land within two
  //    orders of the measured truth — the point is that the correction direction is right,
  //    not that the estimate is tight.
  const double predicted = kappa * std::sqrt(static_cast<double>(n)) * kU;
  CHECK(predicted > trueRel / 100.0 && predicted < trueRel * 100.0);

  std::printf("%s\n", failures == 0 ? "P0 OK: perturbation sees the chain, local check does not."
                                    : "P0 FAILED: the design does not hold.");
  return failures == 0 ? 0 : 1;
}
