/**
 * `formatCell` — the single place where a number becomes text.
 *
 * The rule it follows now is "the shortest string that round-trips to the same double".
 * The regression it guards is concrete: `toPrecision(6)` printed every value in a column
 * of measurements centred on 1e6 as `1e+6`, so 3000 distinct rows rendered as one repeated
 * string and the table offered no evidence that anything about the data was unusual.
 */
import { describe, expect, it } from 'vitest';

import { formatCell } from '../src/core/numeric.ts';

describe('formatCell', () => {
  it('renders special values as symbols, never as garbage', () => {
    expect(formatCell(NaN)).toBe('—');
    expect(formatCell(Infinity)).toBe('∞');
    expect(formatCell(-Infinity)).toBe('-∞');
    expect(formatCell(0)).toBe('0');
    expect(formatCell(-0)).toBe('0');
  });

  it('round-trips every value it prints', () => {
    const values = [
      1,
      -1,
      0.5,
      -0.5,
      1 / 3,
      2 / 3,
      1000000,
      1000000.0004813797,
      999999.99941809254,
      1e-7,
      1.5e-7,
      1e21,
      5e-324,
      1.7976931348623157e308,
      Math.PI,
    ];
    for (const v of values) {
      expect(Number(formatCell(v))).toBe(v);
    }
  });

  it('keeps near-equal values distinguishable (the 1e6 offset case)', () => {
    const high = 1000000.0004813797;
    const low = 999999.99941809254;
    expect(formatCell(high)).not.toBe(formatCell(low));
    expect(formatCell(high)).not.toBe(formatCell(1000000));
  });

  it('does not pad short values', () => {
    expect(formatCell(0.5)).toBe('0.5');
    expect(formatCell(42)).toBe('42');
    expect(formatCell(-2)).toBe('-2');
  });

  it('spells exponents the way C does, with two digits', () => {
    expect(formatCell(1e-7)).toBe('1e-07');
    expect(formatCell(1.5e-7)).toBe('1.5e-07');
    // Three-digit exponents are unambiguous already and keep JS's spelling.
    expect(formatCell(1e-100)).toBe('1e-100');
  });
});
