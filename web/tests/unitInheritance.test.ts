/**
 * Units L2a — safe-whitelist unit inheritance (docs/tasks/2026-11-19-units-l2.md §L2a).
 *
 * Two contracts, and both are about REFUSING to guess:
 *
 *   1. **The whitelist is exact.** Every documented preserving shape inherits the source
 *      column's unit; every documented exclusion (`SIGN`, `SQRT`, `COUNT`, `VAR`, two-column
 *      arithmetic, nesting through a non-whitelisted call) inherits nothing. A false positive
 *      puts a wrong unit on screen, which is worse than no unit.
 *   2. **The chain keeps its order.** constant > user confirmation/assertion > inherited >
 *      global pre-confirmation > parse — and the two-argument / three-argument calls of
 *      `columnUnitResolutions` behave exactly as they did before `inherited` existed.
 *
 * Structural only: no value is ever evaluated here, because inheritance never changes a number.
 */
import { describe, expect, it } from 'vitest';

import { parseExpression } from '../src/core/expression.ts';
import {
  UNIT_PRESERVING_FUNCTIONS,
  inferInheritedUnit,
} from '../src/core/unitInheritance.ts';
import {
  columnUnitResolutions,
  unitSignature,
  type UnitResolution,
} from '../src/core/units.ts';

/**
 * Resolutions for a table whose headers are given, resolved through the PLAIN two-argument
 * call — i.e. the source column's unit exactly as the data card's chips would see it.
 */
function resolutions(annotations: string[]): readonly UnitResolution[] {
  return columnUnitResolutions(annotations, {}).resolutions;
}

/** What `expression` inherits from a table with these headers. */
function inherit(
  expression: string,
  annotations: string[] = ['pressure_kpa', 'flow_lpm'],
): string | null {
  // The column NAMES are the headers themselves: a formula refers to a column by the label
  // its card advertises, exactly as the store passes them on the real pull path.
  return inferInheritedUnit(expression, resolutions(annotations), annotations)?.unit ?? null;
}

// ── 1. the whitelist, positively ─────────────────────────────────────────────────────

describe('preserving shapes inherit the source unit', () => {
  it('identity', () => {
    expect(inherit('pressure_kpa')).toBe('kPa');
  });

  it('scaling: col*num, num*col, col/num', () => {
    expect(inherit('pressure_kpa * 2')).toBe('kPa');
    expect(inherit('2 * pressure_kpa')).toBe('kPa');
    expect(inherit('pressure_kpa / 2')).toBe('kPa');
    expect(inherit('pressure_kpa*0.001')).toBe('kPa');
    expect(inherit('pressure_kpa / 1e3')).toBe('kPa');
  });

  it('unary minus is the dimensionless scale by −1', () => {
    expect(inherit('-pressure_kpa')).toBe('kPa');
    // `(-col) * 2` is the documented scaling shape applied to a negated column: the unary
    // sign is part of the operand, so the pair still preserves the unit.
    expect(inherit('-pressure_kpa * 2')).toBe('kPa');
  });

  it('the whitelisted single-column functions', () => {
    const expectations: Array<[string, string]> = [
      ['ABS(pressure_kpa)', 'kPa'],
      ['MOV(pressure_kpa, 5)', 'kPa'],
      ['EMA(pressure_kpa, 0.2)', 'kPa'],
      ['AVG(pressure_kpa)', 'kPa'],
      ['MEAN(pressure_kpa)', 'kPa'],
      ['MEDIAN(pressure_kpa)', 'kPa'],
      ['MIN(pressure_kpa)', 'kPa'],
      ['MAX(pressure_kpa)', 'kPa'],
      ['SUM(pressure_kpa)', 'kPa'],
      ['STD(pressure_kpa)', 'kPa'],
      ['SEM(pressure_kpa)', 'kPa'],
      ['QUANTILE(pressure_kpa, 0.5)', 'kPa'],
      ['ROUND(pressure_kpa, 2)', 'kPa'],
      ['ROUND(pressure_kpa)', 'kPa'],
      ['FLOOR(pressure_kpa)', 'kPa'],
      ['CEIL(pressure_kpa)', 'kPa'],
      // Composed inside the whitelist: a whitelisted call over a preserving shape is still
      // a single-column statement about the same quantity.
      ['MOV(pressure_kpa * 2, 5)', 'kPa'],
      ['ABS(pressure_kpa / 2)', 'kPa'],
      ['ROUND(ABS(pressure_kpa), 1)', 'kPa'],
    ];
    for (const [expression, unit] of expectations) {
      expect(inherit(expression), expression).toBe(unit);
    }
  });

  it('every name in the exported whitelist is a real function of the reference parser', () => {
    // A typo in the set would silently disable one documented shape, so the set is pinned:
    // parse a call for each name and check the parser accepted it as a call to THAT name.
    for (const name of UNIT_PRESERVING_FUNCTIONS) {
      const args = name === 'MOV' || name === 'EMA' || name === 'QUANTILE' ? 'pressure_kpa, 1'
        : name === 'ROUND' ? 'pressure_kpa, 2'
        : 'pressure_kpa';
      const ast = parseExpression(`${name}(${args})`, ['pressure_kpa', 'flow_lpm']);
      expect(ast.kind).toBe('call');
      if (ast.kind === 'call') expect(ast.name).toBe(name);
    }
    // The documented exclusions are NOT in it.
    for (const name of ['SIGN', 'SQRT', 'POW', 'LOG', 'LN', 'LOG10', 'EXP', 'COUNT', 'NAN', 'VAR', 'IF']) {
      expect(UNIT_PRESERVING_FUNCTIONS.has(name), name).toBe(false);
    }
  });
});

// ── 2. the whitelist, negatively ────────────────────────────────────────────────────

describe('non-preserving shapes inherit nothing', () => {
  it('dimensionless results: SIGN, COUNT, NAN, VAR', () => {
    expect(inherit('SIGN(pressure_kpa)')).toBeNull();
    expect(inherit('COUNT(pressure_kpa)')).toBeNull();
    expect(inherit('NAN(pressure_kpa)')).toBeNull();
    expect(inherit('VAR(pressure_kpa)')).toBeNull();
  });

  it('unit algebra: SQRT, POW, LOG, LN, LOG10, EXP', () => {
    expect(inherit('SQRT(pressure_kpa)')).toBeNull();
    expect(inherit('POW(pressure_kpa, 2)')).toBeNull();
    expect(inherit('LOG(pressure_kpa)')).toBeNull();
    expect(inherit('LN(pressure_kpa)')).toBeNull();
    expect(inherit('LOG10(pressure_kpa)')).toBeNull();
    expect(inherit('EXP(pressure_kpa)')).toBeNull();
  });

  it('multi-column arithmetic keeps no single unit', () => {
    expect(inherit('pressure_kpa * flow_lpm')).toBeNull();
    expect(inherit('pressure_kpa + flow_lpm')).toBeNull();
    expect(inherit('pressure_kpa - flow_lpm')).toBeNull();
    expect(inherit('pressure_kpa / flow_lpm')).toBeNull();
    // `num / col` INVERTS the unit rather than preserving it.
    expect(inherit('2 / pressure_kpa')).toBeNull();
    // `col * col` would square it.
    expect(inherit('pressure_kpa * pressure_kpa')).toBeNull();
    // …and so is the same reference written twice.
    expect(inherit('pressure_kpa + pressure_kpa')).toBeNull();
  });

  it('nesting through a non-whitelisted call poisons the whole expression', () => {
    expect(inherit('ABS(SIGN(pressure_kpa))')).toBeNull();
    expect(inherit('MOV(SQRT(pressure_kpa), 5)')).toBeNull();
    expect(inherit('pressure_kpa * SQRT(flow_lpm)')).toBeNull();
    expect(inherit('ABS(pressure_kpa) + COUNT(flow_lpm)')).toBeNull();
  });

  it('a second column argument makes the call non-preserving', () => {
    // `QUANTILE(pressure_kpa, q_col)` depends on another quantity, and `ROUND(col, d_col)` even
    // more visibly — neither is a single-column statement.
    expect(inherit('QUANTILE(pressure_kpa, flow_lpm)')).toBeNull();
    expect(inherit('ROUND(pressure_kpa, flow_lpm)')).toBeNull();
    expect(inherit('MIN(pressure_kpa, flow_lpm)')).toBeNull();
    expect(inherit('MAX(pressure_kpa, flow_lpm)')).toBeNull();
  });

  it('IF is never inherited (the result may be a different column)', () => {
    expect(inherit('IF(1, pressure_kpa, 0)')).toBeNull();
    expect(inherit('IF(pressure_kpa > 0, pressure_kpa, 0)')).toBeNull();
  });

  it('a pure number has no source column', () => {
    expect(inherit('42')).toBeNull();
    expect(inherit('2 * 3')).toBeNull();
  });

  it('an unparseable expression inherits nothing instead of throwing', () => {
    expect(inferInheritedUnit('pressure_kpa *', resolutions(['pressure_kpa']), ['pressure_kpa'])).toBeNull();
    expect(inferInheritedUnit('', resolutions(['pressure_kpa']), ['pressure_kpa'])).toBeNull();
    // An unknown column is the parser's ordinary error, swallowed here on purpose: the card
    // already reports it, and inheritance must not become a second error channel.
    expect(inferInheritedUnit('nope', resolutions(['pressure_kpa']), ['pressure_kpa'])).toBeNull();
  });
});

// ── 3. what the SOURCE column must say ──────────────────────────────────────────────

describe('the source column must resolve to exactly one scalar unit', () => {
  it('unknown / ambiguous / non-scalar sources inherit nothing', () => {
    expect(inferInheritedUnit('sensor', resolutions(['sensor']), ['sensor'])).toBeNull();
    // `ms` is ambiguous (millisecond vs m/s) until a human answers.
    expect(inferInheritedUnit('wind_ms', resolutions(['wind_ms']), ['wind_ms'])).toBeNull();
    // °C is a label, not a convertible quantity: inheritance would claim algebra it cannot do.
    expect(inferInheritedUnit('temp_degC', resolutions(['temp_degC']), ['temp_degC'])).toBeNull();
  });

  it('an ambiguous source that the user confirmed DOES inherit', () => {
    const annotations = ['wind_ms'];
    const signature = unitSignature(annotations);
    const source = columnUnitResolutions(annotations, { [signature]: { 0: 'm/s' } }).resolutions;
    expect(inferInheritedUnit('wind_ms * 2', source, annotations)?.unit).toBe('m/s');
  });

  it('the inherited unit names the source column and its index', () => {
    const annotations = ['flow_lpm', 'pressure_kpa'];
    const source = resolutions(annotations);
    expect(inferInheritedUnit('pressure_kpa * 2', source, annotations)).toEqual({
      column: 1,
      name: 'pressure_kpa',
      unit: 'kPa',
    });
  });
});

// ── 4. precedence through the resolution chain ─────────────────────────────────────

describe('resolution precedence: constant > user > inherited > preconfirm > parse', () => {
  const annotations = ['Col1'];
  const signature = unitSignature(annotations);
  const inherited = { [signature]: { 0: 'kPa' } };

  it('inherited beats the global pre-confirmation', () => {
    const { resolutions: chain } = columnUnitResolutions(annotations, {}, {
      preconfirm: { col1: 'bar' },
      inherited,
    });
    expect(chain[0].state).toBe('recognized');
    expect(chain[0].unit).toBe('kPa');
  });

  it('a user confirmation (assertion) beats inherited', () => {
    const { resolutions: chain } = columnUnitResolutions(annotations, { [signature]: { 0: 'mbar' } }, {
      inherited,
    });
    expect(chain[0].unit).toBe('mbar');
  });

  it("a user's explicit 'none' also beats inherited (the column has no unit, by the user)", () => {
    const { resolutions: chain } = columnUnitResolutions(annotations, { [signature]: { 0: 'none' } }, {
      inherited,
    });
    expect(chain[0].state).toBe('unknown');
    expect(chain[0].unit).toBe('');
  });

  it('a manual constant beats inherited', () => {
    // `Col1` carries no token, so the constant is keyed by the parsed token — use a header
    // that does carry one.
    const tokens = ['wind_g'];
    const tokenSignature = unitSignature(tokens);
    const { resolutions: chain } = columnUnitResolutions(tokens, {}, {
      constants: { g: { dimension: 'acceleration', factor: 9.80665 } },
      inherited: { [tokenSignature]: { 0: 'kg' } },
    });
    expect(chain[0].state).toBe('recognized');
    expect(chain[0].dimension).toBe('acceleration');
    expect(chain[0].unit).not.toBe('kg');
  });

  it("the header's own parse is overridden by inherited (that is the point of the feature)", () => {
    const parsed = ['Col1'];
    const { resolutions: chain } = columnUnitResolutions(parsed, {}, { inherited });
    // The header names no unit at all, yet the output column states one.
    expect(columnUnitResolutions(parsed, {}).resolutions[0].state).toBe('unknown');
    expect(chain[0].unit).toBe('kPa');
  });

  it('an inherited entry for ANOTHER signature is never applied', () => {
    const foreign = { [unitSignature(['other'])]: { 0: 'kPa' } };
    const { resolutions: chain } = columnUnitResolutions(annotations, {}, { inherited: foreign });
    expect(chain[0].state).toBe('unknown');
  });
});

// ── 5. existing calls are untouched ────────────────────────────────────────────────

describe('two-argument and three-argument calls are unchanged', () => {
  const annotations = ['pressure_kpa', 'flow_lpm', 'wind_ms'];

  it('the two-argument call is the plain parse', () => {
    const { signature, resolutions: chain } = columnUnitResolutions(annotations, {});
    expect(signature).toBe(unitSignature(annotations));
    expect(chain.map((entry) => entry.state)).toEqual(['recognized', 'recognized', 'ambiguous']);
    expect(chain[0].unit).toBe('kPa');
    expect(chain[1].unit).toBe('L/min');
    expect(chain[2].state).toBe('ambiguous');
  });

  it('the three-argument call without `inherited` resolves exactly like the two-argument one', () => {
    const withContext = columnUnitResolutions(annotations, {}, {
      constants: {},
      preconfirm: {},
    });
    const plain = columnUnitResolutions(annotations, {});
    expect(withContext.resolutions).toEqual(plain.resolutions);
  });

  it('a context with `inherited: {}` (the empty map) changes nothing', () => {
    const empty = columnUnitResolutions(annotations, {}, { inherited: {} });
    const plain = columnUnitResolutions(annotations, {});
    expect(empty.resolutions).toEqual(plain.resolutions);
  });
});