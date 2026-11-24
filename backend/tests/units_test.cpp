// Unit resolver parity test (C++ side).
//
// Reads web/tests/fixtures/units/parse.json — the SAME file web/tests/units.test.ts judges the
// TypeScript resolver with — and requires `dc::resolveUnit` to agree on every case: state,
// canonical unit, raw token, the ambiguous candidates IN RESOLVER ORDER, and scalar-ness.
//
// Why one shared fixture instead of a C++ copy of the expectations: backend/src/units.cpp is a
// port of web/src/core/units.ts, and two ports of one registry drift silently. The fixture is
// the only place that can convict both (`docs/decisions/2026-11-18-units-v1.md` §八).
//
// Beyond the shared cases this file pins the parts the fixture cannot express:
//   - the factor constants the conversion card multiplies with (exact bit patterns);
//   - the locked evaluation order `value * from / to` (ppm→ppb must stay 1999.9999999999998);
//   - the annotation rewrite (span replacement vs. `_target` append);
//   - the structured refusals (`unitMismatch`, `unitNotScalar`, `unitAmbiguous`, `unitUnknown`,
//     `unknownUnit`, `badSignatureParams`).
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "json.h"
#include "units.h"

using namespace dc;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
  if (!ok) {
    ++g_failures;
    std::printf("FAIL %s\n", what.c_str());
  }
}

std::string quote(const std::string& s) {
  std::string out = "'";
  out += s;
  out += "'";
  return out;
}

// ── Shared fixture cases ───────────────────────────────────────────────────────────────

std::string joinCandidates(const std::vector<UnitCandidate>& candidates) {
  std::string out;
  for (size_t i = 0; i < candidates.size(); ++i) {
    if (i != 0) out += ",";
    out += candidates[i].unit;
  }
  return out;
}

void runFixture(const std::string& path) {
  std::ifstream in(path);
  if (!in) {
    std::printf("FAIL cannot open %s\n", path.c_str());
    ++g_failures;
    return;
  }
  std::stringstream buffer;
  buffer << in.rdbuf();
  Json root;
  std::string err;
  if (!Json::parse(buffer.str(), &root, &err)) {
    std::printf("FAIL bad JSON in %s: %s\n", path.c_str(), err.c_str());
    ++g_failures;
    return;
  }

  int cases = 0;
  for (const Json& entry : root["cases"].items()) {
    const std::string annotation = entry["annotation"].asString();
    ++cases;
    const UnitResolution r = resolveUnit(annotation);
    const std::string label = "anno " + quote(annotation);

    const std::string wantState = entry["state"].asString();
    check(unitStateName(r.state) == wantState,
          label + ": state " + quote(unitStateName(r.state)) + ", want " + quote(wantState));

    if (entry["unit"].isString()) {
      const std::string wantUnit = entry["unit"].asString();
      check(r.unit == wantUnit, label + ": unit " + quote(r.unit) + ", want " + quote(wantUnit));
    }
    if (entry["token"].isString()) {
      const std::string wantToken = entry["token"].asString();
      check(r.token == wantToken,
            label + ": token " + quote(r.token) + ", want " + quote(wantToken));
    }
    if (entry["candidates"].isArray()) {
      std::string want;
      for (const Json& c : entry["candidates"].items()) {
        if (!want.empty()) want += ",";
        want += c.asString();
      }
      const std::string got = joinCandidates(r.candidates);
      check(got == want, label + ": candidates " + quote(got) + ", want " + quote(want));
    }
    if (entry["scalar"].kind() == Json::Kind::Bool) {
      // `scalar` is only meaningful for `recognized`; the other states are never convertible.
      check(r.scalar == entry["scalar"].asBool(),
            label + ": scalar " + (r.scalar ? "true" : "false") + ", want " +
                (entry["scalar"].asBool() ? "true" : "false"));
    }
    if (r.state == UnitState::Recognized) {
      check(r.hasSpan, label + ": recognized resolution without a span");
    }
  }
  std::printf("parse.json: %d cases checked\n", cases);
}

// ── Factor constants (must equal web/src/core/units.ts to the bit) ────────────────────

bool factorOf(const std::string& unit, double* factor, bool* scalar, std::string* dimension) {
  UnitCandidate c;
  if (!candidateByUnit(unit, &c)) return false;
  *factor = c.factor;
  *scalar = c.scalar;
  *dimension = c.dimension;
  return true;
}

void expectFactor(const std::string& unit, double want) {
  double factor = 0;
  bool scalar = false;
  std::string dimension;
  if (!factorOf(unit, &factor, &scalar, &dimension)) {
    check(false, "factor: unit " + unit + " is not registered");
    return;
  }
  // Exact comparison on purpose: these are compile-time constants, and any drift from units.ts
  // is a silent 1e6/60× error in the conversion card.
  check(factor == want, "factor: " + unit + " = " + std::to_string(factor) + ", want " +
                            std::to_string(want));
  check(scalar, "factor: " + unit + " should be scalar");
}

void runFactorChecks() {
  expectFactor("Pa", 1.0);
  expectFactor("kPa", 1e3);
  expectFactor("MPa", 1e6);
  expectFactor("hPa", 1e2);
  expectFactor("bar", 1e5);
  expectFactor("mbar", 1e5 * 1e-3);
  expectFactor("m/s", 1.0);
  expectFactor("mm/s", 1e-3);
  expectFactor("km/h", 1.0 / 3.6);
  expectFactor("rpm", 1.0 / 60.0);
  expectFactor("Hz", 1.0);
  expectFactor("ppm", 1e-6);
  expectFactor("ppb", 1e-9);
  expectFactor("pct", 1e-2);
  expectFactor("A", 1.0);
  expectFactor("mA", 1e-3);
  expectFactor("kN", 1e3);
  // `um` is a SPELLING of µ m, not a canonical unit id: candidateByUnit() looks up canonical
  // names only (units.ts BY_UNIT), so `um` is correctly absent while the resolver still finds it.
  expectFactor("\u00b5m", 1e-6);
  {
    UnitCandidate um;
    check(!candidateByUnit("um", &um), "factor: 'um' is a spelling, not a canonical unit");
  }
  expectFactor("mg/L", 1e-3);
  expectFactor("L/min", 1e-3 / 60.0);

  // Non-scalar labels are registered but explicitly not convertible.
  for (const char* unit : {"\u00b0C", "dB", "dBm", "HRC", "AU", "pH"}) {
    double factor = 0;
    bool scalar = true;
    std::string dimension;
    check(factorOf(unit, &factor, &scalar, &dimension) && !scalar,
          std::string("factor: ") + unit + " should be registered as non-scalar");
  }
  // …and a name outside the registry is simply absent.
  UnitCandidate absent;
  check(!candidateByUnit("furlong", &absent), "factor: furlong must not be registered");
}

// ── Conversion arithmetic and annotation rewrite ──────────────────────────────────────

Column makeColumn(const std::string& posName, const std::string& annotation,
                  const std::vector<double>& data) {
  Column c;
  c.posName = posName;
  c.annotation = annotation;
  c.data = data;
  return c;
}

Json targets(const std::string& body) {
  Json parsed;
  std::string err;
  if (!Json::parse("{\"targets\":" + body + "}", &parsed, &err)) {
    std::printf("FAIL bad test JSON: %s\n", err.c_str());
    ++g_failures;
    return Json::object();
  }
  return parsed;
}

void expectConverted(const std::string& what, const std::vector<Column>& input, const Json& params,
                     const std::string& wantAnnotation, const std::vector<double>& wantData) {
  UnitConvertResult r = evaluateUnitConvert(input, params);
  if (!r.errorCode.empty()) {
    check(false, what + ": unexpected error " + r.errorCode);
    return;
  }
  check(r.columns.size() == input.size(), what + ": column count must equal the input's");
  if (r.columns.empty()) return;
  check(r.columns[0].annotation == wantAnnotation,
        what + ": annotation " + quote(r.columns[0].annotation) + ", want " +
            quote(wantAnnotation));
  const bool sameSize = r.columns[0].data.size() == wantData.size();
  check(sameSize, what + ": row count changed");
  if (!sameSize) return;
  for (size_t i = 0; i < wantData.size(); ++i) {
    // Exact doubles: the card fixtures compare exact values, so this must not be approximate.
    check(r.columns[0].data[i] == wantData[i],
          what + ": row " + std::to_string(i) + " = " +
              std::to_string(r.columns[0].data[i]) + ", want " + std::to_string(wantData[i]));
  }
}

void expectError(const std::string& what, const std::vector<Column>& input, const Json& params,
                 const std::string& wantCode) {
  UnitConvertResult r = evaluateUnitConvert(input, params);
  check(r.errorCode == wantCode,
        what + ": error " + quote(r.errorCode) + ", want " + quote(wantCode));
  check(r.columns.empty(), what + ": a failed conversion must not produce a table");
}

void runConversionChecks() {
  // The locked formula, written out by hand: 2 * 1e-6 / 1e-9. Two left-to-right operations,
  // NOT 2 * (1e-6/1e-9) — which would be exactly 2000. This one line is the reason the card
  // fixtures can use exact-double comparison.
  const double expectedPpmToPpb = (2.0 * 1e-6) / 1e-9;
  check(expectedPpmToPpb == 1999.9999999999998,
        "formula: 2*1e-6/1e-9 should be 1999.9999999999998, got " +
            std::to_string(expectedPpmToPpb));
  check(expectedPpmToPpb != 2000.0, "formula: the ratio must not be precomputed");

  // kPa → bar (annotation suffix rewritten).
  expectConverted("kPa->bar", {makeColumn("Pos.1", "pressure_kpa", {100, 250, 50})},
                  targets("[{\"column\":0,\"to\":\"bar\"}]"), "pressure_bar", {1.0, 2.5, 0.5});
  // m/s → mm/s.
  expectConverted("m/s->mm/s", {makeColumn("Pos.1", "wind_m_s", {5, 0.5, 12})},
                  targets("[{\"column\":0,\"to\":\"mm/s\"}]"), "wind_mm/s", {5000.0, 500.0, 12000.0});
  // km/h → m/s (factor 1/3.6): the everyday velocity unit the registry used to lack.
  expectConverted("km/h->m/s", {makeColumn("Pos.1", "speed_km_h", {36, 72, 3.6})},
                  targets("[{\"column\":0,\"to\":\"m/s\"}]"), "speed_m/s", {10.0, 20.0, 1.0});
  // rpm → Hz (factor 1/60).
  expectConverted("rpm->Hz", {makeColumn("Pos.1", "speed_rpm", {120, 60, 30})},
                  targets("[{\"column\":0,\"to\":\"Hz\"}]"), "speed_Hz", {2.0, 1.0, 0.5});
  // The exact-double case.
  expectConverted("ppm->ppb", {makeColumn("Pos.1", "conc_ppm", {2, 0.1})},
                  targets("[{\"column\":0,\"to\":\"ppb\"}]"), "conc_ppb",
                  {expectedPpmToPpb, (0.1 * 1e-6) / 1e-9});
  // An explicit `from` converts an AMBIGUOUS header the resolver would refuse.
  expectConverted("A->mA explicit", {makeColumn("Pos.1", "current_a", {2})},
                  targets("[{\"column\":0,\"from\":\"A\",\"to\":\"mA\"}]"), "current_mA", {2000.0});

  // Non-ASCII annotation, no composite involved: the µ suffix is a 2-byte token that the span
  // must splice on a byte boundary, next to 2/3-byte header characters.
  expectConverted("cm->mm", {makeColumn("Pos.1", "\u5730\u9762\u901f\u5ea6_\u00b5" "m", {500})},
                  targets("[{\"column\":0,\"to\":\"mm\"}]"),
                  "\u5730\u9762\u901f\u5ea6_mm", {0.5});
  // µm (spelled `um`, and spelled with the Greek mu) is ONE registry entry either way.
  expectConverted("um->mm", {makeColumn("Pos.1", "diameter_um", {500})},
                  targets("[{\"column\":0,\"to\":\"mm\"}]"), "diameter_mm", {0.5});
  expectConverted("greek mu->mm", {makeColumn("Pos.1", "diameter_\u03bc" "m", {500})},
                  targets("[{\"column\":0,\"to\":\"mm\"}]"), "diameter_mm", {0.5});
  // An annotation with no unit at all, plus an explicit from: the target is appended.
  expectConverted("append target", {makeColumn("Pos.1", "length", {1000})},
                  targets("[{\"column\":0,\"from\":\"mm\",\"to\":\"m\"}]"), "length_m", {1.0});

  // Pass-through: an untouched column keeps values AND annotation verbatim, even when its unit
  // is ambiguous (`temp_c`) — the card must not refuse a column it was not asked about.
  {
    std::vector<Column> input = {makeColumn("Pos.1", "pressure_kpa", {100}),
                                 makeColumn("Pos.2", "temp_c", {20, 21})};
    UnitConvertResult r = evaluateUnitConvert(input, targets("[{\"column\":0,\"to\":\"bar\"}]"));
    check(r.errorCode.empty(), "passthrough: unexpected error " + r.errorCode);
    check(r.columns.size() == 2, "passthrough: column count must be preserved");
    if (r.columns.size() == 2) {
      check(r.columns[1].annotation == "temp_c", "passthrough: annotation must be verbatim");
      check(r.columns[1].data == input[1].data, "passthrough: values must be verbatim");
      check(r.columns[1].posName == "Pos.2", "passthrough: posName must be preserved");
    }
  }

  // ── Structured refusals ──
  expectError("MPa->kN", {makeColumn("Pos.1", "stress_MPa", {1})},
              targets("[{\"column\":0,\"to\":\"kN\"}]"), "unitMismatch");
  expectError("dB->Pa", {makeColumn("Pos.1", "level_db", {10})},
              targets("[{\"column\":0,\"to\":\"Pa\"}]"), "unitNotScalar");
  expectError("mw ambiguous", {makeColumn("Pos.1", "output_mw", {5})},
              targets("[{\"column\":0,\"to\":\"mW\"}]"), "unitAmbiguous");
  expectError("no unit annotation", {makeColumn("Pos.1", "temperature", {5})},
              targets("[{\"column\":0,\"to\":\"K\"}]"), "unitUnknown");
  expectError("furlong target", {makeColumn("Pos.1", "pressure_kpa", {1})},
              targets("[{\"column\":0,\"to\":\"furlong\"}]"), "unknownUnit");
  expectError("missing targets", {makeColumn("Pos.1", "pressure_kpa", {1})}, Json::object(),
              "badSignatureParams");
  expectError("empty targets", {makeColumn("Pos.1", "pressure_kpa", {1})}, targets("[]"),
              "badSignatureParams");
  expectError("column out of range", {makeColumn("Pos.1", "pressure_kpa", {1})},
              targets("[{\"column\":3,\"to\":\"bar\"}]"), "badSignatureParams");
  // ---- LOCKED error precedence (lead 2026-11-18) ----
  // The SOURCE unit is settled before the target is even looked up, so the error names the
  // column the user has to fix.
  // 2+3. A dB source is reported as unitNotScalar even when `to` is unregistered (`furlong`)
  //      and even when the target's dimension would mismatch (`kN`).
  expectError("dB->furlong precedence", {makeColumn("Pos.1", "level_db", {10})},
              targets("[{\"column\":0,\"to\":\"furlong\"}]"), "unitNotScalar");
  expectError("dB->kN precedence", {makeColumn("Pos.1", "level_db", {10})},
              targets("[{\"column\":0,\"to\":\"kN\"}]"), "unitNotScalar");
  // 2. An ambiguous source outranks an unknown target.
  expectError("ambiguous->furlong precedence", {makeColumn("Pos.1", "output_mw", {5})},
              targets("[{\"column\":0,\"to\":\"furlong\"}]"), "unitAmbiguous");
  // 1. A malformed target list outranks every unit problem (column 99 does not exist).
  expectError("bad params precedence", {makeColumn("Pos.1", "output_mw", {5})},
              targets("[{\"column\":99,\"to\":\"furlong\"}]"), "badSignatureParams");
  // 4. A registered source with an unregistered target -> unknownUnit.
  expectError("to unknown", {makeColumn("Pos.1", "pressure_kpa", {1})},
              targets("[{\"column\":0,\"to\":\"stone\"}]"), "unknownUnit");
  // 6. Two registered scalars of different dimensions -> unitMismatch, checked last.
  expectError("pressure->force", {makeColumn("Pos.1", "pressure_kpa", {1})},
              targets("[{\"column\":0,\"to\":\"N\"}]"), "unitMismatch");

  expectError("non-scalar target", {makeColumn("Pos.1", "pressure_kpa", {1})},
              targets("[{\"column\":0,\"to\":\"\u00b0C\"}]"), "unitNotScalar");

  // Error params carry the identity the UI needs to name the offending column/unit.
  {
    UnitConvertResult r = evaluateUnitConvert({makeColumn("Pos.1", "stress_MPa", {1})},
                                              targets("[{\"column\":0,\"to\":\"kN\"}]"));
    const Json* from = r.errorParams.find("from");
    const Json* to = r.errorParams.find("to");
    check(from != nullptr && to != nullptr, "unitMismatch: error params must name from/to");
    if (from && to) {
      check(from->asString() == "MPa", "unitMismatch: from should be MPa");
      check(to->asString() == "kN", "unitMismatch: to should be kN");
    }
  }
}

// ── Annotation rewrite, directly ──────────────────────────────────────────────────────

void runRewriteChecks() {
  const UnitResolution r = resolveUnit("pressure_kpa");
  check(rewriteUnitAnnotation("pressure_kpa", r, "bar") == "pressure_bar",
        "rewrite: suffix replacement");
  const UnitResolution bracket = resolveUnit("\u538b\u529b (MPa)");
  check(rewriteUnitAnnotation("\u538b\u529b (MPa)", bracket, "bar") == "\u538b\u529b (bar)",
        "rewrite: bracket suffix replacement");
  const UnitResolution none = resolveUnit("length");
  check(rewriteUnitAnnotation("length", none, "m") == "length_m", "rewrite: append when no span");
}

// ── Whitespace regressions: span offset (#5) and NBSP trim (#6) ─────────────────────────

void runWhitespaceRegressions() {
  // The span is measured on the trimmed text but must splice the ORIGINAL annotation:
  // leading whitespace shifts the offset, and the rewrite must preserve the spaces.
  const UnitResolution lead = resolveUnit(" pressure (kPa)");
  check(lead.state == UnitState::Recognized && lead.unit == "kPa",
        "span offset: leading-space bracket annotation resolves kPa");
  check(rewriteUnitAnnotation(" pressure (kPa)", lead, "MPa") == " pressure (MPa)",
        "span offset: leading-space bracket rewrite keeps the spaces");
  const UnitResolution leadSuffix = resolveUnit("  pressure_kpa");
  check(rewriteUnitAnnotation("  pressure_kpa", leadSuffix, "bar") == "  pressure_bar",
        "span offset: leading-space underscore rewrite keeps the spaces");
  const UnitResolution trail = resolveUnit("pressure_kpa ");
  check(rewriteUnitAnnotation("pressure_kpa ", trail, "bar") == "pressure_bar ",
        "span offset: trailing space survives the rewrite");

  // U+00A0 is whitespace to JS String.trim(); the C++ boundary trim must agree, or the TS
  // side resolves a unit the C++ side calls unknown.
  const std::string nbsp = "\u00a0";
  const UnitResolution trailing = resolveUnit("temp (kPa)" + nbsp);
  check(trailing.state == UnitState::Recognized && trailing.unit == "kPa",
        "nbsp: trailing-NBSP annotation resolves kPa");
  check(rewriteUnitAnnotation("temp (kPa)" + nbsp, trailing, "MPa") == "temp (MPa)" + nbsp,
        "nbsp: trailing NBSP survives the rewrite");
  const UnitResolution leading = resolveUnit(nbsp + "temp_kpa");
  check(leading.state == UnitState::Recognized && leading.unit == "kPa",
        "nbsp: leading-NBSP annotation resolves kPa");
  check(rewriteUnitAnnotation(nbsp + "temp_kpa", leading, "bar") == nbsp + "temp_bar",
        "nbsp: leading-NBSP rewrite keeps the offset");
  check(normalizeUnitToken(nbsp + "kPa" + nbsp) == "kPa",
        "nbsp: normalizeUnitToken trims NBSP like TS normalizeToken");
}

}  // namespace

int main(int argc, char** argv) {
  const std::string fixture =
      argc >= 2 ? argv[1] : "web/tests/fixtures/units/parse.json";
  runFixture(fixture);
  runFactorChecks();
  runConversionChecks();
  runRewriteChecks();
  runWhitespaceRegressions();

  if (g_failures != 0) {
    std::printf("FAILED: %d check(s)\n", g_failures);
    return 1;
  }
  std::printf("PASS units (resolver fixtures + factors + conversion)\n");
  return 0;
}