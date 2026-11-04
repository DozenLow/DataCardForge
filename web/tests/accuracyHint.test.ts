// @vitest-environment jsdom
/**
 * The three-state rule for the rounding-jitter hint.
 *
 * The important case is `unsupported`: the backend declines when it cannot measure (chained
 * input, MOV/EMA, never computed) and the card must then render NOTHING. A hint that says
 * "checked" when nothing was checked is worse than no hint at all.
 */
import { describe, expect, it } from 'vitest';

import { ACCURACY_DEBOUNCE_MS, toAccuracyHint } from '../src/ui/useAccuracyHint.ts';

describe('toAccuracyHint', () => {
  it('collapses every non-answer to idle, which renders nothing', () => {
    expect(toAccuracyHint(null)).toEqual({ kind: 'idle' });
    expect(toAccuracyHint({})).toEqual({ kind: 'idle' });
    expect(toAccuracyHint({ status: 'unsupported', reason: 'chainedInput' })).toEqual({
      kind: 'idle',
    });
    // "degraded" without a digit count is not a claim we can make.
    expect(toAccuracyHint({ status: 'degraded' })).toEqual({ kind: 'idle' });
  });

  it('reports ok without inventing a digit count', () => {
    expect(toAccuracyHint({ status: 'ok', digits: 15.9 })).toEqual({ kind: 'ok' });
  });

  it('carries the numbers for degraded', () => {
    expect(toAccuracyHint({ status: 'degraded', digits: 0, relativeGap: 10 })).toEqual({
      kind: 'degraded',
      digits: 0,
      gap: 10,
    });
  });

  it('defaults a missing gap to zero rather than NaN', () => {
    expect(toAccuracyHint({ status: 'degraded', digits: 3.1 })).toEqual({
      kind: 'degraded',
      digits: 3.1,
      gap: 0,
    });
  });

  it('waits three seconds before asking', () => {
    expect(ACCURACY_DEBOUNCE_MS).toBe(3000);
  });
});
