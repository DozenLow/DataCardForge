/**
 * Column units v1 — registry, suffix resolver and signature hash.
 *
 * A unit is a **parsed annotation** of a column, never a value transform: this module only
 * answers "which unit does this header name, and is that answer certain?". Nothing here
 * multiplies a stored number; `docs/decisions/2026-11-18-units-v1.md` is the contract.
 *
 * Three states, tried in this order:
 *   recognized — the registry knows the token and there is exactly one reading;
 *   ambiguous  — the token collides (single ASCII letter, `ms`/`mm`/`mw`/`ph`) and a human
 *                must confirm it; `candidates` are suggestions, not conclusions;
 *   unknown    — not a unit (`ch_001`, `sensor`, `sample_id`).
 *
 * Deliberate limits (v1, so the resolver never guesses):
 *   - units are found only in the `_`-separated suffix or a trailing bracket — never by
 *     treating the whole header as a unit;
 *   - composite units (`kwh_m2`, `ugm3`, `mm_s`) are table entries, not parsed from a
 *     grammar;
 *   - `°C`/`°F`/`pH`/`dB`/`HRC`/`au` are recognised as labels but are not convertible
 *     (`scalar: false`) — no affine/log/empirical algebra in v1.
 */

export type UnitState = 'recognized' | 'ambiguous' | 'unknown';

export interface UnitCandidate {
  /** Canonical display spelling, e.g. `mm`, `mM`, `°C`. */
  readonly unit: string;
  /** Dimension id (`length`, `pressure`, …); `null` when the unit is not convertible. */
  readonly dimension: string | null;
  /** Multiplier to the dimension's base unit; `null` when the unit is not convertible. */
  readonly factor: number | null;
  /** False for affine/log/empirical/opaque units — label only, never converted. */
  readonly scalar: boolean;
}

export interface UnitResolution {
  readonly state: UnitState;
  /** Canonical unit when recognised, else `''`. */
  readonly unit: string;
  /** Raw token the resolver matched (empty for `unknown`). */
  readonly token: string;
  /** Where the token sits inside the annotation (used when rewriting the suffix later). */
  readonly span: { readonly start: number; readonly end: number } | null;
  /** Suggestions for an ambiguous token in resolver order; empty otherwise. Not a ranking. */
  readonly candidates: readonly UnitCandidate[];
  readonly scalar: boolean;
  readonly dimension: string | null;
  readonly factor: number | null;
}

interface Entry extends UnitCandidate {
  /** Spellings accepted verbatim; case folding covers the rest. */
  readonly spellings: readonly string[];
}

/** Micro sign U+00B5 and Greek mu U+03BC are the same prefix in practice. */
function normalizeToken(raw: string): string {
  return raw.trim().replace(/\u03bc/g, '\u00b5');
}

/** Exported so group matching compares tokens the same way the resolver normalises them. */
export function normalizeUnitToken(raw: string): string {
  return normalizeToken(raw);
}

const PREFIX_FACTOR: ReadonlyMap<string, number> = new Map([
  ['n', 1e-9],
  ['µ', 1e-6],
  ['m', 1e-3],
  ['c', 1e-2],
  ['d', 1e-1],
  ['h', 1e2],
  ['k', 1e3],
  ['M', 1e6],
  ['G', 1e9],
]);

interface BaseDef {
  readonly symbol: string;
  readonly dimension: string;
  readonly factor: number;
  /** Prefixes this base is normally written with — curated, so `mV` exists but `MV` does not. */
  readonly prefixes: readonly string[];
}

const BASES: readonly BaseDef[] = [
  { symbol: 'm', dimension: 'length', factor: 1, prefixes: ['n', 'µ', 'm', 'c', 'k', 'M'] },
  { symbol: 'g', dimension: 'mass', factor: 1e-3, prefixes: ['µ', 'm', 'k'] },
  { symbol: 's', dimension: 'time', factor: 1, prefixes: ['n', 'µ', 'm', 'k', 'M'] },
  { symbol: 'A', dimension: 'current', factor: 1, prefixes: ['µ', 'm', 'k'] },
  { symbol: 'V', dimension: 'voltage', factor: 1, prefixes: ['µ', 'm', 'k'] },
  { symbol: 'W', dimension: 'power', factor: 1, prefixes: ['µ', 'm', 'k', 'M', 'G'] },
  { symbol: 'J', dimension: 'energy', factor: 1, prefixes: ['m', 'k', 'M', 'G'] },
  { symbol: 'N', dimension: 'force', factor: 1, prefixes: ['µ', 'm', 'k', 'M'] },
  { symbol: 'Pa', dimension: 'pressure', factor: 1, prefixes: ['m', 'h', 'k', 'M', 'G'] },
  { symbol: 'Hz', dimension: 'frequency', factor: 1, prefixes: ['m', 'k', 'M', 'G'] },
  { symbol: 'L', dimension: 'volume', factor: 1e-3, prefixes: ['µ', 'm', 'd'] },
  { symbol: 'mol', dimension: 'amount', factor: 1, prefixes: ['n', 'µ', 'm'] },
  { symbol: 'K', dimension: 'temperature_absolute', factor: 1, prefixes: ['m'] },
  { symbol: 'bar', dimension: 'pressure', factor: 1e5, prefixes: ['m'] },
];

const entries: Entry[] = [];

function register(entry: Entry): void {
  entries.push(entry);
}

for (const base of BASES) {
  register({
    unit: base.symbol,
    dimension: base.dimension,
    factor: base.factor,
    scalar: true,
    spellings: [base.symbol],
  });
  for (const prefix of base.prefixes) {
    const multiplier = PREFIX_FACTOR.get(prefix);
    if (multiplier === undefined) continue;
    const unit = `${prefix}${base.symbol}`;
    const spellings = [unit];
    // `um` is how half of the world types `µm`; both must resolve to the same entry.
    if (prefix === 'µ') spellings.push(`u${base.symbol}`);
    register({
      unit,
      dimension: base.dimension,
      factor: base.factor * multiplier,
      scalar: true,
      spellings,
    });
  }
}

// ── Composite / non-prefix units (table entries, no grammar) ─────────────────────────

interface ExtraDef {
  readonly unit: string;
  readonly dimension: string | null;
  readonly factor: number | null;
  readonly scalar: boolean;
  readonly spellings: readonly string[];
}

const EXTRAS: readonly ExtraDef[] = [
  { unit: 'min', dimension: 'time', factor: 60, scalar: true, spellings: ['min'] },
  { unit: 'h', dimension: 'time', factor: 3600, scalar: true, spellings: ['h'] },
  { unit: 'd', dimension: 'time', factor: 86400, scalar: true, spellings: ['d'] },
  { unit: 'rpm', dimension: 'frequency', factor: 1 / 60, scalar: true, spellings: ['rpm'] },
  {
    unit: 'L/min',
    dimension: 'flow',
    factor: 1e-3 / 60,
    scalar: true,
    spellings: ['L/min', 'L_min', 'lpm'],
  },
  {
    unit: 'm/s',
    dimension: 'velocity',
    factor: 1,
    scalar: true,
    spellings: ['m/s', 'm_s', 'ms'],
  },
  {
    unit: 'mm/s',
    dimension: 'velocity',
    factor: 1e-3,
    scalar: true,
    spellings: ['mm/s', 'mm_s'],
  },
  { unit: 'N·m', dimension: 'torque', factor: 1, scalar: true, spellings: ['N·m', 'N_m', 'Nm'] },
  { unit: 'A·h', dimension: 'charge', factor: 3600, scalar: true, spellings: ['A·h', 'Ah', 'AH'] },
  { unit: 'kWh', dimension: 'energy', factor: 3.6e6, scalar: true, spellings: ['kWh'] },
  {
    unit: 'kWh/m²',
    dimension: 'energy_per_area',
    factor: 3.6e6,
    scalar: true,
    spellings: ['kWh/m²', 'kWh_m2', 'kwh_m2'],
  },
  {
    unit: 'W/m²',
    dimension: 'power_per_area',
    factor: 1,
    scalar: true,
    spellings: ['W/m²', 'W_m2', 'wm2'],
  },
  {
    unit: 'mg/L',
    dimension: 'mass_concentration',
    factor: 1e-3,
    scalar: true,
    spellings: ['mg/L', 'mg_l'],
  },
  {
    unit: 'µg/m³',
    dimension: 'mass_concentration',
    factor: 1e-9,
    scalar: true,
    spellings: ['µg/m³', 'ug/m3', 'ugm3'],
  },
  {
    unit: 'µmol/min',
    dimension: 'molar_flow',
    factor: 1e-6 / 60,
    scalar: true,
    spellings: ['µmol/min', 'umol_min'],
  },
  { unit: 'mM', dimension: 'molar_concentration', factor: 1, scalar: true, spellings: ['mM'] },
  { unit: 'pct', dimension: 'ratio', factor: 1e-2, scalar: true, spellings: ['pct', '%'] },
  { unit: 'ppm', dimension: 'ratio', factor: 1e-6, scalar: true, spellings: ['ppm'] },
  { unit: 'ppb', dimension: 'ratio', factor: 1e-9, scalar: true, spellings: ['ppb'] },
  { unit: 'µε', dimension: 'strain', factor: 1e-6, scalar: true, spellings: ['µε', 'ue'] },
  { unit: 'kUSD', dimension: 'currency_usd', factor: 1e3, scalar: true, spellings: ['kUSD', 'kusd'] },
  // Opaque: readable label, no conversion, no algebra.
  { unit: 'AU', dimension: null, factor: null, scalar: false, spellings: ['AU', 'au'] },
  // Non-scalar: affine / logarithmic / empirical scales — the v1 decision keeps them as labels.
  {
    unit: '°C',
    dimension: null,
    factor: null,
    scalar: false,
    spellings: ['℃', '°C', '°c', 'c', 'C', 'degC', 'degc'],
  },
  {
    unit: '°F',
    dimension: null,
    factor: null,
    scalar: false,
    spellings: ['℉', '°F', '°f', 'degF', 'degf'],
  },
  { unit: 'pH', dimension: null, factor: null, scalar: false, spellings: ['pH', 'ph'] },
  { unit: 'dB', dimension: null, factor: null, scalar: false, spellings: ['dB', 'db'] },
  { unit: 'dBm', dimension: null, factor: null, scalar: false, spellings: ['dBm', 'dbm'] },
  { unit: 'HRC', dimension: null, factor: null, scalar: false, spellings: ['HRC', 'hrc'] },
  { unit: 'HV', dimension: null, factor: null, scalar: false, spellings: ['HV', 'hv'] },
  { unit: 'HB', dimension: null, factor: null, scalar: false, spellings: ['HB', 'hb'] },
];

for (const extra of EXTRAS) {
  register({
    unit: extra.unit,
    dimension: extra.dimension,
    factor: extra.factor,
    scalar: extra.scalar,
    spellings: extra.spellings,
  });
}

const EXACT: ReadonlyMap<string, Entry> = (() => {
  const map = new Map<string, Entry>();
  for (const entry of entries) {
    for (const spelling of entry.spellings) {
      if (!map.has(spelling)) map.set(spelling, entry);
    }
  }
  return map;
})();

const FOLDED: ReadonlyMap<string, readonly Entry[]> = (() => {
  const map = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const spelling of entry.spellings) {
      const key = spelling.toLowerCase();
      const bucket = map.get(key);
      if (!bucket) map.set(key, [entry]);
      else if (!bucket.includes(entry)) bucket.push(entry);
    }
  }
  return map;
})();

const BY_UNIT: ReadonlyMap<string, Entry> = (() => {
  const map = new Map<string, Entry>();
  for (const entry of entries) {
    if (!map.has(entry.unit)) map.set(entry.unit, entry);
  }
  return map;
})();

/** The registry entry for a canonical unit string, or `null` when it is not registered. */
export function candidateByUnit(unit: string): UnitCandidate | null {
  return BY_UNIT.get(unit) ?? null;
}

/**
 * Tokens whose one spelling has two readings. They are ambiguous even when the exact
 * spelling would resolve, because the collision is semantic (`time_ms` vs `wind_ms`).
 */
const AMBIGUOUS_TOKENS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ms', ['ms', 'm/s']],
  ['mm', ['mm', 'mM']],
  ['mw', ['mW', 'MW']],
  ['ph', ['pH']],
]);

/** Header suffixes that are never units (`batch_no`, `sample_id`, `line_a_units`). */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  'id',
  'no',
  'num',
  'nr',
  'index',
  'idx',
  'unit',
  'units',
  'qty',
  'count',
]);

/** Single ASCII letters are index/group names far more often than units (`sensor_a`). */
const SINGLE_LETTER = /^[A-Za-z]$/;

/** `001`, `1.5` — a column counter, not a unit. */
const NUMERIC = /^\d+(?:[.,]\d+)?$/;

const BRACKET_SUFFIX = /[(（[［【]\s*([^()（）[\]［］【】]+?)\s*[)）\]］】]\s*$/;

interface Suffix {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Candidate unit suffixes of one annotation, longest first.
 *
 * `vibration_mm_s` offers `mm_s` before `s`; the bracket form (`压力 (MPa)`) is tried after
 * every underscore suffix so `压力_MPa (bar)` cannot silently read as `bar`.
 */
function suffixes(annotation: string): Suffix[] {
  const out: Suffix[] = [];

  const parts: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i <= annotation.length; i += 1) {
    if (i === annotation.length || annotation[i] === '_') {
      parts.push({ text: annotation.slice(start, i), start });
      start = i + 1;
    }
  }
  for (let count = parts.length - 1; count >= 1; count -= 1) {
    const from = parts.length - count;
    const token = parts.slice(from).map((part) => part.text).join('_');
    out.push({ token, start: parts[from].start, end: annotation.length });
  }

  const bracket = BRACKET_SUFFIX.exec(annotation);
  if (bracket) {
    const inner = bracket[1] ?? '';
    const offset = bracket[0].indexOf(inner);
    if (inner !== '' && offset >= 0) {
      const base = annotation.length - bracket[0].length;
      out.push({ token: inner, start: base + offset, end: base + offset + inner.length });
    }
  }

  return out;
}

function unknown(token: string, span: Suffix | null): UnitResolution {
  return {
    state: 'unknown',
    unit: '',
    token,
    span: span ? { start: span.start, end: span.end } : null,
    candidates: [],
    scalar: false,
    dimension: null,
    factor: null,
  };
}

function ambiguous(token: string, span: Suffix, candidates: readonly Entry[]): UnitResolution {
  return {
    state: 'ambiguous',
    unit: '',
    token,
    span: { start: span.start, end: span.end },
    candidates: candidates.map((entry) => ({
      unit: entry.unit,
      dimension: entry.dimension,
      factor: entry.factor,
      scalar: entry.scalar,
    })),
    scalar: false,
    dimension: null,
    factor: null,
  };
}

function recognized(entry: Entry, token: string, span: Suffix): UnitResolution {
  return {
    state: 'recognized',
    unit: entry.unit,
    token,
    span: { start: span.start, end: span.end },
    candidates: [],
    scalar: entry.scalar,
    dimension: entry.dimension,
    factor: entry.factor,
  };
}

function lookup(token: string): readonly Entry[] {
  const exact = EXACT.get(token);
  if (exact) return [exact];
  return FOLDED.get(token.toLowerCase()) ?? [];
}

/**
 * Resolve the unit of a column annotation. Never guesses: a colliding token comes back
 * `ambiguous` with its readings, and a header with no unit suffix comes back `unknown`.
 */
export function resolveUnit(annotation: string): UnitResolution {
  const text = annotation.trim();
  if (text === '') return unknown('', null);

  for (const suffix of suffixes(text)) {
    const token = normalizeToken(suffix.token);
    if (token === '' || NUMERIC.test(token) || STOP_TOKENS.has(token.toLowerCase())) continue;

    const override = AMBIGUOUS_TOKENS.get(token.toLowerCase());
    if (override) {
      const candidates: Entry[] = [];
      for (const unit of override) {
        const entry = BY_UNIT.get(unit);
        if (entry) candidates.push(entry);
      }
      return ambiguous(token, suffix, candidates);
    }

    const hits = lookup(token);
    if (hits.length === 0) continue;
    if (hits.length > 1) return ambiguous(token, suffix, hits);

    const entry = hits[0];
    if (SINGLE_LETTER.test(token)) return ambiguous(token, suffix, [entry]);
    return recognized(entry, token, suffix);
  }

  return unknown('', null);
}

/** A confirmation stored as "the user says this column has no unit". */
export const NO_UNIT = 'none';

/**
 * Apply a remembered confirmation on top of the parse.
 *
 * `undefined`/`null` means "never confirmed" (the resolver's own answer); `NO_UNIT` means
 * the user explicitly rejected a unit; anything else must name a registry unit — an unknown
 * string falls back to the parse instead of inventing a unit.
 */
export function resolveConfirmed(
  annotation: string,
  confirmed: string | null | undefined,
): UnitResolution {
  const base = resolveUnit(annotation);
  if (confirmed === undefined || confirmed === null) return base;
  if (confirmed === NO_UNIT) {
    return {
      state: 'unknown',
      unit: '',
      token: base.token,
      span: base.span,
      candidates: [],
      scalar: false,
      dimension: null,
      factor: null,
    };
  }
  const candidate = candidateByUnit(confirmed);
  if (!candidate) return base;
  return {
    state: 'recognized',
    unit: candidate.unit,
    token: base.token,
    span: base.span,
    candidates: [],
    scalar: candidate.scalar,
    dimension: candidate.dimension,
    factor: candidate.factor,
  };
}

/**
 * Deterministic key for "this column vector's unit signature".
 *
 * Confirmations are remembered per signature so the same file (and any other matrix with
 * the same headers in the same order) is asked only once — the user's rule for repeated
 * matrices. FNV-1a is enough: this is a cache key, not a security boundary.
 */
export function unitSignature(annotations: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const annotation of annotations) {
    for (let i = 0; i < annotation.length; i += 1) {
      hash ^= annotation.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${annotations.length}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Confirmation memory: column-unit signature → column index → confirmed unit (or `NO_UNIT`).
 *
 * Keyed by signature, not by matrix id, so the same headers in the same order — a re-opened
 * file, or a second card reading the same file — reuse the answer without asking again.
 */
export type UnitConfirmations = Readonly<Record<string, Readonly<Record<number, string>>>>;

export interface MatrixUnitView {
  readonly signature: string;
  /** One resolution per column, in column order, with confirmations already applied. */
  readonly resolutions: readonly UnitResolution[];
}

/**
 * Derive every column's unit for one matrix. Pure: the matrix stores no unit, this is always
 * `annotation + confirmation memory`, recomputed at read time so a confirm never has to
 * mutate (or re-serialise) the data.
 */
export function columnUnitResolutions(
  annotations: readonly string[],
  confirmations: UnitConfirmations,
): MatrixUnitView {
  const signature = unitSignature(annotations);
  const perColumn = confirmations[signature];
  const resolutions = annotations.map((annotation, index) =>
    resolveConfirmed(annotation, perColumn?.[index]),
  );
  return { signature, resolutions };
}
