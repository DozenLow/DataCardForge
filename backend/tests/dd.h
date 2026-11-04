// dd.h — double-double arithmetic, TEST ORACLE ONLY.
//
// Nothing in the shipped engine may include this. It exists so the tests can compute a
// reference value with ~106 significant bits (u ≈ 1e-32) and then ask the only question
// that matters about the FP64 engine: *how many digits did it actually deliver?*
//
// Why hand-rolled instead of a library: the project links Eigen and Threads and nothing
// else (backend/CMakeLists.txt). A reference implementation is the one place where the
// cheap, boring, dependency-free version wins — a 150-line header that nobody ships.
//
// Conventions follow Dekker / Knuth / Bailey with the "sloppy" (quickTwoSum) add, which
// is accurate to ~1e-31 relative, i.e. ~15 digits better than double. That is far more
// than the comparison needs, and it stays fast enough to run inside ctest.
//
// Build requirement: strict IEEE FP. `-ffast-math` breaks TwoSum's reliance on
// `s - a` being exact, so it is a hard #error rather than a silent wrong answer.
#pragma once

#if defined(__FAST_MATH__)
#error "dd.h requires strict IEEE semantics: do not build with -ffast-math"
#endif

#include <cmath>
#include <limits>

namespace dd {

struct DD {
  double hi = 0.0;  // rounded value — this is the double the FP64 engine "should" get
  double lo = 0.0;  // exact residual, |lo| <= ulp(hi)/2
};

inline bool isFinite(DD a) { return std::isfinite(a.hi); }

inline double toDouble(DD a) { return a.hi; }

// ── error-free transformations ─────────────────────────────────────────

// s = fl(a+b), e = (a+b) - s exactly. Requires no overflow.
inline DD twoSum(double a, double b) {
  const double s = a + b;
  const double bb = s - a;
  const double e = (a - (s - bb)) + (b - bb);
  return {s, e};
}

// Same, but assumes |a| >= |b|. Cheaper (3 flops instead of 6).
inline DD quickTwoSum(double a, double b) {
  const double s = a + b;
  const double e = b - (s - a);
  return {s, e};
}

// p = fl(a*b), e = a*b - p exactly. std::fma is the portable way to get the residual:
// the compiler is not allowed to "optimise" an fma into a separate multiply and add,
// whereas Dekker splitting is at the mercy of FMA contraction.
inline DD twoProduct(double a, double b) {
  const double p = a * b;
  const double e = std::fma(a, b, -p);
  return {p, e};
}

// ── arithmetic ─────────────────────────────────────────────────────────

inline DD fromDouble(double a) { return {a, 0.0}; }

inline DD neg(DD a) { return {-a.hi, -a.lo}; }

inline DD abs(DD a) { return {std::fabs(a.hi), std::fabs(a.lo)}; }

inline DD add(DD a, DD b) {
  DD s = twoSum(a.hi, b.hi);
  s.lo += a.lo + b.lo;
  return quickTwoSum(s.hi, s.lo);
}

inline DD sub(DD a, DD b) { return add(a, neg(b)); }

inline DD mul(DD a, DD b) {
  DD p = twoProduct(a.hi, b.hi);
  p.lo += a.hi * b.lo + a.lo * b.hi;
  return quickTwoSum(p.hi, p.lo);
}

// Newton-corrected division: three quotient digits instead of one.
inline DD div(DD a, DD b) {
  const double q1 = a.hi / b.hi;
  if (!std::isfinite(q1) || b.hi == 0.0) return {q1, 0.0};
  DD r = sub(a, mul(b, {q1, 0.0}));
  const double q2 = r.hi / b.hi;
  r = sub(r, mul(b, {q2, 0.0}));
  const double q3 = r.hi / b.hi;
  return add(quickTwoSum(q1, q2), {q3, 0.0});
}

inline DD sqrt(DD a) {
  if (!(a.hi > 0.0)) return {std::sqrt(a.hi), 0.0};
  const double x = std::sqrt(a.hi);
  // One correction in dd, then one dd Newton step: enough for full 106-bit accuracy.
  DD y = quickTwoSum(x, sub(a, twoProduct(x, x)).hi / (2.0 * x));
  y = mul(add(y, div(a, y)), {0.5, 0.0});
  return y;
}

// |a| > |b|, comparing hi first and breaking ties with lo. Exact for our use (the two
// values being compared are pivots, never equal up to the last dd bit).
inline bool gt(DD a, DD b) {
  const DD x = abs(a);
  const DD y = abs(b);
  if (x.hi != y.hi) return x.hi > y.hi;
  return std::fabs(x.lo) > std::fabs(y.lo);
}

inline bool isZero(DD a) { return a.hi == 0.0 && a.lo == 0.0; }

// Relative difference |a - b| / |b|, computed in dd and returned as a plain double.
// Returns +inf when b is exactly zero and a is not (a real difference, not a rounding one).
inline double relDiff(DD a, DD b) {
  const DD d = abs(sub(a, b));
  const DD s = abs(b);
  if (isZero(s)) return isZero(d) ? 0.0 : std::numeric_limits<double>::infinity();
  return d.hi / s.hi;
}

}  // namespace dd
