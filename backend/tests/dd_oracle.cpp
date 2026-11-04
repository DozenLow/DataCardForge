#include "dd_oracle.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace oracle {

namespace {

// dd's own noise floor is ~u² ≈ 1e-32; a pivot below scale·n·1e-30 carries no information
// at all, so the reference calls the matrix singular there. This is deliberately much
// stricter than FullPivLU's eps·n·maxPivot (≈ 1e-11 at n = 1e5) — the point of the oracle
// is to *find* the region where the FP64 answer stops meaning anything.
constexpr double kDdRankEps = 1e-30;

double maxAbs(const DMat& a) {
  double best = 0.0;
  for (const dd::DD& x : a.v) best = std::max(best, std::fabs(x.hi));
  return best;
}

}  // namespace

DMat fromDoubles(const std::vector<double>& colMajor, int64_t rows, int64_t cols) {
  if (static_cast<int64_t>(colMajor.size()) != rows * cols) {
    throw std::invalid_argument("fromDoubles: size does not match rows*cols");
  }
  DMat m(rows, cols);
  for (size_t k = 0; k < m.v.size(); ++k) m.v[k] = dd::fromDouble(colMajor[k]);
  return m;
}

DMat identity(int64_t n) {
  DMat m(n, n);
  for (int64_t i = 0; i < n; ++i) m.at(i, i) = dd::fromDouble(1.0);
  return m;
}

DMat matMul(const DMat& a, const DMat& b) {
  if (a.cols != b.rows) throw std::invalid_argument("matMul: inner dimensions differ");
  DMat r(a.rows, b.cols);
  for (int64_t j = 0; j < b.cols; ++j) {
    for (int64_t i = 0; i < a.rows; ++i) {
      dd::DD acc{0.0, 0.0};
      for (int64_t k = 0; k < a.cols; ++k) {
        acc = dd::add(acc, dd::mul(a.at(i, k), b.at(k, j)));
      }
      r.at(i, j) = acc;
    }
  }
  return r;
}

LU luFactor(DMat a) {
  LU out;
  out.m = std::move(a);
  const int64_t n = out.m.rows;
  out.rowSwapAt.assign(static_cast<size_t>(n), -1);
  out.colSwapAt.assign(static_cast<size_t>(n), -1);

  if (n == 0 || out.m.cols != n) {
    out.det = dd::fromDouble(1.0);
    out.ok = true;
    return out;
  }

  const double scale = maxAbs(out.m);
  if (scale == 0.0) {
    out.det = dd::fromDouble(0.0);
    out.ok = false;
    return out;
  }
  const double thresh = scale * static_cast<double>(n) * kDdRankEps;

  dd::DD det = dd::fromDouble(1.0);
  int sign = 1;

  for (int64_t k = 0; k < n; ++k) {
    // Complete pivot: largest magnitude in the remaining submatrix.
    int64_t pr = k;
    int64_t pc = k;
    double best = -1.0;
    for (int64_t i = k; i < n; ++i) {
      for (int64_t j = k; j < n; ++j) {
        const double v = std::fabs(out.m.at(i, j).hi);
        if (v > best) {
          best = v;
          pr = i;
          pc = j;
        }
      }
    }
    if (best <= thresh) {
      out.det = dd::fromDouble(0.0);
      out.ok = false;
      return out;
    }
    // Swap whole rows / columns. The permutation is recorded and replayed by solve().
    if (pr != k) {
      for (int64_t j = 0; j < n; ++j) std::swap(out.m.at(k, j), out.m.at(pr, j));
      out.rowSwapAt[static_cast<size_t>(k)] = pr;
      sign = -sign;
    }
    if (pc != k) {
      for (int64_t i = 0; i < n; ++i) std::swap(out.m.at(i, k), out.m.at(i, pc));
      out.colSwapAt[static_cast<size_t>(k)] = pc;
      sign = -sign;
    }

    const dd::DD piv = out.m.at(k, k);
    det = dd::mul(det, piv);

    for (int64_t i = k + 1; i < n; ++i) {
      const dd::DD f = dd::div(out.m.at(i, k), piv);
      out.m.at(i, k) = f;
      if (dd::isZero(f)) continue;
      for (int64_t j = k + 1; j < n; ++j) {
        out.m.at(i, j) = dd::sub(out.m.at(i, j), dd::mul(f, out.m.at(k, j)));
      }
    }
  }

  out.det = sign < 0 ? dd::neg(det) : det;
  out.ok = true;
  return out;
}

DMat solve(const DMat& a, const DMat& b, bool* singular) {
  LU lu = luFactor(a);
  if (singular != nullptr) *singular = !lu.ok;
  if (!lu.ok) return DMat(b.rows, b.cols);
  if (b.rows != a.rows) throw std::invalid_argument("solve: b has the wrong height");

  const int64_t n = lu.m.rows;
  const int64_t nrhs = b.cols;
  DMat x = b;

  // P·b, applied in the same order the swaps were performed.
  for (int64_t k = 0; k < n; ++k) {
    const int64_t pr = lu.rowSwapAt[static_cast<size_t>(k)];
    if (pr < 0) continue;
    for (int64_t j = 0; j < nrhs; ++j) std::swap(x.at(k, j), x.at(pr, j));
  }
  // L·y = P·b, unit diagonal implicit.
  for (int64_t i = 0; i < n; ++i) {
    for (int64_t j = 0; j < nrhs; ++j) {
      dd::DD s = x.at(i, j);
      for (int64_t k = 0; k < i; ++k) s = dd::sub(s, dd::mul(lu.m.at(i, k), x.at(k, j)));
      x.at(i, j) = s;
    }
  }
  // U·z = y.
  for (int64_t i = n - 1; i >= 0; --i) {
    for (int64_t j = 0; j < nrhs; ++j) {
      dd::DD s = x.at(i, j);
      for (int64_t k = i + 1; k < n; ++k) s = dd::sub(s, dd::mul(lu.m.at(i, k), x.at(k, j)));
      x.at(i, j) = dd::div(s, lu.m.at(i, i));
    }
  }
  // x = Q·z, in reverse swap order.
  for (int64_t k = n - 1; k >= 0; --k) {
    const int64_t pc = lu.colSwapAt[static_cast<size_t>(k)];
    if (pc < 0) continue;
    for (int64_t j = 0; j < nrhs; ++j) std::swap(x.at(k, j), x.at(pc, j));
  }
  return x;
}

DMat inverse(const DMat& a, bool* singular) {
  return solve(a, identity(a.rows), singular);
}

dd::DD determinant(const DMat& a, bool* singular) {
  LU lu = luFactor(a);
  if (singular != nullptr) *singular = !lu.ok;
  return lu.det;
}

double conditionInf(const DMat& a) {
  bool singular = false;
  const DMat inv = inverse(a, &singular);
  if (singular) return std::numeric_limits<double>::infinity();
  auto normInf = [](const DMat& m) {
    double best = 0.0;
    for (int64_t i = 0; i < m.rows; ++i) {
      double s = 0.0;
      for (int64_t j = 0; j < m.cols; ++j) s += std::fabs(m.at(i, j).hi);
      best = std::max(best, s);
    }
    return best;
  };
  return normInf(a) * normInf(inv);
}

// ── statistics ─────────────────────────────────────────────────────────

dd::DD sum(const std::vector<double>& v) {
  dd::DD s{0.0, 0.0};
  for (double x : v) {
    if (std::isfinite(x)) s = dd::add(s, dd::fromDouble(x));
  }
  return s;
}

dd::DD mean(const std::vector<double>& v) {
  size_t n = 0;
  for (double x : v) {
    if (std::isfinite(x)) ++n;
  }
  if (n == 0) return {std::numeric_limits<double>::quiet_NaN(), 0.0};
  return dd::div(sum(v), dd::fromDouble(static_cast<double>(n)));
}

Spread spread(const std::vector<double>& v) {
  Spread out;
  std::vector<double> finite;
  finite.reserve(v.size());
  for (double x : v) {
    if (std::isfinite(x)) finite.push_back(x);
  }
  out.n = static_cast<int64_t>(finite.size());
  if (out.n == 0) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    out.var = {nan, 0.0};
    out.sd = {nan, 0.0};
    out.sem = {nan, 0.0};
    return out;
  }
  if (out.n == 1) {
    out.var = dd::fromDouble(0.0);
    out.sd = dd::fromDouble(0.0);
    out.sem = dd::fromDouble(0.0);
    return out;
  }
  // Same two-pass shape as src/expression.cpp (mean, then squared deviations) so the
  // difference measured is rounding and nothing else.
  const dd::DD m = mean(finite);
  dd::DD ss{0.0, 0.0};
  for (double x : finite) {
    const dd::DD d = dd::sub(dd::fromDouble(x), m);
    ss = dd::add(ss, dd::mul(d, d));
  }
  out.var = dd::div(ss, dd::fromDouble(static_cast<double>(out.n - 1)));
  out.sd = dd::sqrt(out.var);
  out.sem = dd::div(out.sd, dd::sqrt(dd::fromDouble(static_cast<double>(out.n))));
  return out;
}

dd::DD quantileR7(const std::vector<double>& v, double q) {
  std::vector<double> sorted;
  sorted.reserve(v.size());
  for (double x : v) {
    if (std::isfinite(x)) sorted.push_back(x);
  }
  std::sort(sorted.begin(), sorted.end());
  if (sorted.empty() || !std::isfinite(q)) {
    return {std::numeric_limits<double>::quiet_NaN(), 0.0};
  }
  if (q < 0.0) q = 0.0;
  if (q > 1.0) q = 1.0;
  const double position = static_cast<double>(sorted.size() - 1) * q;
  const size_t lower = static_cast<size_t>(std::floor(position));
  const size_t upper = static_cast<size_t>(std::ceil(position));
  if (lower == upper) return dd::fromDouble(sorted[lower]);
  const dd::DD fraction = dd::sub(dd::fromDouble(position), dd::fromDouble(static_cast<double>(lower)));
  const dd::DD diff = dd::sub(dd::fromDouble(sorted[upper]), dd::fromDouble(sorted[lower]));
  return dd::add(dd::fromDouble(sorted[lower]), dd::mul(diff, fraction));
}

}  // namespace oracle
