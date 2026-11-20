/**
 * Units L1b — the resolution chain of `columnUnitResolutions` (docs/tasks/2026-11-19-units-l1.md
 * §B2, decision 2026-11-19 §三/§五).
 *
 * The chain is the whole point of this slice, and it has exactly one implementation, so it is
 * pinned here at the CORE level:
 *
 *   workspace constant (token)  →  workspace confirmation `[signature][index]`
 *     →  global pre-confirmation (token)  →  the resolver's own parse
 *
 * Two properties matter more than the ordering itself:
 *   - the optional context is ADDITIVE. The pre-L1b two-argument call must resolve every
 *     column exactly as it did before, and an EMPTY context (`{}`, or maps that do not mention
 *     the token) must be indistinguishable from no context at all. The 50 shared parse
 *     fixtures keep testing the same resolver, untouched.
 *   - a constant never invents a number: it changes what a header MEANS (dimension/factor),
 *     not what a value is. Nothing in this module multiplies anything.
 */
import { describe, expect, it } from 'vitest';

import {
  NO_UNIT,
  columnUnitResolutions,
  resolveUnit,
  unitSignature,
} from '../src/core/units.ts';

const COLUMNS = ['force_g', 'time_ms', 'height_cm', 'sensor'];

function unitAt(
  columns: readonly string[],
  index: number,
  confirmations: Parameters<typeof columnUnitResolutions>[1] = {},
  context?: Parameters<typeof columnUnitResolutions>[2],
) {
  return columnUnitResolutions(columns, confirmations, context).resolutions[index];
}

/** A confirmation memory that answers column `index` of `columns` with `unit`. */
function confirmed(columns: readonly string[], index: number, unit: string) {
  return { [unitSignature(columns)]: { [index]: unit } };
}

describe('the 2-argument call is unchanged (additive contract)', () => {
  it('resolves every column exactly like the resolver alone', () => {
    const view = columnUnitResolutions(COLUMNS, {});
    expect(view.resolutions.map((resolution) => resolution.state)).toEqual(
      COLUMNS.map((annotation) => resolveUnit(annotation).state),
    );
    expect(view.resolutions.map((resolution) => resolution.unit)).toEqual([
      // `force_g` is ambiguous: `g` alone is one of the colliding single letters.
      '',
      '',
      'cm',
      '',
    ]);
  });

  it('an empty context is the same statement as no context', () => {
    const bare = columnUnitResolutions(COLUMNS, {});
    const empty = columnUnitResolutions(COLUMNS, {}, {});
    const unrelated = columnUnitResolutions(COLUMNS, {}, {
      constants: { xyz: { dimension: 'length', factor: 1 } },
      preconfirm: { ms: 'ms' },
    });
    // `time_ms` has no `ms` token reached through a recognized single-token suffix? It does —
    // so the unrelated case must only be equal when the pre-confirmation is ABSENT.
    expect(empty).toEqual(bare);
    expect(unrelated.signature).toBe(bare.signature);
    // The constants entry names a token no header carries: nothing moved.
    expect(unrelated.resolutions[3]).toEqual(bare.resolutions[3]);
  });

  it('the signature is the same key with or without a context', () => {
    const withContext = columnUnitResolutions(COLUMNS, {}, {
      constants: { g: { dimension: 'acceleration', factor: 9.80665 } },
    });
    expect(withContext.signature).toBe(unitSignature(COLUMNS));
  });

  it('a confirmation still wins over the parse in the two-argument form', () => {
    const resolution = unitAt(COLUMNS, 3, confirmed(COLUMNS, 3, 'kPa'));
    expect(resolution.state).toBe('recognized');
    expect(resolution.unit).toBe('kPa');
  });
});

describe('manual constants make a token recognized', () => {
  const constants = { g: { dimension: 'acceleration', factor: 9.80665 } };

  it('a constant names the reading of an ambiguous token', () => {
    const bare = unitAt(COLUMNS, 0);
    expect(bare.state).toBe('ambiguous');
    expect(bare.candidates.length).toBeGreaterThan(0);

    const defined = unitAt(COLUMNS, 0, {}, { constants });
    expect(defined.state).toBe('recognized');
    // The unit NAME stays the spelling the header carries — the definition adds meaning
    // (dimension/factor), it does not rename the column.
    expect(defined.unit).toBe('g');
    expect(defined.token).toBe('g');
    expect(defined.dimension).toBe('acceleration');
    expect(defined.factor).toBe(9.80665);
    expect(defined.scalar).toBe(true);
    // …and the span is the resolver's, so a rewrite of the suffix still lands on the token.
    expect(defined.span).toEqual(bare.span);
  });

  it('a constant can only refine a token the resolver actually read', () => {
    // Documented limit of the chain (decision §三): the constant is looked up by `base.token`,
    // and the resolver reports NO token for a header it does not recognise at all. A constant
    // therefore refines an ambiguous/recognised spelling; it does not teach the resolver a new
    // suffix grammar — that would be exactly the guessing `resolveUnit` refuses to do.
    const columns = ['wind_β'];
    expect(unitAt(columns, 0).state).toBe('unknown');
    expect(unitAt(columns, 0).token).toBe('');
    const defined = unitAt(columns, 0, {}, {
      constants: { β: { dimension: 'probability', factor: 1 } },
    });
    expect(defined.state).toBe('unknown');
    expect(defined.unit).toBe('');
  });

  it('a constant refines an ambiguous token even when only one reading exists', () => {
    // `x_g` is ambiguous because `g` is a single letter; the workspace says which reading it
    // is. Same rule as `force_g`, on a different column name — the token is what is defined.
    const columns = ['x_g'];
    expect(unitAt(columns, 0).state).toBe('ambiguous');
    const defined = unitAt(columns, 0, {}, {
      constants: { g: { dimension: 'acceleration', factor: 9.80665 } },
    });
    expect(defined.state).toBe('recognized');
    expect(defined.dimension).toBe('acceleration');
    expect(defined.unit).toBe('g');
  });

  it('a constant whose token the header does not carry changes nothing', () => {
    const defined = unitAt(COLUMNS, 2, {}, { constants });
    // `height_cm` keeps the registry's reading: the constant is for `g`, not for `cm`.
    expect(defined.unit).toBe('cm');
    expect(defined.dimension).toBe('length');
  });

  it('an unusable definition is ignored instead of half-applied', () => {
    const columns = ['force_g'];
    const broken = [
      { g: { dimension: '', factor: 9.81 } },
      { g: { dimension: 'acceleration', factor: 0 } },
      { g: { dimension: 'acceleration', factor: -1 } },
      { g: { dimension: 'acceleration', factor: Number.NaN } },
      { g: { dimension: 'acceleration', factor: Number.POSITIVE_INFINITY } },
    ];
    for (const constants of broken) {
      expect(unitAt(columns, 0, {}, { constants }).state).toBe('ambiguous');
    }
  });

  it('the lookup is by the resolver token, so one definition covers every spelling', () => {
    const columns = ['weight_g', 'speed_g'];
    for (let index = 0; index < columns.length; ++index) {
      const resolution = unitAt(columns, index, {}, { constants });
      expect(resolution.state).toBe('recognized');
      expect(resolution.unit).toBe('g');
      expect(resolution.dimension).toBe('acceleration');
    }
  });
});

describe('precedence: constant > workspace confirmation > global pre-confirmation > parse', () => {
  const columns = ['force_g'];
  const constants = { g: { dimension: 'acceleration', factor: 9.80665 } };

  it('a workspace constant beats a workspace confirmation', () => {
    const resolution = unitAt(columns, 0, confirmed(columns, 0, 'kg'), { constants });
    expect(resolution.dimension).toBe('acceleration');
    expect(resolution.unit).toBe('g');
  });

  it('a workspace constant beats the global pre-confirmation', () => {
    const resolution = unitAt(columns, 0, {}, {
      constants,
      preconfirm: { g: 'kg' },
    });
    expect(resolution.dimension).toBe('acceleration');
    expect(resolution.factor).toBe(9.80665);
  });

  it('a workspace confirmation beats the global pre-confirmation', () => {
    const resolution = unitAt(columns, 0, confirmed(columns, 0, 'kg'), {
      preconfirm: { g: 'g' },
    });
    expect(resolution.state).toBe('recognized');
    expect(resolution.unit).toBe('kg');
    expect(resolution.dimension).toBe('mass');
  });

  it('the global pre-confirmation fills in where nothing else speaks', () => {
    const resolution = unitAt(columns, 0, {}, { preconfirm: { g: 'g' } });
    expect(resolution.state).toBe('recognized');
    expect(resolution.unit).toBe('g');
    expect(resolution.dimension).toBe('mass');
  });

  it('a workspace "not a unit" answer beats the global pre-confirmation', () => {
    // The explicit rejection is an ANSWER, not an absence: the global default must not
    // resurrect the unit the user just said the column does not have.
    const resolution = unitAt(columns, 0, confirmed(columns, 0, NO_UNIT), {
      preconfirm: { g: 'g' },
    });
    expect(resolution.state).toBe('unknown');
    expect(resolution.unit).toBe('');
  });

  it('a pre-confirmation for a column indexed 0 is per column, not per token', () => {
    // Two columns carrying the same token: the workspace answered only the first one.
    const pair = ['a_g', 'b_g'];
    const view = columnUnitResolutions(pair, confirmed(pair, 0, 'kg'), {
      preconfirm: { g: 'g' },
    });
    expect(view.resolutions[0].unit).toBe('kg');
    expect(view.resolutions[1].unit).toBe('g');
  });

  it('an unregistered unit in the pre-confirmation falls back to the parse', () => {
    const resolution = unitAt(['height_cm'], 0, {}, { preconfirm: { cm: 'furlong' } });
    expect(resolution.unit).toBe('cm');
    expect(resolution.dimension).toBe('length');
  });
});