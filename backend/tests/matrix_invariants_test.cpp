// matrix_invariants_test.cpp — algebraic identities that must hold for ANY correct
// implementation. No reference values, no extended precision, no fixtures.
//
// The three gates in this directory cover three different failure classes, and the point of
// having all three is that neither of the other two can see this one:
//
//   fixtures    do we mean the same thing as the TS reference?  (both could be wrong)
//   dd_oracle   how many digits did the arithmetic keep?        (only for well-posed cases)
//   this file   is the algebra itself right?                    (wrong function, flipped index)
//
// The third class is invisible to the first two by construction: Aᵀ·Bᵀ computed where
// Bᵀ·Aᵀ was meant is perfectly accurate, and the two engines agree with each other
// perfectly, because they share the same wrong line.
//
// Tolerances here are 512·n·u rather than the tighter γ_n: these identities relate two
// *different* computations (two GEMM orderings, an LU versus its transpose), so the
// comparison carries twice the rounding of a single result on purpose.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <random>
#include <vector>

#include "matrix_value.h"

namespace {

constexpr double kU = std::numeric_limits<double>::epsilon() / 2.0;

int checks = 0;
int failures = 0;

struct Rng {
  std::mt19937_64 gen{0xC0FFEEULL};
  double uni(double lo, double hi) {
    // 53 random bits → an exact double in [0,1); implementation-independent, unlike
    // std::uniform_real_distribution.
    const double bits = static_cast<double>(gen() >> 11);
    return lo + (hi - lo) * (bits * (1.0 / 9007199254740992.0));
  }
};

std::vector<double> randomMat(Rng& rng, int64_t rows, int64_t cols, double lo, double hi) {
  std::vector<double> m(static_cast<size_t>(rows * cols));
  for (double& x : m) x = rng.uni(lo, hi);
  return m;
}

// Diagonal dominance keeps κ small, so the invariants below are decided by the arithmetic
// and not by the conditioning — a conditioning failure here would tell us nothing.
std::vector<double> wellConditioned(Rng& rng, int64_t n) {
  std::vector<double> m = randomMat(rng, n, n, -1.0, 1.0);
  for (int64_t i = 0; i < n; ++i) m[static_cast<size_t>(i * n + i)] += static_cast<double>(n);
  return m;
}

std::vector<double> identityFlat(int64_t n) {
  std::vector<double> m(static_cast<size_t>(n * n), 0.0);
  for (int64_t i = 0; i < n; ++i) m[static_cast<size_t>(i * n + i)] = 1.0;
  return m;
}

dc::MatVal mv(const std::vector<double>& flat, int64_t rows, int64_t cols) {
  return dc::MatVal::fromFlat(flat.data(), rows, cols);
}

// max|a-b| / max|a|: scale-free, so one bound works at every n and every magnitude.
double relMaxDiff(const std::vector<double>& a, const std::vector<double>& b) {
  double scale = 0.0;
  for (double x : a) scale = std::max(scale, std::fabs(x));
  double worst = 0.0;
  for (size_t k = 0; k < a.size() && k < b.size(); ++k) {
    worst = std::max(worst, std::fabs(a[k] - b[k]));
  }
  return scale > 0.0 ? worst / scale : worst;
}

void expect(const char* name, int64_t n, double measured, double bound) {
  ++checks;
  const bool ok = measured <= bound;
  if (!ok) ++failures;
  std::printf("%-4s %-46s n=%-3lld %-10.3e <= %-10.3e\n", ok ? "ok" : "FAIL", name,
              static_cast<long long>(n), measured, bound);
}

// Refusing is part of the contract: a quietly wrong answer is worse than an error the UI
// can render, and this file is the cheapest place to hold that line.
template <typename Fn>
void expectThrows(const char* name, Fn&& fn) {
  ++checks;
  try {
    fn();
    std::printf("%-4s %-46s (did NOT throw)\n", "FAIL", name);
    ++failures;
  } catch (const dc::ShapeError&) {
    std::printf("%-4s %-46s ShapeError\n", "ok", name);
  } catch (const std::exception& e) {
    std::printf("%-4s %-46s wrong exception: %s\n", "FAIL", name, e.what());
    ++failures;
  }
}

void runInvariants(int64_t n) {
  Rng rng;
  const std::vector<double> A = wellConditioned(rng, n);
  const std::vector<double> B = wellConditioned(rng, n);
  const std::vector<double> y = randomMat(rng, n, 1, -1.0, 1.0);

  const dc::MatVal mA = mv(A, n, n);
  const dc::MatVal mB = mv(B, n, n);
  const std::vector<double> eye = identityFlat(n);
  const dc::MatVal mI = mv(eye, n, n);
  const double tol = 512.0 * static_cast<double>(n) * kU;

  // Multiplication by the identity must not perturb a single element.
  expect("A*I == A", n, relMaxDiff(dc::MatVal::matmul(mA, mI).toColumnMajor(), A), tol);
  expect("I*A == A", n, relMaxDiff(dc::MatVal::matmul(mI, mA).toColumnMajor(), A), tol);

  // transpose is a pure index permutation, so it must be exactly reversible.
  expect("transpose(transpose(A)) == A", n,
         relMaxDiff(dc::MatVal::transpose(dc::MatVal::transpose(mA)).toColumnMajor(), A), 0.0);

  // (A·B)ᵀ = Bᵀ·Aᵀ — the identity that catches swapped operands. Two different GEMM
  // orderings are compared, hence the 512·n·u allowance rather than γ_n.
  expect("transpose(A*B) == transpose(B)*transpose(A)", n,
         relMaxDiff(
             dc::MatVal::transpose(dc::MatVal::matmul(mA, mB)).toColumnMajor(),
             dc::MatVal::matmul(dc::MatVal::transpose(mB), dc::MatVal::transpose(mA))
                 .toColumnMajor()),
         tol);

  const dc::MatVal mInv = dc::MatVal::inverse(mA);
  expect("inverse(A)*A == I", n,
         relMaxDiff(dc::MatVal::matmul(mInv, mA).toColumnMajor(), eye), tol);

  // (Aᵀ)⁻¹ = (A⁻¹)ᵀ
  expect("inverse(transpose(A)) == transpose(inverse(A))", n,
         relMaxDiff(dc::MatVal::inverse(dc::MatVal::transpose(mA)).toColumnMajor(),
                    dc::MatVal::transpose(mInv).toColumnMajor()),
         tol);

  // solve(A, A·y) must give y back.
  expect("solve(A, A*y) == y", n,
         relMaxDiff(
             dc::MatVal::solve(mA, dc::MatVal::matmul(mA, mv(y, n, 1))).toColumnMajor(), y),
         tol);

  // det(Aᵀ) = det(A). Compared against max(1,|det|) so a tiny determinant does not turn the
  // relative measure into a division by noise.
  const double dA = dc::MatVal::determinant(mA);
  const double dAt = dc::MatVal::determinant(dc::MatVal::transpose(mA));
  expect("det(transpose(A)) == det(A)", n, std::fabs(dAt - dA) / std::max(1.0, std::fabs(dA)),
         tol);
}

// Kept to small n: det(A·B) is compared against det(A)·det(B), and at n = 48 that product
// leaves the range where a relative comparison means anything.
void runDeterminantProducts(int64_t n) {
  Rng rng;
  const std::vector<double> A = wellConditioned(rng, n);
  const std::vector<double> B = wellConditioned(rng, n);
  const dc::MatVal mA = mv(A, n, n);
  const dc::MatVal mB = mv(B, n, n);

  const double dAB = dc::MatVal::determinant(dc::MatVal::matmul(mA, mB));
  const double dA = dc::MatVal::determinant(mA);
  const double dB = dc::MatVal::determinant(mB);
  const double want = dA * dB;

  expect("det(A*B) == det(A)*det(B)", n, std::fabs(dAB - want) / std::max(1.0, std::fabs(want)),
         1024.0 * static_cast<double>(n) * kU);
}

void runContracts() {
  const std::vector<double> a23 = {1, 2, 3, 4, 5, 6};  // column-major 2×3
  const std::vector<double> a22 = {1, 2, 3, 4};        // column-major [[1,3],[2,4]]
  const std::vector<double> singular = {1, 2, 2, 4};   // duplicate rows

  expectThrows("matmul inner dimensions mismatch",
               [&] { dc::MatVal::matmul(mv(a23, 2, 3), mv(a23, 2, 3)); });
  expectThrows("inverse of a non-square matrix",
               [&] { dc::MatVal::inverse(mv(a23, 2, 3)); });
  expectThrows("determinant of a non-square matrix",
               [&] { dc::MatVal::determinant(mv(a23, 2, 3)); });
  expectThrows("solve with a right-hand side of the wrong height",
               [&] { dc::MatVal::solve(mv(a22, 2, 2), mv({1.0, 2.0, 3.0}, 3, 1)); });
  expectThrows("inverse of a singular matrix",
               [&] { dc::MatVal::inverse(mv(singular, 2, 2)); });
}

}  // namespace

int main() {
  std::printf("=== matrix algebraic invariants ===\n\n");
  for (int64_t n : {4, 16, 48}) runInvariants(n);
  std::printf("\n");
  for (int64_t n : {4, 8, 12}) runDeterminantProducts(n);
  std::printf("\n");
  runContracts();
  std::printf("\n%d checks, %d failed\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
