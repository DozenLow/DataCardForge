/**
 * Unit tests for the pure helpers of scripts/perf-browser.mjs.
 *
 * The benchmark itself is an E2E harness (Playwright against a running production build,
 * driven by root). What CAN be pinned in the normal gate is the contract around it:
 * the fixture formula the harness verifies against, the --missing rule, the CLI parser,
 * the phase sets, and the HTTP-status mapping. A silent mistake in any of those would
 * turn into a plausible-looking report row instead of a failure, which is exactly the
 * kind of error this suite exists to prevent.
 */
import { describe, expect, it } from 'vitest';

// The benchmark is plain ESM JavaScript; its pure exports are exercised here.
import {
  UsageError,
  buildRecord,
  canRunPhase,
  classifyError,
  expectedCellText,
  fixtureValue,
  formatCellValue,
  isMissingCell,
  parseArgs,
  phasesForMode,
  registerStatus,
  roundMs,
// @ts-ignore — no declaration file for the plain-JS CLI (TS7016).
} from '../scripts/perf-browser.mjs';

describe('fixture formula', () => {
  it('matches the seed formula at fixed sentinels', () => {
    expect(fixtureValue(0, 0)).toBe(-62.625);
    expect(fixtureValue(0, 1)).toBe(-60.5);
    expect(fixtureValue(1, 0)).toBe(-62.5);
    expect(fixtureValue(1999, 0)).toBe(61.125);
  });

  it('is the documented integer-modulo expression, not a re-derivation', () => {
    for (const [row, col] of [
      [0, 3],
      [7, 2],
      [1234, 5],
      [999, 7],
    ]) {
      const expected = (((row * (2 * col + 1) + 17 * col + 3) % 1009) - 504) / 8;
      expect(fixtureValue(row, col)).toBe(expected);
    }
  });

  it('marks a cell missing only when enabled and (r + 13c) % 97 === 13', () => {
    expect(isMissingCell(13, 0, true)).toBe(true);
    expect(isMissingCell(0, 1, true)).toBe(true);
    expect(isMissingCell(13, 0, false)).toBe(false);
    expect(isMissingCell(12, 0, true)).toBe(false);
    expect(isMissingCell(0, 1, false)).toBe(false);
  });
});

describe('cell display', () => {
  it('formats numbers the way the table does', () => {
    expect(formatCellValue(-62.625)).toBe('-62.625');
    expect(formatCellValue(0)).toBe('0');
    expect(formatCellValue(1e-7)).toBe('1e-07');
    expect(formatCellValue(Number.NaN)).toBe('—');
    expect(formatCellValue(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('reads a missing fixture cell as the missing dash', () => {
    expect(expectedCellText(13, 0, true)).toBe('—');
    expect(expectedCellText(13, 0, false)).toBe(formatCellValue(fixtureValue(13, 0)));
  });
});

describe('mode phase sets', () => {
  it('emits exactly the documented journey per mode', () => {
    expect(phasesForMode('cold')).toEqual(['page_ready', 'backend_hello']);
    expect(phasesForMode('chart')).toEqual([
      'page_ready',
      'backend_hello',
      'register',
      'first_cell',
      'chart_first_draw',
      'chart_zoom_frame_p95',
    ]);
    expect(phasesForMode('import')).toEqual([
      'page_ready',
      'backend_hello',
      'register',
      'first_cell',
      'scroll',
      'formula_preview',
      'recompute_preview',
      'show_more',
    ]);
  });

  it('still measures local rendering after HTTP 413, but never remote formulas', () => {
    const cap = { phase: 'register', status: 'protocol_limit' };
    for (const phase of ['first_cell', 'scroll', 'chart_first_draw', 'chart_zoom_frame_p95']) {
      expect(canRunPhase(phase, cap)).toBe(true);
      expect(canRunPhase(phase, { ...cap, status: 'error' })).toBe(false);
    }
    expect(canRunPhase('formula_preview', cap)).toBe(false);
    expect(canRunPhase('chart_zoom_frame_p95', { phase: 'chart_first_draw', status: 'wrong_result' })).toBe(false);
  });

  it('falls back to the import journey for an unknown mode', () => {
    expect(phasesForMode('nonsense')).toEqual(phasesForMode('import'));
  });
});

describe('CLI parsing', () => {
  const fixture = '../docs/sampleData/1.txt';
  const baseImport = [
    '--url',
    'http://127.0.0.1:38843/',
    '--file',
    fixture,
    '--rows',
    '2000',
    '--cols',
    '8',
  ];

  it('applies defaults and resolves the file path', () => {
    const args = parseArgs(baseImport);
    expect(args.mode).toBe('import');
    expect(args.samples).toBe(1);
    expect(args.warmup).toBe(0);
    expect(args.timeoutMs).toBe(30_000);
    expect(args.steadyMs).toBe(0);
    expect(args.holdMs).toBe(0); // defaults to steady-ms
    expect(args.missing).toBe(false);
    expect(args.rows).toBe(2000);
    expect(args.cols).toBe(8);
    expect(args.file.endsWith('/docs/sampleData/1.txt')).toBe(true);
  });

  it('does not require a file or shape in cold mode', () => {
    const args = parseArgs(['--url', 'http://127.0.0.1:38843/', '--mode', 'cold']);
    expect(args.mode).toBe('cold');
    expect(args.file).toBeNull();
    expect(args.rows).toBeNull();
  });

  it('defaults hold-ms to steady-ms', () => {
    const args = parseArgs([...baseImport, '--steady-ms', '5000']);
    expect(args.steadyMs).toBe(5000);
    expect(args.holdMs).toBe(5000);
  });

  it('accepts an explicit hold-ms and the missing flag', () => {
    const args = parseArgs([...baseImport, '--steady-ms', '500', '--hold-ms', '9000', '--missing']);
    expect(args.holdMs).toBe(9000);
    expect(args.missing).toBe(true);
  });

  it('rejects missing required flags and bad values', () => {
    expect(() => parseArgs(['--file', fixture, '--rows', '1', '--cols', '1'])).toThrow(UsageError);
    expect(() => parseArgs(['--url', 'http://x/', '--rows', '1', '--cols', '1'])).toThrow(
      /--file is required/,
    );
    expect(() => parseArgs(['--url', 'ftp://x/', ...baseImport.slice(2)])).toThrow(/http/);
    expect(() => parseArgs([...baseImport, '--mode', 'video'])).toThrow(/import\|chart\|cold/);
    expect(() => parseArgs([...baseImport, '--samples', '0'])).toThrow(/samples/);
    expect(() => parseArgs([...baseImport, '--timeout-ms', 'x'])).toThrow(/non-negative integer/);
    expect(() => parseArgs([...baseImport, '--bogus'])).toThrow(/unknown argument/);
  });

  it('rejects a file that does not exist', () => {
    expect(() =>
      parseArgs([
        '--url',
        'http://127.0.0.1:38843/',
        '--file',
        'no/such/file.csv',
        '--rows',
        '1',
        '--cols',
        '1',
      ]),
    ).toThrow(/does not exist/);
  });

  it('treats --help as a usage outcome, not a crash', () => {
    expect(() => parseArgs(['--help'])).toThrow(UsageError);
  });
});

describe('status mapping', () => {
  it('decides register success from the HTTP answer alone', () => {
    expect(registerStatus(200, { matrixId: 1 })).toBe('ok');
    expect(registerStatus(200, {})).toBe('error');
    expect(registerStatus(413, { code: 'payloadTooLarge' })).toBe('protocol_limit');
    expect(registerStatus(413, null)).toBe('protocol_limit');
    expect(registerStatus(507, null)).toBe('resource_limit');
    expect(registerStatus(500, { code: 'internalError' })).toBe('error');
    expect(registerStatus(403, { code: 'forbiddenOrigin' })).toBe('error');
  });

  it('classifies thrown errors into the schema enum', () => {
    const timeout = Object.assign(new Error('Timeout 30000ms exceeded.'), { name: 'TimeoutError' });
    expect(classifyError(timeout)).toBe('timeout');
    expect(
      classifyError(new Error('Target page, context or browser has been closed')),
    ).toBe('browser_crash');
    expect(classifyError(new Error('page.goto: net::ERR_CONNECTION_REFUSED'))).toBe('error');
  });
});

describe('output record shape', () => {
  it('keeps the schema order and drops unmeasured fields', () => {
    const record = buildRecord(3, 'scroll', 'ok', {
      elapsed_ms: 12.3456,
      start_ms: 1,
      end_ms: 13.3456,
      displayed_rows: 22,
      result_rows: 2000,
      points_in: 2000,
      points_out: 501,
      request_bytes: 0,
      response_bytes: 0,
      requests: 0,
      detail: 'row=2000',
      ignored_field: 'nope',
    });
    expect(Object.keys(record)).toEqual([
      'i',
      'phase',
      'status',
      'elapsed_ms',
      'request_bytes',
      'response_bytes',
      'requests',
      'detail',
      'displayed_rows',
      'result_rows',
      'points_in',
      'points_out',
      'start_ms',
      'end_ms',
    ]);
    expect(record).not.toHaveProperty('ignored_field');
  });

  it('rounds timings to milliseconds with three decimals', () => {
    expect(roundMs(1.23456)).toBe(1.235);
    expect(roundMs(0.0004)).toBe(0);
  });
});
