// dd_oracle.h — double-double reference implementations of the backend's computations.
//
// Split from dd.h on purpose: dd.h is the arithmetic, this is the *algorithm*. The
// algorithms here deliberately mirror the ones in src/ (same variance formula, same R-7
// quantile, same LU-with-pivoting shape) so that the measured difference is purely the
// arithmetic — not "we changed the algorithm", which would tell us nothing about the
// shipped code.
#pragma once

#include <cstdint>
#include <vector>

#include "dd.h"

namespace oracle {

// Column-major dense matrix of dd values, matching MatVal's wire order (and its
// `toColumnMajor()`), so the same bytes feed both sides.
struct DMat {
  int64_t rows = 0;
  int64_t cols = 0;
  std::vector<dd::DD> v;

  DMat() = default;
  DMat(int64_t r, int64_t c) : rows(r), cols(c), v(static_cast<size_t>(r * c)) {}

  dd::DD& at(int64_t i, int64_t j) { return v[static_cast<size_t>(j * rows + i)]; }
  const dd::DD& at(int64_t i, int64_t j) const {
    return v[static_cast<size_t>(j * rows + i)];
  }
};

DMat fromDoubles(const std::vector<double>& colMajor, int64_t rows, int64_t cols);

DMat identity(int64_t n);

DMat matMul(const DMat& a, const DMat& b);

// LU with COMPLETE pivoting (Eigen's FullPivLU is what the engine uses, so the reference
// must not be weaker than the thing it audits).
struct LU {
  DMat m;                            // L\U in place; L has an implicit unit diagonal
  std::vector<int64_t> rowSwapAt;    // rowSwapAt[k] = row exchanged with k at step k, or -1
  std::vector<int64_t> colSwapAt;    // likewise for columns
  dd::DD det{0.0, 0.0};
  bool ok = false;                   // false ⇒ numerically singular
};

LU luFactor(DMat a);

DMat inverse(const DMat& a, bool* singular);
DMat solve(const DMat& a, const DMat& b, bool* singular);
dd::DD determinant(const DMat& a, bool* singular);

// ‖A‖∞ · ‖A⁻¹‖∞ — the condition number that decides whether a forward error is "the
// arithmetic" or "the problem". +inf when A is numerically singular.
double conditionInf(const DMat& a);

// ── statistics (same conventions as src/expression.cpp) ────────────────

dd::DD sum(const std::vector<double>& v);
dd::DD mean(const std::vector<double>& v);

struct Spread {
  int64_t n = 0;
  dd::DD var{0.0, 0.0};
  dd::DD sd{0.0, 0.0};
  dd::DD sem{0.0, 0.0};
};

Spread spread(const std::vector<double>& v);

// R-7 (Type 7) linear interpolation between closest ranks — the definition
// src/expression.cpp and the frozen stats.ts reference both implement.
dd::DD quantileR7(const std::vector<double>& v, double q);

}  // namespace oracle
