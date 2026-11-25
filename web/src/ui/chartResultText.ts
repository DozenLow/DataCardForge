/**
 * Turning a chart card's backend answer into a sentence the user can act on.
 *
 * A refused fit is not a transport failure: `POST /nodes/{id}/compute` answers with
 * `state:"error"` plus a stable `code` and a structured `params` (e.g. `fitFailed` +
 * `{reason:"tooFewPoints"}`). Printing the code is no better than printing nothing, and
 * substituting a different error is worse — it blames the wiring for a data problem.
 *
 * This module owns the two translations the card needs:
 *
 *   - failure   : (code, params) → one i18n key + its variables
 *   - parameters: the fitted numbers the summary matrix already carries, said in words
 *
 * It is deliberately pure and DOM-free: a new backend code has exactly one place to be
 * registered, and the mapping can be exercised without mounting a chart. Nothing here
 * computes anything — the numbers arrive from the backend; this only decides how to name
 * them and how many digits to show.
 */

import type { MessageKey } from './i18n.ts';

export interface ResultText {
  key: MessageKey;
  vars: Record<string, string>;
}

type FailureKind = 'analysis' | 'filter';

interface FailureInput {
  code?: string;
  params?: Record<string, unknown>;
}

/** Reason codes each node publishes under `params.reason`, mapped to one sentence each. */
const ANALYSIS_REASONS: Record<string, MessageKey> = {
  tooFewPoints: 'chart.fail.tooFewPoints',
  notConverged: 'chart.fail.notConverged',
  nonPositiveX: 'chart.fail.nonPositiveX',
};

const FILTER_REASONS: Record<string, MessageKey> = {
  tooFewPoints: 'chart.fail.tooFewPoints',
  nonUniformX: 'chart.fail.nonUniformX',
  invalidFrequency: 'chart.fail.invalidFrequency',
};

/**
 * Parameter names the backend reports under `badSignatureParams`. They are wire names
 * (`initial`, `lower` …), not the labels on this screen, so they get translated when known
 * and passed through unchanged when not — an unknown name is still the most useful thing a
 * bug report can carry.
 */
const PARAMETER_NAMES: Record<string, MessageKey> = {
  parameters: 'chart.param.parameters',
  model: 'chart.param.model',
  weighting: 'chart.param.weighting',
  confidence: 'chart.param.confidence',
  throughOrigin: 'chart.param.throughOrigin',
  initial: 'chart.param.initial',
  lower: 'chart.param.lower',
  upper: 'chart.param.upper',
  bounds: 'chart.param.bounds',
  mode: 'chart.param.mode',
  order: 'chart.param.order',
  cutoffHz: 'chart.param.cutoffHz',
  sampleRateHz: 'chart.param.sampleRateHz',
};

function reasonOf(params: Record<string, unknown> | undefined): string {
  const reason = params?.reason;
  return typeof reason === 'string' ? reason : '';
}

/** Translate a parameter name when the table knows it, else keep the wire name. */
export function parameterName(name: string, translate: (key: MessageKey) => string): string {
  const key = PARAMETER_NAMES[name];
  return key ? translate(key) : name;
}

/**
 * Why the run stopped. `translate` is passed in only so the parameter name can be said in
 * the reader's language; the caller still owns the final `t(text.key, text.vars)`.
 */
export function failureText(
  kind: FailureKind,
  run: FailureInput,
  translate: (key: MessageKey) => string = (key) => key,
): ResultText {
  const code = run.code ?? 'internalError';
  const reason = reasonOf(run.params);

  // This client's own refusals reuse transport-looking codes, so they are recognised by the
  // reason first: "no column bound yet" is not "the backend is offline".
  if (reason === 'unboundInput') return { key: 'chart.fail.unbound', vars: {} };
  if (reason === 'outputCount' || reason === 'outputSchema') {
    return { key: 'chart.fail.outputShape', vars: {} };
  }

  switch (code) {
    case 'fitFailed':
    case 'filterFailed': {
      const known =
        (kind === 'filter' ? FILTER_REASONS : ANALYSIS_REASONS)[reason] ??
        (kind === 'filter' ? ANALYSIS_REASONS : FILTER_REASONS)[reason];
      if (known) return { key: known, vars: {} };
      // A weighting refusal carries a whole sentence in `reason`; show it rather than
      // dropping the only explanation the backend gave.
      return {
        key: kind === 'filter' ? 'chart.fail.filterRefused' : 'chart.fail.fitRefused',
        vars: { reason: reason || '—' },
      };
    }
    case 'badSignatureParams':
      return {
        key: 'chart.fail.badParams',
        vars: { field: parameterName(reason || 'parameters', translate) },
      };
    case 'unknownSignature':
      return { key: 'chart.fail.unknownSignature', vars: {} };
    case 'backendUnavailable':
      return { key: 'chart.fail.backendUnavailable', vars: {} };
    case 'resultTruncated':
      return { key: 'chart.fail.resultTruncated', vars: {} };
    case 'internalError':
      return { key: 'chart.fail.outputShape', vars: {} };
    default:
      return { key: 'chart.fail.unknown', vars: { code } };
  }
}

/** Shortest round-trip-ish spelling: four significant digits, exponent form at the edges. */
export function formatFitNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e6) return String(Number(value.toPrecision(4)));
  return value.toExponential(2);
}

/** `"+ 0.4"` / `"− 0.4"` — the sign is part of the term, so the equation reads as written. */
function signedTerm(value: number): string {
  return `${value < 0 ? '−' : '+'} ${formatFitNumber(Math.abs(value))}`;
}

/**
 * The fitted numbers, in the shape that model is usually written.
 *
 * The summary matrix carries all of them (`slope`, `intercept`, `a`…`d`), and they mean
 * different things per model — `a` is the slope of a line but the amplitude of a power law —
 * so the label has to come from the model, never from the column name alone.
 */
export function parameterText(
  model: string,
  summary: Record<string, number>,
): ResultText | null {
  const value = (name: string): number => {
    const found = summary[name];
    return typeof found === 'number' ? found : Number.NaN;
  };

  switch (model) {
    case 'linear': {
      const slope = value('slope');
      const intercept = value('intercept');
      if (!Number.isFinite(slope)) return null;
      if (!Number.isFinite(intercept) || intercept === 0) {
        return { key: 'chart.fit.linearNoIntercept', vars: { slope: formatFitNumber(slope) } };
      }
      return {
        key: 'chart.fit.linear',
        vars: { slope: formatFitNumber(slope), intercept: signedTerm(intercept) },
      };
    }
    case 'exponential': {
      const a = value('a');
      const b = value('b');
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { key: 'chart.fit.exponential', vars: { a: formatFitNumber(a), b: formatFitNumber(b) } };
    }
    case 'power': {
      const a = value('a');
      const b = value('b');
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { key: 'chart.fit.power', vars: { a: formatFitNumber(a), b: formatFitNumber(b) } };
    }
    case '4pl': {
      const numbers = ['a', 'b', 'c', 'd'].map(value);
      if (numbers.some((entry) => !Number.isFinite(entry))) return null;
      return {
        key: 'chart.fit.fourpl',
        vars: { a: formatFitNumber(numbers[0]), b: formatFitNumber(numbers[1]), c: formatFitNumber(numbers[2]), d: formatFitNumber(numbers[3]) },
      };
    }
    default:
      return null;
  }
}

/**
 * LOD/LOQ, or an honest refusal.
 *
 * Both are only defined for a straight-line calibration whose residual scatter is not zero
 * (`3.3σ/S`). A perfect fit makes σ zero, and "LOD = 0" reads like a measurement result
 * rather than the absence of one — so say the estimate is unavailable instead of showing it.
 */
export function limitsText(
  model: string,
  summary: Record<string, number>,
): ResultText | null {
  if (model !== 'linear') return null;
  const lod = summary.lod;
  const loq = summary.loq;
  const sigma = summary.residualStandardError;
  const slope = summary.slope;
  if (
    typeof lod === 'number' && typeof loq === 'number' &&
    Number.isFinite(lod) && Number.isFinite(loq) &&
    typeof sigma === 'number' && sigma > 0 &&
    typeof slope === 'number' && slope !== 0
  ) {
    return {
      key: 'chart.analysisLimits',
      vars: { lod: formatFitNumber(lod), loq: formatFitNumber(loq) },
    };
  }
  return { key: 'chart.analysisLimitsUnknown', vars: {} };
}