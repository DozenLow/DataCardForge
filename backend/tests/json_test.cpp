// json_test.cpp — number regressions for the minimal JSON parser/serializer.
//
// Two defects pinned here:
//   - the integer fast path evaluated the double->int64 cast BEFORE the magnitude guard,
//     which is undefined behavior for |v| >= 2^63; huge values must dump as scientific
//     notation, integral values below the guard must still dump as integers;
//   - the number scanner greedily consumed [0-9.eE+-] and let std::stod accept forms JSON
//     forbids ("+1", "1.", ".5", "01"). The grammar is now scanned explicitly; NaN and
//     Infinity stay rejected.
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>

#include "json.h"

using namespace dc;

static int failures = 0;

#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);   \
      ++failures;                                                  \
    }                                                              \
  } while (0)

namespace {

void expectDump(double v, const std::string& want) {
  const std::string got = Json(v).dump();
  if (got != want) {
    std::printf("FAIL dump(%g) = '%s', want '%s'\n", v, got.c_str(), want.c_str());
    ++failures;
  }
}

void expectParseOk(const std::string& text, double want) {
  Json j;
  std::string err;
  if (!Json::parse(text, &j, &err)) {
    std::printf("FAIL parse('%s') rejected: %s\n", text.c_str(), err.c_str());
    ++failures;
    return;
  }
  CHECK(j.isNumber() && j.asNumber() == want);
}

void expectParseFail(const std::string& text) {
  Json j;
  std::string err;
  if (Json::parse(text, &j, &err)) {
    std::printf("FAIL parse('%s') accepted, want rejection\n", text.c_str());
    ++failures;
  }
}

}  // namespace

int main() {
  // ── integer fast path: magnitude guard before the cast ──
  expectDump(0.0, "0");
  expectDump(-0.0, "0");
  expectDump(42.0, "42");
  expectDump(-7.0, "-7");
  expectDump(9007199254740992.0, "9007199254740992");  // 2^53, integral and below the guard
  expectDump(1.5, "1.5");
  expectDump(-0.125, "-0.125");
  // |v| >= 2^63: the cast would be UB; these must take the %.17g path, not the int path.
  // (double(1e300) sits just above 10^300, hence the 17th digit.)
  expectDump(1e300, "1.0000000000000001e+300");
  expectDump(-1e300, "-1.0000000000000001e+300");
  expectDump(9.2233720368547758e18, "9.2233720368547758e+18");   // 2^63
  expectDump(-9.2233720368547758e18, "-9.2233720368547758e+18");
  // The guard boundary itself: integral, but NOT below 9.2e15, so it goes through %.17g.
  expectDump(9.2e15, "9200000000000000");
  expectDump(1e16, "10000000000000000");
  // Non-finite contract unchanged: null, never NaN/Infinity literals.
  expectDump(std::nan(""), "null");
  expectDump(std::numeric_limits<double>::infinity(), "null");
  // The emitted forms round-trip through the parser.
  expectParseOk("1.0000000000000001e+300", 1e300);
  expectParseOk("-1.0000000000000001e+300", -1e300);
  expectParseOk("1e+300", 1e300);
  expectParseOk("9.2233720368547758e+18", 9.2233720368547758e18);
  expectParseOk("9007199254740992", 9007199254740992.0);

  // ── number grammar: JSON forms only ──
  expectParseOk("0", 0.0);
  expectParseOk("-0", 0.0);
  expectParseOk("1.5", 1.5);
  expectParseOk("1e3", 1000.0);
  expectParseOk("-2.5E-2", -0.025);
  expectParseOk("123", 123.0);
  expectParseOk("0.0", 0.0);
  expectParseOk("1E+2", 100.0);
  expectParseFail("+1");
  expectParseFail("1.");
  expectParseFail(".5");
  expectParseFail("01");
  expectParseFail("+0");
  expectParseFail("00");
  expectParseFail("-");
  expectParseFail("1e");
  expectParseFail("1e+");
  expectParseFail("NaN");
  expectParseFail("Infinity");
  expectParseFail("-Infinity");
  // The grammar must hold inside containers too, not just at the top level.
  expectParseFail("[01]");
  expectParseFail("[+1]");
  expectParseFail("[1.,2]");
  expectParseFail("{\"a\":1.}");
  {
    Json j;
    std::string err;
    CHECK(Json::parse("[0,-0,1.5,1e3,-2.5E-2]", &j, &err));
    CHECK(j.isArray() && j.items().size() == 5);
  }

  std::printf("%s\n", failures == 0 ? "json: ok" : "json: FAILED");
  return failures == 0 ? 0 : 1;
}
