/**
 * What the fit panel says, without a DOM.
 *
 * Two rules are pinned here:
 *
 *   1. A refused computation is named by its REASON (`tooFewPoints`, `nonUniformX`), never by
 *      its wire code — the code is what the panel used to print, and printing it told the user
 *      nothing they could act on.
 *   2. A code this client invents itself (`unboundInput` under `backendUnavailable`) must not
 *      be mistaken for a transport failure. "No column selected yet" and "the backend is
 *      offline" send the user to two different places.
 *
 * The last block reads the numbers back out of the summary matrix, where `a` means the slope of
 * a line but the amplitude of a power law — so the label has to follow the model.
 */
import { describe, expect, it } from 'vitest';

import {
  failureText,
  formatFitNumber,
  limitsText,
  parameterName,
  parameterText,
} from '../src/ui/chartResultText.ts';
import { translatorFor } from '../src/ui/i18n.ts';

const zh = translatorFor('zh');
const en = translatorFor('en');

describe('failureText — analysis', () => {
  it('names a fit that ran out of points by its reason', () => {
    const text = failureText('analysis', { code: 'fitFailed', params: { reason: 'tooFewPoints' } });
    expect(text.key).toBe('chart.fail.tooFewPoints');
    expect(zh(text.key, text.vars)).toContain('点数');
    expect(zh(text.key, text.vars)).not.toContain('tooFewPoints');
  });

  it('names a non-converged fit and a non-positive-X refusal', () => {
    expect(failureText('analysis', { code: 'fitFailed', params: { reason: 'notConverged' } }).key)
      .toBe('chart.fail.notConverged');
    expect(failureText('analysis', { code: 'fitFailed', params: { reason: 'nonPositiveX' } }).key)
      .toBe('chart.fail.nonPositiveX');
  });

  it('points at the offending field when the parameters are refused', () => {
    const text = failureText(
      'analysis',
      { code: 'badSignatureParams', params: { reason: 'initial' } },
      zh,
    );
    expect(text.key).toBe('chart.fail.badParams');
    // The wire name `initial` must become the label the panel shows, or the user cannot
    // find the field the backend is complaining about.
    expect(text.vars.field).toBe('初值');
    expect(zh(text.key, text.vars)).toContain('初值');
  });

  it('keeps an unknown parameter name rather than inventing a label', () => {
    expect(parameterName('somethingNew', zh)).toBe('somethingNew');
    expect(parameterName('somethingNew', en)).toBe('somethingNew');
  });

  it('reads "no column bound yet" as that, not as an offline backend', () => {
    // The store publishes this one with the transport code, so the reason has to win.
    const text = failureText('analysis', {
      code: 'backendUnavailable',
      params: { reason: 'unboundInput' },
    });
    expect(text.key).toBe('chart.fail.unbound');

    const offline = failureText('analysis', { code: 'backendUnavailable' });
    expect(offline.key).toBe('chart.fail.backendUnavailable');
  });

  it('separates a wiring fault from a data fault', () => {
    expect(failureText('analysis', { code: 'internalError', params: { reason: 'outputSchema' } }).key)
      .toBe('chart.fail.outputShape');
    expect(zh('chart.fail.outputShape')).toContain('不是数据问题');
  });

  it('says the backend is older when it does not know the signature', () => {
    expect(failureText('analysis', { code: 'unknownSignature' }).key)
      .toBe('chart.fail.unknownSignature');
  });

  it('still shows an unregistered code, labelled as a code', () => {
    const text = failureText('analysis', { code: 'brandNewCode' });
    expect(text.key).toBe('chart.fail.unknown');
    expect(text.vars.code).toBe('brandNewCode');
  });

  it('keeps the backend\'s own sentence when a weighting refusal carries one', () => {
    const text = failureText('analysis', { code: 'fitFailed', params: { reason: 'weight is zero' } });
    expect(text.key).toBe('chart.fail.fitRefused');
    expect(text.vars.reason).toBe('weight is zero');
  });
});

describe('failureText — filter', () => {
  it('explains an unevenly spaced X and a bad cutoff', () => {
    expect(failureText('filter', { code: 'filterFailed', params: { reason: 'nonUniformX' } }).key)
      .toBe('chart.fail.nonUniformX');
    expect(failureText('filter', { code: 'filterFailed', params: { reason: 'invalidFrequency' } }).key)
      .toBe('chart.fail.invalidFrequency');
  });

  it('does not say "fit" when the filter refused', () => {
    expect(failureText('filter', { code: 'filterFailed', params: { reason: 'other' } }).key)
      .toBe('chart.fail.filterRefused');
  });
});

describe('every key the mapper can emit exists in both languages', () => {
  const cases = [
    failureText('analysis', { code: 'fitFailed', params: { reason: 'tooFewPoints' } }),
    failureText('analysis', { code: 'fitFailed', params: { reason: 'notConverged' } }),
    failureText('analysis', { code: 'fitFailed', params: { reason: 'nonPositiveX' } }),
    failureText('analysis', { code: 'fitFailed', params: { reason: 'unlisted' } }),
    failureText('analysis', { code: 'badSignatureParams', params: { reason: 'lower' } }),
    failureText('analysis', { code: 'unknownSignature' }),
    failureText('analysis', { code: 'backendUnavailable' }),
    failureText('analysis', { code: 'resultTruncated' }),
    failureText('analysis', { code: 'internalError' }),
    failureText('analysis', { code: 'whatever' }),
    failureText('filter', { code: 'filterFailed', params: { reason: 'nonUniformX' } }),
    failureText('filter', { code: 'filterFailed', params: { reason: 'invalidFrequency' } }),
    failureText('filter', { code: 'filterFailed', params: { reason: 'tooFewPoints' } }),
  ];

  it.each(cases.map((text) => [text.key, text.vars] as const))(
    '%s is translated in zh and en',
    (key, vars) => {
      // `createTranslator` falls back to the key itself, so "differs from the key" is the
      // test for "this string was actually registered".
      expect(zh(key, vars)).not.toBe(key);
      expect(en(key, vars)).not.toBe(key);
    },
  );
});

describe('parameterText', () => {
  it('writes a straight line with its sign', () => {
    const text = parameterText('linear', { slope: 2.2, intercept: -0.4 })!;
    expect(text.key).toBe('chart.fit.linear');
    expect(en(text.key, text.vars)).toBe('y = 2.2 x − 0.4');
  });

  it('drops the intercept term when it is zero', () => {
    const text = parameterText('linear', { slope: 2, intercept: 0 })!;
    expect(text.key).toBe('chart.fit.linearNoIntercept');
    expect(zh(text.key, text.vars)).toBe('y = 2 x');
  });

  it('labels a and b per model, because the meaning changes', () => {
    const exp = parameterText('exponential', { a: 2.5, b: 0.45 })!;
    expect(en(exp.key, exp.vars)).toBe('y = 2.5 · exp(0.45 x)');

    const power = parameterText('power', { a: 3, b: 2 })!;
    expect(en(power.key, power.vars)).toBe('y = 3 · x^2');
  });

  it('reports all four 4PL parameters with the shape each one has', () => {
    const text = parameterText('4pl', { a: 1, b: 9, c: 2, d: 1.8 })!;
    const sentence = zh(text.key, text.vars);
    expect(sentence).toContain('下平台');
    expect(sentence).toContain('中点');
    expect(sentence).toContain('1.8');
  });

  it('says nothing when a parameter is undefined', () => {
    expect(parameterText('4pl', { a: 1, b: 9, c: Number.NaN, d: 1.8 })).toBeNull();
    expect(parameterText('linear', { slope: Number.NaN })).toBeNull();
    expect(parameterText('unknown-model', { a: 1 })).toBeNull();
  });
});

describe('limitsText', () => {
  it('shows LOD/LOQ for a straight line with scatter', () => {
    const text = limitsText('linear', {
      slope: 2.2,
      residualStandardError: 0.3,
      lod: 0.45,
      loq: 1.36,
    })!;
    expect(text.key).toBe('chart.analysisLimits');
    expect(en(text.key, text.vars)).toBe('LOD=0.45 · LOQ=1.36');
  });

  it('refuses to print "LOD = 0" when the fit has no scatter', () => {
    const text = limitsText('linear', {
      slope: 2.2,
      residualStandardError: 0,
      lod: 0,
      loq: 0,
    })!;
    expect(text.key).toBe('chart.analysisLimitsUnknown');
    expect(zh(text.key, text.vars)).toContain('估不出来');
  });

  it('has nothing to say about LOD outside a straight-line calibration', () => {
    expect(limitsText('4pl', { a: 1, b: 9, c: 2, d: 1.8 })).toBeNull();
  });
});

describe('formatFitNumber', () => {
  it('spends digits only where they carry information', () => {
    expect(formatFitNumber(2.2)).toBe('2.2');
    expect(formatFitNumber(0.000123456)).toBe('1.23e-4');
    expect(formatFitNumber(0)).toBe('0');
    expect(formatFitNumber(Number.NaN)).toBe('—');
  });
});