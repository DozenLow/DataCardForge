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
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace dd {

struct DD {
  double hi = 0.0;  // rounded value — this is the double the FP64 engine "should" get
  double lo = 0.0;  // exact residual, |lo| <= ulp(hi)/2
};

inline bool isFinite(DD a) { return std::isfinite(a.hi); }

inline double toDouble(DD a) { return a.hi; }

// ── debug probes ───────────────────────────────────────────────────────
//
// The oracle's failure mode is the worst kind: a broken double-double still returns a
// plausible number, and the audit then reports that number as the truth. It launders bad
// arithmetic into "reference".
//
// These checks are compiled out in Release (NDEBUG) and live in the Asserts / Debug tiers,
// where a violated precondition stops the process instead of quietly making the reference
// wrong. They only cover conditions that can NEVER be hit by correct input (non-finite
// intermediate), so the probe cannot fire spuriously and block a release build.
#ifndef NDEBUG
#define DD_REQUIRE(cond)                                                        \
  do {                                                                          \
    if (!(cond)) {                                                              \
      std::fprintf(stderr, "dd precondition failed: %s (%s:%d)\n", #cond,      \
                   __FILE__, __LINE__);                                          \
      std::abort();                                                             \
    }                                                                           \
  } while (0)
#else
#define DD_REQUIRE(cond) ((void)0)
#endif

// ── error-free transformations ─────────────────────────────────────────

// s = fl(a+b), e = (a+b) - s exactly. Requires no overflow.
inline DD twoSum(double a, double b) {
  DD_REQUIRE(std::isfinite(a) && std::isfinite(b));
  const double s = a + b;
  DD_REQUIRE(std::isfinite(s));
  const double bb = s - a;
  const double e = (a - (s - bb)) + (b - bb);
  return {s, e};
}

// Same, but cheapest when |a| >= |b|. The fast path is only valid under that assumption,
// so it falls back to the general form instead of asserting: a violated precondition here
// would otherwise degrade the reference silently, which is the one outcome this header
// must not have.
inline DD quickTwoSum(double a, double b) {
  if (std::fabs(a) < std::fabs(b)) return twoSum(a, b);
  const double s = a + b;
  const double e = b - (s - a);
  return {s, e};
}

// p = fl(a*b), e = a*b - p exactly. std::fma is the portable way to get the residual:
// the compiler is not allowed to "optimise" an fma into a separate multiply and add,
// whereas Dekker splitting is at the mercy of FMA contraction.
inline DD twoProduct(double a, double b) {
  const double p = a * b;
  DD_REQUIRE(std::isfinite(p));
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

// ── self check ───────────────────────────────────────
//
// The invariants the whole oracle rests on, in one place. Called once from the test's
// main() in non-Release builds. If any of these fails, every number in the report is
// suspect, so stopping here is far better than a green audit built on a broken reference.
#ifndef NDEBUG
inline void selfCheck() {
  const DD one = fromDouble(1.0);
  const DD two = fromDouble(2.0);

  // A 106-bit quotient, then a round trip: 1/3 * 3 must return to 1 far beyond double's
  // ulp. A double-only implementation would land around 1e-17 here.
  DD_REQUIRE(relDiff(mul(div(one, fromDouble(3.0)), fromDouble(3.0)), one) < 1e-30);

  // sqrt(2)^2 == 2 to the same standard, and sqrt itself must be correctly rounded.
  const DD root2 = sqrt(two);
  DD_REQUIRE(std::fabs(root2.hi - 1.4142135623730951) < 1e-15);
  DD_REQUIRE(relDiff(mul(root2, root2), two) < 1e-30);

  // 1 + 1e-20 must keep the small term in lo instead of rounding it away — this is the
  // single behaviour that distinguishes double-double from double.
  const DD bumped = add(one, fromDouble(1e-20));
  DD_REQUIRE(bumped.hi == 1.0);
  DD_REQUIRE(std::fabs(bumped.lo - 1e-20) <= 1e-36);
}
#endif

}  // namespace dd
