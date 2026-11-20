// Column units v1 — the C++ port of `web/src/core/units.ts`.
//
// A unit is a **parsed annotation** of a column, never a value transform: this module only
// answers "which unit does this header name, and is that answer certain?". The conversion card
// (`builtin:unit-convert`) multiplies only when the user names a target; nothing here rewrites
// a stored number (docs/decisions/2026-11-18-units-v1.md).
//
// The two resolvers must agree case for case, so `web/tests/fixtures/units/parse.json` is read
// by BOTH `web/tests/units.test.ts` and `backend/tests/units_test.cpp`. When that fixture is
// green on both sides the registry, the suffix grammar and the ambiguity rules are the same
// table, not two tables that happen to look alike.
//
// Three states, tried in this order:
//   recognized — the registry knows the token and there is exactly one reading;
//   ambiguous  — the token collides (single ASCII letter, `ms`/`mm`/`mw`/`ph`) and a human
//                must confirm it; `candidates` are suggestions, not conclusions;
//   unknown    — not a unit (`ch_001`, `sensor`, `sample_id`).
//
// Deliberate limits (v1, so the resolver never guesses):
//   - units are found only in the `_`-separated suffix or a trailing bracket — never by
//     treating the whole header as a unit;
//   - composite units (`kwh_m2`, `ugm3`, `mm_s`) are table entries, not parsed from a grammar;
//   - `°C`/`°F`/`pH`/`dB`/`HRC`/`AU` are recognised as labels but are not convertible
//     (`scalar: false`) — no affine/log/empirical algebra in v1.
#pragma once

#include <string>
#include <vector>

#include "expression.h"
#include "json.h"
#include "matrix_store.h"

namespace dc {

enum class UnitState { Recognized, Ambiguous, Unknown };

const char* unitStateName(UnitState s);

/** One reading of an ambiguous token. `dimension`/`factor` are empty for non-scalar units. */
struct UnitCandidate {
  std::string unit;           // canonical display spelling, e.g. `mm`, `mM`, `°C`
  std::string dimension;      // `length`, `pressure`, …; empty when not convertible
  double factor = 0.0;        // multiplier to the dimension's base unit
  bool scalar = false;        // false for affine/log/empirical/opaque units — label only
};

/**
 * Offsets of the matched token inside the annotation, in BYTES (UTF-8).
 *
 * Byte offsets, not code points: the only consumer is the annotation rewrite, which splices
 * `annotation.substr()` by the same units it measured. Keeping them byte-based means the
 * rewrite cannot silently land mid-glyph (`地面速度_μm/s` holds a 2-byte and a 3-byte unit).
 */
struct UnitSpan {
  size_t start = 0;
  size_t end = 0;
};

struct UnitResolution {
  UnitState state = UnitState::Unknown;
  std::string unit;           // canonical unit when recognised, else ""
  std::string token;          // raw token the resolver matched ("" for unknown)
  bool hasSpan = false;       // false ⇒ the annotation holds no unit suffix at all
  UnitSpan span;
  std::vector<UnitCandidate> candidates;  // ambiguous readings, registry order
  bool scalar = false;
  std::string dimension;
  double factor = 0.0;
};

/** Micro sign U+00B5 and Greek mu U+03BC are the same prefix in practice. */
std::string normalizeUnitToken(const std::string& raw);

/**
 * Resolve the unit of a column annotation. Never guesses: a colliding token comes back
 * `ambiguous` with its readings, and a header with no unit suffix comes back `unknown`.
 */
UnitResolution resolveUnit(const std::string& annotation);

/** The registry entry for a canonical unit string. False when it is not registered. */
bool candidateByUnit(const std::string& unit, UnitCandidate* out);

/**
 * Rewrite the unit suffix of `annotation` to the canonical `to` string.
 *
 * The resolved span is replaced when there is one; otherwise `"_" + to` is appended, which is
 * the documented behaviour for a column that carries no unit suffix but whose source unit was
 * declared explicitly (`params.targets[].from`).
 */
std::string rewriteUnitAnnotation(const std::string& annotation, const UnitResolution& resolution,
                                  const std::string& to);

// ── `builtin:unit-convert` computation ───────────────────────────────────────

struct UnitConvertResult {
  // The WHOLE input table, same width and same row count: targeted columns converted, every
  // other column passed through verbatim (values AND annotation). Empty on failure.
  std::vector<Column> columns;
  // Structured failure. `errorCode` empty ⇒ success.
  std::string errorCode;
  // Parameter(s) for the error message, rendered by the UI from `code` + these params:
  // unitMismatch{column,from,to}, unitNotScalar{column,unit}, unitAmbiguous{column,token},
  // unitUnknown{column}, unknownUnit{unit}, badSignatureParams{name}.
  Json errorParams = Json::object();
};

/**
 * Convert the targeted columns of `input` to their requested units.
 *
 * `params.targets` (array of `{column: <0-based index>, from?: <unit>, to: <unit>}`) is the
 * whole contract; absent / empty / malformed is `badSignatureParams`. Everything is validated
 * before a single number is written, so a failed conversion never publishes a half-converted
 * table — the card model's "never silently convert" rule (decision §四).
 */
UnitConvertResult evaluateUnitConvert(const std::vector<Column>& input, const Json& params);

// ── Unit warnings (L1b, additive) ────────────────────────────────────────────
//
// A WARNING is not a failure: it never changes a number, an error code or a node state. It
// exists because `height_mm + pressure_kpa` is a number the engine happily computes and a
// human should not have to find by eye (docs/tasks/2026-11-19-units-l1.md §L1b / B1).
struct UnitWarning {
  // "unitMismatch" is the only code today; keep it a field so a later kind (`unitMissing`,
  // `unitAmbiguous`) is additive rather than a protocol change.
  std::string code = "unitMismatch";
  std::string left;   // column label of the left operand, as the table spells it
  std::string right;  // column label of the right operand
  std::string op;     // `+`, `-`, `>`, `<`, `>=`, `<=`, `==`, `!=` or `IF`
};

/** DTO shape of one warning: `{code, left, right, op}`. */
Json unitWarningToJson(const UnitWarning& warning);

/**
 * Static check of one expression's column operands.
 *
 * Only DIRECT column-reference operands of `+`, `-`, the six comparisons and the two `IF`
 * branches are inspected (nested calls, literals, `-A` and sub-expressions are skipped).
 * Both sides are resolved with `resolveUnit` on their ANNOTATION — the label is flattened
 * ("Pos.1 pressure_kpa"), so it is split with Matrix::labelParsed first — and a warning is
 * emitted ONLY when both sides are `recognized` AND their dimensions differ. Ambiguous,
 * unknown and non-convertible (empty-dimension) units prove nothing and stay silent: the
 * contract is "report only what is provable", never "warn because we are unsure".
 *
 * `columnLabels` is the flat label list of the input table (the same list the expression
 * engine resolves names against). Returns an empty vector for an unparsable expression —
 * the parser's own error is the caller's business, not the checker's.
 */
std::vector<UnitWarning> checkExpressionUnitWarnings(
    const std::string& expression, const std::vector<std::string>& columnLabels,
    const std::vector<AliasRange>& aliases = {});

}  // namespace dc