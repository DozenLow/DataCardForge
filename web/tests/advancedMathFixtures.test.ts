import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderMathPreview } from '../src/ui/mathPreview.ts';

interface FixtureCase {
  name: string;
  expression: string;
  expect?: number[];
  error?: { code: string };
  columns?: Array<{ name: string; data: number[] }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures/xlayer/advanced_math.v1.json'), 'utf8'),
) as { cases: FixtureCase[] };
const matrixFixture = JSON.parse(
  readFileSync(join(here, 'fixtures/xlayer/advanced_math_matrix.v1.json'), 'utf8'),
) as { cases: FixtureCase[] };

describe('advanced math capability fixtures', () => {
  it('keeps one independent expectation for every registered case', () => {
    const names = new Set<string>();
    for (const entry of fixture.cases) {
      expect(names.has(entry.name), `duplicate fixture ${entry.name}`).toBe(false);
      names.add(entry.name);
      expect(entry.expect !== undefined || entry.error !== undefined).toBe(true);
      if (entry.expect) expect(entry.expect.length).toBeGreaterThan(0);
    }
  });

  it('requires matrix mode to refuse advanced-only functions explicitly', () => {
    expect(matrixFixture.cases.length).toBeGreaterThan(0);
    for (const entry of matrixFixture.cases) {
      expect(entry.error?.code).toBe('unsupportedFunctionMode');
    }
  });

  it('renders the three bound-variable operators as math', () => {
    for (const expression of [
      'SUM(i*i, i, 1, 4)',
      'PRODUCT(i, i, 1, 5)',
      'INTEGRAL(x*x, x, 0, 1)',
      'DERIV(x*x, x, 3)',
      'COMBIN(10, 4)',
    ]) {
      expect(renderMathPreview(expression).mode, expression).toBe('mathml');
    }
  });

  it('falls back to original text for formulas without a preview shape', () => {
    const expression = 'IRR(A)';
    expect(renderMathPreview(expression)).toEqual({ mode: 'text', text: expression });
  });
});
