import { describe, expect, it } from 'vitest';

import { renderMathPreview } from '../src/ui/mathPreview.ts';

describe('advanced math preview', () => {
  it('renders summation as MathML', () => {
    const preview = renderMathPreview('SUM(i*i, i, 1, 4)');
    expect(preview.mode).toBe('mathml');
    expect(preview.html).toContain('<munderover>');
    expect(preview.html).toContain('∑');
  });

  it('renders integral as MathML', () => {
    const preview = renderMathPreview('INTEGRAL(x*x, x, 0, 1)');
    expect(preview.mode).toBe('mathml');
    expect(preview.html).toContain('<msubsup>');
  });

  it('renders combination as MathML', () => {
    const preview = renderMathPreview('COMBIN(10, 4)');
    expect(preview.mode).toBe('mathml');
    expect(preview.html).toContain('<mfrac linethickness="0">');
  });

  it('falls back to original text for unknown or malformed shapes', () => {
    expect(renderMathPreview('SUM(i, i, nope, 4)').mode).toBe('text');
    expect(renderMathPreview('SLOPE(A, B)').text).toBe('SLOPE(A, B)');
  });

  it('stays inside MathML Core so Chromium renders every shape', () => {
    const shapes = [
      'SUM(i*i, i, 1, 4)',
      'PRODUCT(i, i, 1, 5)',
      'INTEGRAL(x*x, x, 0, 1)',
      'DERIV(x*x, x, 3)',
      'COMBIN(10, 4)',
    ];
    for (const expression of shapes) {
      const html = renderMathPreview(expression).html ?? '';
      // mfenced/mtable are MathML3-only: Chromium drops them (the binomial lost its
      // fences and rendered as a bare stacked pair of numbers).
      expect(html, expression).not.toContain('mfenced');
      expect(html, expression).not.toContain('mtable');
      // Bare text inside mrow is ignored by MathML Core: bodies must live in mtext,
      // otherwise the summand/integrand vanished from the preview entirely.
      if (!expression.startsWith('COMBIN')) {
        expect(html, expression).toContain('<mtext>');
      }
    }
    const sum = renderMathPreview('SUM(i*i, i, 1, 4)').html ?? '';
    // The binder belongs in the lower limit, not trailing the operator as an equation.
    expect(sum).toContain('<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mn>4</mn></munderover>');
    expect(sum).toContain('<mtext>i*i</mtext>');
    const combin = renderMathPreview('COMBIN(10, 4)').html ?? '';
    expect(combin).toContain('<mfrac linethickness="0"><mn>10</mn><mn>4</mn></mfrac>');
    expect(combin).toContain('<mo>(</mo>');
    expect(combin).toContain('<mo>)</mo>');
  });

  it('escapes column names and bodies instead of injecting markup', () => {
    const html = renderMathPreview('SUM(<img src=x onerror=alert(1)>, i, 1, 2)').html ?? '';
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('falls back to text when the body contains commas (nested calls)', () => {
    const expression = 'SUM(IF(x>0, x, 0), i, 1, 4)';
    expect(renderMathPreview(expression).mode).toBe('text');
  });
});
