import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateExpressionWithPolicy,
  type AliasRange,
  type AutoConvertContext,
} from '../src/core/expression.ts';
import { candidateByUnit } from '../src/core/units.ts';

/**
 * Auto-convert fixtures (units L2b) — the TS half of a differential pair.
 *
 * `web/tests/fixtures/units/auto-convert.json` is judged here and by
 * `backend/tests/units_autoconvert_test.cpp`. Both engines must agree on every number and on
 * the complete conversion list, so a change to one implementation that is not mirrored in the
 * other fails one of the two runners instead of drifting silently.
 *
 * The fixture's `columnUnits` is the CONVERTIBLE unit carried into the engine per column. In
 * production the caller resolves it through the hierarchy (constant > confirmed > inherited >
 * pre-confirmed > parsed); pinning it here keeps each case about arithmetic.
 */
interface FixtureColumn {
  posName: string;
  annotation: string;
  data: number[];
}

interface FixtureCase {
  name: string;
  columns: FixtureColumn[];
  columnUnits: string[];
  expression: string;
  policy?: string;
  expectDefault: number[];
  expect: number[];
  conversions: Array<{ pair: number; factor: number; fromUnit: string; toUnit: string }>;
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(fixtureDir, 'fixtures/units/auto-convert.json'), 'utf8'),
) as { cases: FixtureCase[] };

function contextFor(testCase: FixtureCase): AutoConvertContext {
  const context: AutoConvertContext = { columnUnits: [], columnDimensions: [], columnFactors: [] };
  for (const unit of testCase.columnUnits) {
    const candidate = unit === '' ? null : candidateByUnit(unit);
    context.columnUnits.push(candidate ? candidate.unit : '');
    context.columnDimensions.push(candidate?.dimension ?? '');
    context.columnFactors.push(candidate?.factor ?? 0);
  }
  return context;
}

/**
 * The fixture expressions use the qualified port spelling (`src.pos.1`) because that is what
 * a real card writes; the port contributes the alias, exactly as `portBindingsFor` does.
 */
const ALIASES: AliasRange[] = [
  { alias: 'A', first: 0, count: Number.MAX_SAFE_INTEGER },
  { alias: 'src', first: 0, count: Number.MAX_SAFE_INTEGER },
];

function columnsOf(testCase: FixtureCase): Array<{ name: string; data: number[] }> {
  return testCase.columns.map((column) => ({
    name: column.annotation ? `${column.posName} ${column.annotation}` : column.posName,
    data: column.data,
  }));
}

describe('auto conversion (units L2b) — shared fixtures', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const columns = columnsOf(testCase);

      // 1. The plain reference path is unchanged — before and after the tier existed.
      expect(
        evaluateExpressionWithPolicy(testCase.expression, columns, null, ALIASES).values,
      ).toEqual(testCase.expectDefault);

      // 2. A policy that is not 'auto' is byte-identical to the plain path.
      if (testCase.policy !== 'auto') {
        const plain = evaluateExpressionWithPolicy(
          testCase.expression,
          columns,
          { policy: testCase.policy ?? '', context: contextFor(testCase) },
          ALIASES,
        );
        expect(plain.values).toEqual(testCase.expectDefault);
        expect(plain.conversions).toEqual([]);
      }

      // 3. Under the case's own policy the result is exactly `expect`.
      if (testCase.policy === 'auto') {
        const auto = evaluateExpressionWithPolicy(
          testCase.expression,
          columns,
          { policy: 'auto', context: contextFor(testCase) },
          ALIASES,
        );
        expect(auto.values).toEqual(testCase.expect);
        expect(auto.conversions).toEqual(testCase.conversions);
      }
    });
  }
});

/**
 * The same statement the C++ runner makes in `runXlayerParity`: replayed under `auto` with NO
 * provable unit, the tier must not move a single number of the golden expressions. This is the
 * TypeScript half of "default/strict/free/absent are unchanged" — the `auto` path is the only
 * one with new code in it, so it is the one that has to be proven inert when it has nothing to
 * convert.
 */
describe('auto conversion — xlayer parity with no provable unit', () => {
  const xlayer = JSON.parse(
    readFileSync(join(fixtureDir, 'fixtures/xlayer/expression.v1.json'), 'utf8'),
  ) as {
    cases: Array<{
      name: string;
      columns: Array<{ name: string; data: unknown[] }>;
      expression: string;
      error?: unknown;
    }>;
  };

  function revive(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value === 'NaN') return Number.NaN;
    if (value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
    throw new Error(`bad sentinel ${JSON.stringify(value)}`);
  }

  for (const testCase of xlayer.cases) {
    // Error cases belong to the error path, and a case with no columns has nothing to convert.
    if (testCase.error !== undefined) continue;
    it(testCase.name, () => {
      const columns = testCase.columns.map((column) => ({
        name: column.name,
        data: column.data.map(revive),
      }));
      // A context of the right SHAPE whose every entry proves nothing: no unit, no dimension,
      // no factor. Under `auto` such a context may convert exactly nothing.
      const empty: AutoConvertContext = {
        columnUnits: columns.map(() => ''),
        columnDimensions: columns.map(() => ''),
        columnFactors: columns.map(() => 0),
      };
      const tiered = evaluateExpressionWithPolicy(testCase.expression, columns, {
        policy: 'auto',
        context: empty,
      });
      expect(tiered.conversions).toEqual([]);
      expect(tiered.values).toEqual(
        evaluateExpressionWithPolicy(testCase.expression, columns, null).values,
      );
    });
  }
});

describe('auto conversion — contract properties', () => {
  it('converts with value * factorRight / factorLeft, never a precomputed ratio', () => {
    // `context` maps column index -> (unit, dimension, factor). The expressions below name the
    // columns `a` (index 0) and `b` (index 1) both times. In the second case the SAME units are
    // declared in the other column order, so the pair must convert the other way.
    // The two forms disagree for g -> kg on the last bit: `1 * 0.001 / 1` is exact, while a
    // precomputed `0.001 / 1` ratio multiplied in can round. The fixture case
    // `left-to-right-order-pins-the-exact-double` pins the same order on the C++ side, and the
    // unit-convert card (units.cpp) uses it for ppm -> ppb.
    const context: AutoConvertContext = {
      columnUnits: ['g', 'kg'],
      columnDimensions: ['mass', 'mass'],
      columnFactors: [0.001, 1],
    };
    const first = evaluateExpressionWithPolicy(
      'value_g - value_kg',
      [
        { name: 'value_g', data: [1000] },
        { name: 'value_kg', data: [1] },
      ],
      { policy: 'auto', context },
    );
    expect(first.conversions).toHaveLength(1);
    expect(first.conversions[0].factor).toBe(1000);
    // 1000 g in kg, computed as 1000 * 0.001 / 1: exactly the stored double, no extra rounding.
    expect(first.values[0]).toBe(0);

    // And the reported factor is the right-to-left ratio, not its reciprocal.
    const reverse = evaluateExpressionWithPolicy(
      'a - b',
      [
        { name: 'a', data: [1] },
        { name: 'b', data: [1000] },
      ],
      {
        policy: 'auto',
        context: {
          columnUnits: ['kg', 'g'],
          columnDimensions: ['mass', 'mass'],
          columnFactors: [1, 0.001],
        },
      },
    );
    expect(reverse.conversions[0].factor).toBe(0.001);
    expect(reverse.values[0]).toBe(0);
  });

  it('is opt-in: an absent request, a missing context and a null request never convert', () => {
    const columns = [
      { name: 'a', data: [1, 2] },
      { name: 'b', data: [150, 200] },
    ];
    const context: AutoConvertContext = {
      columnUnits: ['m', 'cm'],
      columnDimensions: ['length', 'length'],
      columnFactors: [1, 0.01],
    };
    expect(evaluateExpressionWithPolicy('a + b', columns).values).toEqual([151, 202]);
    expect(evaluateExpressionWithPolicy('a + b', columns, null).values).toEqual([151, 202]);
    expect(evaluateExpressionWithPolicy('a + b', columns, { policy: 'auto' }).values).toEqual([
      151, 202,
    ]);
    expect(
      evaluateExpressionWithPolicy('a + b', columns, { policy: 'AUTO', context }).values,
    ).toEqual([151, 202]);
  });

  it('leaves the source data arrays untouched', () => {
    const first = { name: 'a', data: [1, 2] };
    const second = { name: 'b', data: [150, 200] };
    const firstCopy = [...first.data];
    const secondCopy = [...second.data];
    const result = evaluateExpressionWithPolicy('a + b', [first, second], {
      policy: 'auto',
      context: {
        columnUnits: ['m', 'cm'],
        columnDimensions: ['length', 'length'],
        columnFactors: [1, 0.01],
      },
    });
    expect(result.values).toEqual([2.5, 4]);
    expect(first.data).toEqual(firstCopy);
    expect(second.data).toEqual(secondCopy);
  });
});