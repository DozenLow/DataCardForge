/**
 * Read-only math preview for advanced formula expressions.
 * This module never evaluates numbers. Its only contract is: render MathML when the
 * expression has a recognised math shape; otherwise return the original text as fallback.
 *
 * MathML Core only: Chromium (the project's smoke browser) implements the Core subset,
 * which drops `mfenced`/`mtable` and ignores bare text inside `mrow`. Bodies therefore
 * live in `mtext`, binomials use `mfrac linethickness="0"` between explicit fences, and
 * the binder sits in the operator's lower limit (`∑_{i=1}^{4}`) instead of trailing the
 * operator as a misleading equation.
 */
export interface MathPreview {
  mode: 'mathml' | 'text';
  html?: string;
  text: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function identifier(text: string): string {
  return `<mi>${escapeXml(text)}</mi>`;
}

function number(text: string): string {
  return `<mn>${escapeXml(text)}</mn>`;
}

/** Bodies are data, not parsed math: show them verbatim in an upright text token. */
function body(text: string): string {
  return `<mtext>${escapeXml(text.trim())}</mtext>`;
}

function parseScalar(text: string): string {
  const value = text.trim();
  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) return number(value);
  if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(value)) return identifier(value);
  return '';
}

const UNSIGNED = /^[0-9]+(?:\.[0-9]+)?$/;
const SIGNED = /^-?[0-9]+(?:\.[0-9]+)?$/;

export function renderMathPreview(expression: string): MathPreview {
  const text = expression.trim();
  if (!text) return { mode: 'text', text: expression };

  try {
    const sum = text.match(/^SUM\(\s*([^,]+)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i);
    if (sum) {
      const start = UNSIGNED.test(sum[3].trim()) ? number(sum[3].trim()) : '';
      const end = UNSIGNED.test(sum[4].trim()) ? number(sum[4].trim()) : '';
      if (start && end) {
        return {
          mode: 'mathml',
          text,
          html: `<math><munderover><mo>∑</mo><mrow>${identifier(sum[2])}<mo>=</mo>${start}</mrow>${end}</munderover>${body(sum[1])}</math>`,
        };
      }
    }

    const product = text.match(/^PRODUCT\(\s*([^,]+)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i);
    if (product) {
      const start = UNSIGNED.test(product[3].trim()) ? number(product[3].trim()) : '';
      const end = UNSIGNED.test(product[4].trim()) ? number(product[4].trim()) : '';
      if (start && end) {
        return {
          mode: 'mathml',
          text,
          html: `<math><munderover><mo>∏</mo><mrow>${identifier(product[2])}<mo>=</mo>${start}</mrow>${end}</munderover>${body(product[1])}</math>`,
        };
      }
    }

    const integral = text.match(/^INTEGRAL\(\s*([^,]+)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i);
    if (integral) {
      const lower = SIGNED.test(integral[3].trim()) ? number(integral[3].trim()) : '';
      const upper = SIGNED.test(integral[4].trim()) ? number(integral[4].trim()) : '';
      if (lower && upper) {
        return {
          mode: 'mathml',
          text,
          html: `<math><msubsup><mo>∫</mo>${lower}${upper}</msubsup>${body(integral[1])}<mi mathvariant="normal">d</mi>${identifier(integral[2])}</math>`,
        };
      }
    }

    const derivative = text.match(/^DERIV\(\s*([^,]+)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([^)]+)\s*\)$/i);
    if (derivative) {
      const point = parseScalar(derivative[3]);
      if (point) {
        return {
          mode: 'mathml',
          text,
          html: `<math><mfrac><mi mathvariant="normal">d</mi><mrow><mi mathvariant="normal">d</mi>${identifier(derivative[2])}</mrow></mfrac>${body(derivative[1])}<msub><mo stretchy="true">|</mo><mrow>${identifier(derivative[2])}<mo>=</mo>${point}</mrow></msub></math>`,
        };
      }
    }

    const combin = text.match(/^COMBIN\(\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i);
    if (combin) {
      const n = parseScalar(combin[1]);
      const k = parseScalar(combin[2]);
      if (n && k) {
        return {
          mode: 'mathml',
          text,
          html: `<math><mrow><mo>(</mo><mfrac linethickness="0">${n}${k}</mfrac><mo>)</mo></mrow></math>`,
        };
      }
    }

    return { mode: 'text', text: expression };
  } catch {
    return { mode: 'text', text: expression };
  }
}
