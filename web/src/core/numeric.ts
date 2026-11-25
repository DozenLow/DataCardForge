/**
 * Numeric parsing helpers — a lightweight stand-in for `fast_float`.
 *
 * JavaScript's `Number()` accepts a handful of literals that C++'s `from_chars`
 * rejects (`Infinity`, `0x10`, `1e`), so `parseNumeric` narrows the grammar to the
 * shapes a measurement file actually produces: optional sign, decimal digits,
 * optional fraction, optional exponent.
 */

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** True when the token is a plain decimal number (C++ `is_numeric` semantics). */
export function isNumeric(token: string): boolean {
  return NUMERIC_RE.test(token);
}

/**
 * Spellings of "this cell holds no number" that measurement files actually contain.
 *
 * Exports from Python/pandas, HDF5 and most instrument software write missing values as
 * `NaN`; read literally that is a text token, which made a column of numbers look like a
 * text column and refused the whole file. Treating it as an empty cell is what the producer
 * meant, and it keeps `isNumeric` strict about everything else.
 *
 * Deliberately NOT here: `inf`/`-inf` (a value, not a gap), and `NA`/`N/A`/`-`, which are
 * ALSO plausible category labels in a group column — guessing would relabel real data.
 */
const MISSING_TOKEN_RE = /^[+-]?nan$/i;

/** True when a cell carries no number at all: empty, or a NaN spelling. */
export function isMissingToken(token: string): boolean {
  return token === '' || MISSING_TOKEN_RE.test(token);
}

/** Parse a token, returning `fallback` when it is not a plain decimal number. */
export function parseNumeric(token: string, fallback = NaN): number {
  if (!NUMERIC_RE.test(token)) return fallback;
  return Number(token);
}

/** Format a value for display with the shortest text that round-trips to the same double.
 *
 * This replaces `toPrecision(6)` (the Qt `%.6g` behaviour). The reason is not aesthetics:
 * six digits could not distinguish a column of measurements around 1e6 — `1000000.0004813797`
 * and `1000000` both rendered as `1e+6`, so 3000 rows of real data looked like one repeated
 * value and the table showed no evidence that anything was wrong.
 *
 * Shortest-round-trip spends digits only where they carry information: `0.5` stays `0.5`,
 * while `1/3` shows all 16 digits that actually identify it. */
export function formatCell(value: number): string {
  if (Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  if (value === 0) return '0';
  // Exponent spelling stays C-like (`1e-07`, not `1e-7`): exported text and the documents
  // disagreeing about the same number is worse than a slightly wider cell.
  return String(value).replace(/e([+-])(\d)$/, 'e$10$2');
}
