// dd_oracle_test.cpp — does the FP64 engine actually deliver FP64 accuracy?
//
// This is not a correctness test in the usual "expected vs actual" sense: a matrix inverse
// has no single right answer to compare against. It is an ACCURACY audit. For each
// computation it answers one question:
//
//     how much of double's 15.9 digits did the shipped code actually keep?
//
// The reference is double-double (~106 bits, u ≈ 1e-32) from dd.h / dd_oracle.cpp, so the
// reference itself is ~15 digits better than anything it is judging. The oracle mirrors
// src/'s *algorithms* on purpose (same two-pass variance, same R-7 quantile, same LU), so
// the measured difference is arithmetic and nothing else.
//
// Three verdict classes, because treating them alike is the classic way to "fix" a
// conditioning problem forever:
//   GATED      well-conditioned case: exceeding the theoretical bound is a bug → exit 1
//   REPORTED   ill-conditioned case: large error is the problem's, not the code's
//   THROWING   exactly singular input: the engine must refuse, not return garbage
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <random>
#include <string>
#include <vector>

#include "dd_oracle.h"
#include "expression.h"
#include "matrix_value.h"

namespace {

constexpr double kU = std::numeric_limits<double>::epsilon() / 2.0;  // 1.110e-16
constexpr double kDdU = 1e-32;                                       // dd's noise floor

int failures = 0;

// ── result table ──────────────────────────────────────────────────────

struct Row {
  std::string op;
  std::string shape;
  double relErr = 0.0;   // measured |fp64 - dd| / |dd|, worst element
  double bound = 0.0;    // theoretical bound; 0 ⇒ not gated
  double kappa = 0.0;    // ∞-norm condition number; 0 ⇒ not applicable
  bool gated = false;
  bool passed = true;
  std::string note;
};

std::vector<Row>& table() {
  static std::vector<Row> rows;
  return rows;
}

// gamma_k = k·u / (1 - k·u): the classical bound for a length-k dot product.
double gamma(int64_t k) {
  const double ku = static_cast<double>(k) * kU;
  return ku / (1.0 - ku);
}

void record(const std::string& op, const std::string& shape, double relErr, double bound,
            double kappa, bool gated, const std::string& note = {}) {
  Row r;
  r.op = op;
  r.shape = shape;
  r.relErr = relErr;
  r.bound = bound;
  r.kappa = kappa;
  r.gated = gated;
  r.note = note;
  r.passed = !gated || !(relErr > bound);
  table().push_back(r);
  if (!r.passed) {
    ++failures;
    std::printf("FAIL %-16s %-22s rel=%.3e exceeds bound %.3e\n", op.c_str(),
                shape.c_str(), relErr, bound);
  }
}

// ── deterministic data (a test that changes shape between runs is not a test) ──

struct Rng {
  std::mt19937_64 gen{0x5eed1234ULL};
  double uni(double lo, double hi) {
    // 53 random bits → exact double in [0,1); implementation-independent, unlike
    // std::uniform_real_distribution.
    const double bits = static_cast<double>(gen() >> 11);
    return lo + (hi - lo) * (bits * (1.0 / 9007199254740992.0));
  }
};

// Column-major, matching MatVal's wire order.
std::vector<double> randomMat(Rng& rng, int64_t rows, int64_t cols, double lo, double hi) {
  std::vector<double> m(static_cast<size_t>(rows * cols));
  for (double& x : m) x = rng.uni(lo, hi);
  return m;
}

std::vector<double> hilbert(int64_t n) {
  std::vector<double> m(static_cast<size_t>(n * n));
  for (int64_t j = 0; j < n; ++j) {
    for (int64_t i = 0; i < n; ++i) {
      m[static_cast<size_t>(j * n + i)] = 1.0 / static_cast<double>(i + j + 1);
    }
  }
  return m;
}

dc::MatVal toMatVal(const std::vector<double>& flat, int64_t rows, int64_t cols) {
  return dc::MatVal::fromFlat(flat.data(), rows, cols);
}

// The FP64 aggregation path exactly as src/summary.cpp calls it: one column, name "A",
// broadcast length 1, so the scalar lands in slot 0.
double engineAgg(const char* expr, const std::vector<double>& col) {
  const std::vector<double> out = dc::ExprEngine::evaluate(expr, {"A"}, {col}, 1);
  return out.empty() ? std::numeric_limits<double>::quiet_NaN() : out[0];
}

// ── matrix cases ──────────────────────────────────────────────────────

void caseMatmulRandom(int64_t n) {
  Rng rng;
  const std::vector<double> A = randomMat(rng, n, n, -1.0, 1.0);
  const std::vector<double> B = randomMat(rng, n, n, -1.0, 1.0);

  const std::vector<double> got =
      dc::MatVal::matmul(toMatVal(A, n, n), toMatVal(B, n, n)).toColumnMajor();
  const oracle::DMat ref =
      oracle::matMul(oracle::fromDoubles(A, n, n), oracle::fromDoubles(B, n, n));

  double worst = 0.0;
  for (size_t k = 0; k < got.size(); ++k) {
    worst = std::max(worst, dd::relDiff(dd::fromDouble(got[k]), ref.v[k]));
  }

  // Componentwise bound: |C_ij - Ĉ_ij| <= gamma_n · Σ_k |A_ik B_kj|, expressed relative.
  double worstBound = 0.0;
  for (int64_t j = 0; j < n; ++j) {
    for (int64_t i = 0; i < n; ++i) {
      double sumAbs = 0.0;
      for (int64_t k = 0; k < n; ++k) {
        sumAbs += std::fabs(A[static_cast<size_t>(k * n + i)] * B[static_cast<size_t>(j * n + k)]);
      }
      const double mag = std::fabs(ref.at(i, j).hi);
      if (mag > 0.0) worstBound = std::max(worstBound, gamma(n) * (sumAbs / mag));
    }
  }
  record("matmul", "n=" + std::to_string(n), worst, 16.0 * worstBound + 64.0 * kU, 0.0, true);
}

// The case that makes the point: 1023 terms of magnitude 1/3 whose sum is 1e-8. Every
// partial sum is O(170), so a rounding error of one ulp up there is a 1e-5 relative error
// down here. (A first draft used ±1, which measured exactly zero: ±1 summed with ±1 is an
// exact integer, so FP64 made no error at all. The cancellation has to be built on values
// that cannot be represented exactly, or it demonstrates nothing.)
void caseMatmulCancellation() {
  const int64_t n = 1023;
  const double third = 1.0 / 3.0;
  std::vector<double> a(static_cast<size_t>(n), 1.0);
  std::vector<double> b(static_cast<size_t>(n), -third);
  for (int64_t i = 0; i < 511; ++i) b[static_cast<size_t>(i)] = third;
  b[static_cast<size_t>(n - 1)] = 1e-8;  // what is left after the two halves cancel

  const std::vector<double> got =
      dc::MatVal::matmul(toMatVal(a, 1, n), toMatVal(b, n, 1)).toColumnMajor();
  const oracle::DMat ref =
      oracle::matMul(oracle::fromDoubles(a, 1, n), oracle::fromDoubles(b, n, 1));
  const double err = dd::relDiff(dd::fromDouble(got[0]), ref.at(0, 0));

  // Bound: gamma_n · Σ|a b| / |s| ≈ 1e-13 · 341 / 1e-8 — i.e. "this answer is meaningless".
  const double bound = gamma(n) * (511.0 * (2.0 / 3.0) / std::fabs(ref.at(0, 0).hi));
  record("matmul", "cancel n=1023", err, bound, 0.0, false,
         "1023 terms of 1/3, sum is 1e-8");
}

void caseSolveRandom(int64_t n) {
  Rng rng;
  std::vector<double> A = randomMat(rng, n, n, -1.0, 1.0);
  for (int64_t i = 0; i < n; ++i) A[static_cast<size_t>(i * n + i)] += static_cast<double>(n);
  std::vector<double> b = randomMat(rng, n, 1, -1.0, 1.0);

  std::vector<double> got;
  try {
    got = dc::MatVal::solve(toMatVal(A, n, n), toMatVal(b, n, 1)).toColumnMajor();
  } catch (const std::exception& e) {
    std::printf("FAIL solve n=%lld threw: %s\n", static_cast<long long>(n), e.what());
    ++failures;
    return;
  }

  bool singular = false;
  const oracle::DMat oa = oracle::fromDoubles(A, n, n);
  const oracle::DMat ref = oracle::solve(oa, oracle::fromDoubles(b, n, 1), &singular);

  double forward = 0.0;
  for (size_t k = 0; k < got.size(); ++k) {
    forward = std::max(forward, dd::relDiff(dd::fromDouble(got[k]), ref.v[k]));
  }

  // Gate on the BACKWARD error, which is the only forward-error-free statement available:
  //   ‖b - A x‖∞ / (‖A‖∞‖x‖∞ + ‖b‖∞) <~ c·n·u
  const oracle::DMat r =
      oracle::matMul(oa, oracle::fromDoubles(got, n, 1));
  double resid = 0.0;
  double normA = 0.0;
  double normX = 0.0;
  double normB = 0.0;
  for (int64_t i = 0; i < n; ++i) {
    resid = std::max(resid, std::fabs(dd::sub(dd::fromDouble(b[static_cast<size_t>(i)]), r.at(i, 0)).hi));
    normX = std::max(normX, std::fabs(got[static_cast<size_t>(i)]));
    normB = std::max(normB, std::fabs(b[static_cast<size_t>(i)]));
    double rowSum = 0.0;
    for (int64_t j = 0; j < n; ++j) rowSum += std::fabs(A[static_cast<size_t>(j * n + i)]);
    normA = std::max(normA, rowSum);
  }
  const double backward = resid / (normA * normX + normB);
  const double kappa = oracle::conditionInf(oa);

  char note[64];
  std::snprintf(note, sizeof note, "backward err %.1e", backward);
  record("solve", "n=" + std::to_string(n), forward, 64.0 * static_cast<double>(n) * kU, kappa,
         false, note);
  if (backward > 64.0 * static_cast<double>(n) * kU) {
    std::printf("FAIL solve n=%lld backward error %.3e exceeds 64·n·u\n",
                static_cast<long long>(n), backward);
    ++failures;
  }
}

void caseInverseRandom(int64_t n) {
  Rng rng;
  std::vector<double> A = randomMat(rng, n, n, -1.0, 1.0);
  for (int64_t i = 0; i < n; ++i) A[static_cast<size_t>(i * n + i)] += static_cast<double>(n);

  std::vector<double> got;
  try {
    got = dc::MatVal::inverse(toMatVal(A, n, n)).toColumnMajor();
  } catch (const std::exception& e) {
    std::printf("FAIL inverse n=%lld threw: %s\n", static_cast<long long>(n), e.what());
    ++failures;
    return;
  }
  const oracle::DMat oa = oracle::fromDoubles(A, n, n);
  bool singular = false;
  const oracle::DMat ref = oracle::inverse(oa, &singular);

  double worst = 0.0;
  for (size_t k = 0; k < got.size(); ++k) {
    worst = std::max(worst, dd::relDiff(dd::fromDouble(got[k]), ref.v[k]));
  }
  const double kappa = oracle::conditionInf(oa);
  // Forward error of an inverse is allowed to be ~κ·u; gate at 64·n·κ·u so the case still
  // catches an algorithmic mistake without blaming the arithmetic for κ.
  const double bound = 64.0 * static_cast<double>(n) * kappa * kU + 64.0 * kU;
  record("inverse", "n=" + std::to_string(n), worst, bound, kappa, true);
}

void caseDeterminantRandom(int64_t n) {
  Rng rng;
  std::vector<double> A = randomMat(rng, n, n, -1.0, 1.0);
  for (int64_t i = 0; i < n; ++i) A[static_cast<size_t>(i * n + i)] += static_cast<double>(n);

  const double got = dc::MatVal::determinant(toMatVal(A, n, n));
  bool singular = false;
  const dd::DD ref = oracle::determinant(oracle::fromDoubles(A, n, n), &singular);
  const double err = dd::relDiff(dd::fromDouble(got), ref);
  record("det", "n=" + std::to_string(n), err, 64.0 * static_cast<double>(n) * kU, 0.0, true);
}

// Hilbert matrices: the canonical "the arithmetic is fine, the problem is not" case.
void caseHilbert(int64_t n) {
  const std::vector<double> A = hilbert(n);
  const oracle::DMat oa = oracle::fromDoubles(A, n, n);
  const double kappa = oracle::conditionInf(oa);

  // b = A·1 computed in dd, so the exact solution is the all-ones vector.
  oracle::DMat ones(n, 1);
  for (int64_t i = 0; i < n; ++i) ones.at(i, 0) = dd::fromDouble(1.0);
  const oracle::DMat bdd = oracle::matMul(oa, ones);

  std::vector<double> b(static_cast<size_t>(n));
  for (int64_t i = 0; i < n; ++i) b[static_cast<size_t>(i)] = bdd.at(i, 0).hi;

  std::vector<double> got;
  bool threw = false;
  try {
    got = dc::MatVal::solve(toMatVal(A, n, n), toMatVal(b, n, 1)).toColumnMajor();
  } catch (const std::exception&) {
    threw = true;
  }
  if (threw) {
    // κ·u ≥ 1 is the point where the FP64 answer carries no information whatsoever, so
    // FullPivLU's rank guard refusing the matrix is the CORRECT outcome, not a failure.
    // Recording it as a bug is exactly the "blame the code for the conditioning" mistake
    // this file exists to avoid.
    const bool expected = kappa * kU >= 1.0;
    record("solve", "hilbert n=" + std::to_string(n), 0.0, 0.0, kappa, false,
           expected ? "refused: kappa*u >= 1 (correct)" : "UNEXPECTED REFUSAL");
    if (!expected) ++failures;
    return;
  }
  double worst = 0.0;
  for (int64_t i = 0; i < n; ++i) {
    worst = std::max(worst, std::fabs(got[static_cast<size_t>(i)] - 1.0));
  }
  record("solve", "hilbert n=" + std::to_string(n), worst, 0.0, kappa, false,
         "exact x = 1");
}

void caseSingular() {
  // Two identical rows: no rounding involved, the engine must refuse.
  const std::vector<double> A = {1.0, 2.0, 2.0, 4.0};  // column-major [[1,2],[2,4]]
  bool threwInverse = false;
  bool threwSolve = false;
  try {
    dc::MatVal::inverse(toMatVal(A, 2, 2));
  } catch (const dc::ShapeError&) {
    threwInverse = true;
  }
  try {
    dc::MatVal::solve(toMatVal(A, 2, 2), toMatVal({1.0, 2.0}, 2, 1));
  } catch (const dc::ShapeError&) {
    threwSolve = true;
  }
  bool oracleSaysSingular = false;
  oracle::inverse(oracle::fromDoubles(A, 2, 2), &oracleSaysSingular);

  if (!threwInverse || !threwSolve) {
    std::printf("FAIL singular: inverse threw=%d solve threw=%d (both must throw)\n",
                static_cast<int>(threwInverse), static_cast<int>(threwSolve));
    ++failures;
  }
  record("singular", "duplicate rows", 0.0, 0.0, 0.0, false,
         threwInverse && threwSolve && oracleSaysSingular ? "refused by both" : "MISMATCH");
}

// ── statistics cases ──────────────────────────────────────────────────

struct StatCase {
  const char* expr;
  const char* name;
  std::vector<double> data;
  const char* note;
  bool gated;
  double bound;
};

void runStat(const StatCase& c) {
  const double got = engineAgg(c.expr, c.data);

  dd::DD ref{0.0, 0.0};
  const std::string e = c.expr;
  if (e == "SUM(A)") {
    ref = oracle::sum(c.data);
  } else if (e == "MEAN(A)") {
    ref = oracle::mean(c.data);
  } else if (e == "STD(A)") {
    ref = oracle::spread(c.data).sd;
  } else if (e == "VAR(A)") {
    ref = oracle::spread(c.data).var;
  } else if (e == "MEDIAN(A)") {
    ref = oracle::quantileR7(c.data, 0.5);
  } else if (e == "QUANTILE(A, 0.25)") {
    ref = oracle::quantileR7(c.data, 0.25);
  } else if (e == "QUANTILE(A, 0.75)") {
    ref = oracle::quantileR7(c.data, 0.75);
  } else {
    std::printf("FAIL unknown stat expression %s\n", c.expr);
    ++failures;
    return;
  }

  const double err = dd::relDiff(dd::fromDouble(got), ref);
  record(c.name, std::to_string(c.data.size()) + " rows", err, c.bound, 0.0, c.gated, c.note);
}

void statCases() {
  const size_t n = 100000;
  Rng rng;

  std::vector<double> uniform(n);
  for (double& x : uniform) x = rng.uni(0.0, 1.0);

  // Large offset, small spread: the same deviation data, just shifted by 1e6. Variance is
  // invariant under translation — so any difference between the two runs is pure rounding.
  std::vector<double> offset(n);
  for (size_t i = 0; i < n; ++i) offset[i] = 1e6 + (uniform[i] - 0.5) * 2e-3;

  // Cancellation built on values that cannot be represented exactly: 50000 × (+1/3) and
  // 50000 × (−1/3), the last one off by 1e-8, so the exact sum is 1e-8 while the running
  // sum is O(1e4). (±1 would cancel exactly in FP64 and measure nothing at all.)
  std::vector<double> cancel(n, 1.0 / 3.0);
  for (size_t i = n / 2; i < n; ++i) cancel[i] = -1.0 / 3.0;
  cancel[n - 1] = -1.0 / 3.0 + 1e-8;

  // Small terms riding on a huge running sum. 1/3 is ~2700 ulps of 1e12, so nothing is
  // absorbed here; what this measures is the accumulation noise floor set by ulp(1e12)
  // (1.2e-4) times the number of additions.
  std::vector<double> bigsum(n);
  bigsum[0] = 1e12;
  for (size_t i = 1; i < n; ++i) bigsum[i] = 1.0 / 3.0;

  // Genuine absorption: 1.0 is exactly half of ulp(1e16), rounds to even, and disappears.
  // The exact sum is 1. FP64 returns 0 — total loss, not a loss of digits.
  const std::vector<double> absorb = {1e16, 1.0, -1e16};

  // Same deviations as `offset`, centred at 1e8 instead of 1e6. Variance is invariant under
  // translation, so every digit lost here is pure rounding — not a property of the data.
  std::vector<double> offset2(n);
  for (size_t i = 0; i < n; ++i) offset2[i] = 1e8 + (uniform[i] - 0.5) * 2e-2;

  const double gn = gamma(static_cast<int64_t>(n));

  const std::vector<StatCase> cases = {
      {"SUM(A)", "SUM", uniform, "uniform(0,1)", true, 16.0 * gn + 64.0 * kU},
      {"MEAN(A)", "MEAN", uniform, "uniform(0,1)", true, 16.0 * gn + 64.0 * kU},
      {"VAR(A)", "VAR", uniform, "uniform(0,1)", true, 16.0 * gn + 64.0 * kU},
      {"STD(A)", "STD", uniform, "uniform(0,1)", true, 16.0 * gn + 64.0 * kU},
      {"MEDIAN(A)", "MEDIAN", uniform, "uniform(0,1)", true, 64.0 * kU},
      {"QUANTILE(A, 0.25)", "QUANTILE", uniform, "q=0.25", true, 64.0 * kU},
      {"QUANTILE(A, 0.75)", "QUANTILE", uniform, "q=0.75", true, 64.0 * kU},
      {"SUM(A)", "SUM", cancel, "cancel to 1e-8", false, 0.0},
      {"MEAN(A)", "MEAN", cancel, "cancel to 1e-8", false, 0.0},
      {"SUM(A)", "SUM", bigsum, "1e12 then 1e5 x 1/3", false, 0.0},
      {"MEAN(A)", "MEAN", bigsum, "1e12 then 1e5 x 1/3", true, 16.0 * gn + 64.0 * kU},
      {"SUM(A)", "SUM", absorb, "1e16 + 1 - 1e16", false, 0.0},
      {"MEAN(A)", "MEAN", absorb, "1e16 + 1 - 1e16", false, 0.0},
      {"VAR(A)", "VAR", offset, "1e6 + spread 2e-3", false, 0.0},
      {"STD(A)", "STD", offset, "1e6 + spread 2e-3", false, 0.0},
      {"VAR(A)", "VAR", offset2, "1e8 + spread 2e-2", false, 0.0},
      {"STD(A)", "STD", offset2, "1e8 + spread 2e-2", false, 0.0},
      {"MEAN(A)", "MEAN", offset, "1e6 + spread 2e-3", true, 16.0 * gn + 64.0 * kU},
  };
  for (const StatCase& c : cases) runStat(c);
}

// ── report ────────────────────────────────────────────────────────────

void report() {
  std::printf("\n%-9s %-21s %-11s %6s %9s %-10s %s\n", "op", "shape", "rel.err", "digits",
              "kappa", "gate", "verdict");
  std::printf("%s\n", std::string(96, '-').c_str());
  for (const Row& r : table()) {
    const double digits = std::isfinite(r.relErr) && r.relErr > 0.0 ? -std::log10(r.relErr) : 16.0;
    char kappa[24] = "-";
    if (r.kappa > 0.0) std::snprintf(kappa, sizeof kappa, "%.1e", r.kappa);
    char gate[24] = "-";
    if (r.gated) std::snprintf(gate, sizeof gate, "%.0e", r.bound);
    std::printf("%-9s %-21s %-11.3e %6.1f %9s %-10s %s\n", r.op.c_str(), r.shape.c_str(),
                r.relErr, digits, kappa, gate,
                r.gated ? (r.passed ? "ok" : "OVER") : "reported");
    if (!r.note.empty()) std::printf("%11s└ %s\n", "", r.note.c_str());
  }
  std::printf("%s\n", std::string(96, '-').c_str());
  std::printf("\n%zu cases, %d failed\n", table().size(), failures);
}

}  // namespace

int main() {
  std::printf("=== FP64 engine vs double-double oracle ===\n");
  std::printf("u(double) = %.3e   u^2(dd) ~ %.0e\n\n", kU, kDdU);

  for (int64_t n : {4, 8, 16, 32, 64}) caseMatmulRandom(n);
  caseMatmulCancellation();
  for (int64_t n : {8, 16, 32, 64}) caseSolveRandom(n);
  for (int64_t n : {8, 16, 32}) caseInverseRandom(n);
  for (int64_t n : {8, 16, 32}) caseDeterminantRandom(n);
  for (int64_t n : {4, 6, 8, 10, 12}) caseHilbert(n);
  caseSingular();
  statCases();
  report();

  return failures == 0 ? 0 : 1;
}
