#!/usr/bin/env node
/**
 * Browser E2E performance benchmark for the production workbench build.
 *
 * This script drives ONE real user journey per sample through Chromium (Playwright),
 * against a URL that is already serving the production front end + compute backend.
 * It prints machine-readable JSONL to **stdout only** and diagnostics to stderr.
 *
 * It is deliberately a measurement harness, not a test suite: every phase either
 * produces a verified number or states why it could not (limit / timeout / crash /
 * wrong result), and nothing is retried silently.
 *
 * ── CLI ──────────────────────────────────────────────────────────────────────
 *
 *   node web/scripts/perf-browser.mjs \
 *     --url URL --file PATH --rows N --cols N --samples N --warmup N \
 *     --timeout-ms N [--mode import|chart|cold] [--steady-ms N] [--hold-ms N] \
 *     [--missing]
 *
 *   --file       required for --mode import|chart (a real path; the browser's file
 *                chooser receives that path, the file is never read into this process)
 *   --rows/--cols  required for --mode import|chart; the expected fixture shape. They
 *                are verification inputs, not hints: a mismatch is `wrong_result`.
 *   --mode       import (default): load + table + scroll + formula card phases
 *                chart:            load + table + chart draw/zoom phases
 *                cold:             page boot + backend handshake only (no file)
 *   --timeout-ms per-phase timeout (default 30000)
 *   --steady-ms  after the phases, wait until the open tab has had NO DOM mutations
 *                for this many ms, emit the `steady` record, then keep the tab open
 *                (default 0 = disabled)
 *   --hold-ms    how long to keep the tab open AFTER the `steady` record
 *                (default: --steady-ms). A newline on stdin releases it early; with
 *                several emitted samples, write one newline per steady marker.
 *   --missing    the fixture writes `NA` at every cell where (r + 13*c) % 97 == 13
 *                (0-based r, c); the harness then expects `—` there.
 *
 * ── Workflow per sample (fresh browser context) ─────────────────────────────
 *
 *   cold   : page_ready, backend_hello
 *   import : page_ready, backend_hello, register, first_cell, scroll,
 *            formula_preview, recompute_preview, show_more
 *   chart  : page_ready, backend_hello, register, first_cell,
 *            chart_first_draw, chart_zoom_frame_p95
 *
 * A failed phase emits the remaining phases as `blocked` (detail names the
 * prerequisite), so every sample has a complete phase set.
 *
 * ── Output record schema (exact) ────────────────────────────────────────────
 *
 *   {
 *     i: number,                 // 1-based non-warmup sample ordinal (repeated on
 *                                // every phase record of that sample; warmups are not
 *                                // emitted at all)
 *     phase: string,             // see phase list above; also `metadata`, `steady`
 *     status: 'ok' | 'protocol_limit' | 'resource_limit' | 'timeout' |
 *             'browser_crash' | 'wrong_result' | 'blocked' | 'error',
 *     elapsed_ms?: number,       // end_ms - start_ms (3 decimals); exception:
 *                                // chart_zoom_frame_p95 -> p95 frame interval in ms
 *     request_bytes?: number,    // HTTP request BODY bytes, summed over the phase
 *     response_bytes?: number,   // decoded response BODY bytes, summed over the phase
 *     requests?: number,         // API requests issued in the phase (/api/events excluded)
 *     detail?: string,           // short key=value diagnostics; never user prose
 *     displayed_rows?: number,   // rows actually in the DOM (virtual window)
 *     result_rows?: number,      // rows the data source reports (total, not the window)
 *     points_in?: number,        // chart: points handed to the series
 *     points_out?: number,       // chart: points passed to ECharts after application thinning
 *     start_ms?: number,         // browser performance.now() clock
 *     end_ms?: number            // browser performance.now() clock
 *   }
 *
 * Two records sit outside the sample journey:
 *   { phase: 'metadata', status: 'ok', browser_version: string }   (once, before samples)
 *   { i, phase: 'steady', status: 'ok'|'timeout'|'browser_crash',
 *     start_ms, end_ms, elapsed_ms, detail }                      (per emitted sample,
 *                                                                  only with --steady-ms)
 *
 * No other keys are emitted. All timestamps come from the page's `performance.now()`;
 * records of one sample share that clock (no cross-process time offsets). `i` groups
 * them. Phase records never carry fields that were not measured.
 *
 * ── Status meanings ─────────────────────────────────────────────────────────
 *
 *   ok              measured and verified
 *   protocol_limit  a protocol ceiling was hit: HTTP 413 / code payloadTooLarge
 *   resource_limit  a resource ceiling was hit: local result-display cap truncation,
 *                   HTTP 507
 *   timeout         a condition was not met within --timeout-ms
 *   browser_crash   the renderer/page crashed or was closed under us
 *   wrong_result    the workflow completed but a verified number did not match
 *   blocked         the app could not reach the phase (prerequisite failed, offline
 *                   banner, no table card); detail names it
 *   error           an unexpected condition (bad HTTP status, formula parse error, …)
 *
 * ── What is verified (never "the UI looked fine") ───────────────────────────
 *
 *   * the fixture is generated by: value(r,c) = ((r*(2*c+1)+17*c+3) % 1009 - 504) / 8,
 *     header `c0,c1,…`; the harness recomputes expected cells independently.
 *   * register inspects the HTTP answer itself (200 + matrixId vs 413 payloadTooLarge);
 *     the UI outcome is only reported in `detail` (`ui=card|none`).
 *   * first_cell compares the painted cell text with the expected value and verifies
 *     the parsed shape (columns from the header row, rows from the scroll geometry).
 *   * scroll really moves the virtual window to the last row and checks that known
 *     row's first cell, not just "something changed".
 *   * formula_preview/recompute_preview wait for the NEW result of a NEW expression
 *     (stale previous values are rejected), and verify total-vs-shown preview counts.
 *   * show_more verifies the full result arrived (or reports the local display cap).
 *   * chart_first_draw verifies the series contains the full column and that the first
 *     finite plotted point equals the fixture value.
 *   * chart_zoom_frame_p95 dispatches real wheel events over the plot and records
 *     in-page rAF frame intervals; the zoom must have changed the dataZoom range.
 *
 * ── Cleanup ─────────────────────────────────────────────────────────────────
 *
 * Every compute node and uploaded matrix created during a sample (tracked from the
 * response bodies of POST /api/nodes and POST /api/matrices) is DELETEd before the
 * context closes, so samples do not accumulate backend state. Failures are reported
 * on stderr; in that case root should run one backend process per invocation.
 *
 * ── Environment ─────────────────────────────────────────────────────────────
 *
 * Needs Playwright's Chromium (`PLAYWRIGHT_BROWSERS_PATH`) and whatever the host needs
 * to run it (typically `LD_LIBRARY_PATH` / `FONTCONFIG_PATH`). Nothing is launched
 * besides the browser: the URL is supplied by the caller.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** One row budget the workbench uses for a function card's first result preview. */
const RESULT_PREVIEW_ROWS = 100;
/** Local display-cache ceiling of the workbench (mirrors workspaceStore.ts). */
const MAX_CACHE_ROWS = 200_000;
/** Background event polling is not part of any phase's request accounting. */
const EXCLUDED_API_PATH = '/api/events';

const PHASE_KEYS = Object.freeze([
  'elapsed_ms',
  'request_bytes',
  'response_bytes',
  'requests',
  'detail',
  'displayed_rows',
  'result_rows',
  'points_in',
  'points_out',
  'frame_gap_p50_ms',
  'frame_gap_p95_ms',
  'frame_gap_max_ms',
  'frames',
  'start_ms',
  'end_ms',
]);

/** A CLI contract violation; `main` turns it into exit code 2. */
export class UsageError extends Error {}

// ── Small pure helpers (exported for tests, and used by the harness) ────────

/** Round to milliseconds with three decimals; timings are never quoted finer. */
export function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * The benchmark fixture's value at a 0-BASED cell.
 * Root generates the CSV from this formula, so the harness can verify cells without
 * reading the file. Division by 8 is exact in binary, so `String()` round-trips.
 */
export function fixtureValue(row, col) {
  return (((row * (2 * col + 1) + 17 * col + 3) % 1009) - 504) / 8;
}

/** True when the optional NA fixture is missing at this 0-based cell. */
export function isMissingCell(row, col, missingEnabled) {
  return Boolean(missingEnabled) && ((row + 13 * col) % 97 === 13);
}

/** The table's display spelling of a number (mirrors core/numeric.ts formatCell). */
export function formatCellValue(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  return String(value).replace(/e([+-])(\d)$/, 'e$10$2');
}

/** Expected display text of the fixture cell, honouring --missing. */
export function expectedCellText(row, col, missingEnabled) {
  return formatCellValue(isMissingCell(row, col, missingEnabled) ? NaN : fixtureValue(row, col));
}

/** Which phases one sample of a mode runs, in order. */
export function phasesForMode(mode) {
  if (mode === 'cold') return ['page_ready', 'backend_hello'];
  if (mode === 'chart') {
    return [
      'page_ready',
      'backend_hello',
      'register',
      'first_cell',
      'chart_first_draw',
      'chart_zoom_frame_p95',
    ];
  }
  return [
    'page_ready',
    'backend_hello',
    'register',
    'first_cell',
    'scroll',
    'formula_preview',
    'recompute_preview',
    'show_more',
  ];
}

/**
 * Status of the matrix-registration answer, decided from the HTTP response alone —
 * never from "a card appeared". The UI outcome is recorded separately in `detail`.
 */
export function registerStatus(httpStatus, body) {
  const code = body && typeof body === 'object' ? body.code : undefined;
  if (httpStatus === 413 || code === 'payloadTooLarge') return 'protocol_limit';
  if (httpStatus === 507) return 'resource_limit';
  if (httpStatus >= 200 && httpStatus < 300) {
    return body && Number.isFinite(body.matrixId) ? 'ok' : 'error';
  }
  return 'error';
}

/** Map any thrown error to the schema's status enum. */
export function canRunPhase(phase, blocker) {
  return !blocker || (blocker.phase === 'register' && blocker.status === 'protocol_limit' &&
    ['first_cell', 'scroll', 'chart_first_draw', 'chart_zoom_frame_p95'].includes(phase));
}

export function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === 'object' ? error.name : '';
  if (/crash|Target page, context or browser has been closed|Target closed|browser has been closed/i.test(message)) {
    return 'browser_crash';
  }
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded|timed out/i.test(message)) return 'timeout';
  return 'error';
}

/** Build a schema-ordered record; only measured keys are included. */
export function buildRecord(i, phase, status, extra = {}) {
  const record = { i, phase, status };
  for (const key of PHASE_KEYS) {
    if (extra[key] !== undefined) record[key] = extra[key];
  }
  return record;
}

/** Compact one-line diagnostics; long values are elided. */
export function ellipsis(text, max = 160) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Parse the CLI into the contract `parseArgs` validates. Pure apart from the file
 * existence check, and it never exits (main maps `UsageError` to exit 2).
 */
export function parseArgs(argv) {
  const opts = {
    url: null,
    file: null,
    rows: null,
    cols: null,
    samples: 1,
    warmup: 0,
    timeoutMs: 30_000,
    mode: 'import',
    steadyMs: 0,
    holdMs: null,
    missing: false,
  };

  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`missing value for ${flag}`);
    }
    return value;
  };
  const readInt = (index, flag, min) => {
    const raw = readValue(index, flag);
    if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} expects a non-negative integer, got "${raw}"`);
    const value = Number(raw);
    if (value < min) throw new UsageError(`${flag} must be >= ${min}`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--url':
        opts.url = readValue(index, flag);
        index += 1;
        break;
      case '--file':
        opts.file = readValue(index, flag);
        index += 1;
        break;
      case '--rows':
        opts.rows = readInt(index, flag, 1);
        index += 1;
        break;
      case '--cols':
        opts.cols = readInt(index, flag, 1);
        index += 1;
        break;
      case '--samples':
        opts.samples = readInt(index, flag, 1);
        index += 1;
        break;
      case '--warmup':
        opts.warmup = readInt(index, flag, 0);
        index += 1;
        break;
      case '--timeout-ms':
        opts.timeoutMs = readInt(index, flag, 100);
        index += 1;
        break;
      case '--steady-ms':
        opts.steadyMs = readInt(index, flag, 0);
        index += 1;
        break;
      case '--hold-ms':
        opts.holdMs = readInt(index, flag, 0);
        index += 1;
        break;
      case '--mode': {
        const mode = readValue(index, flag);
        if (mode !== 'import' && mode !== 'chart' && mode !== 'cold') {
          throw new UsageError(`--mode expects import|chart|cold, got "${mode}"`);
        }
        opts.mode = mode;
        index += 1;
        break;
      }
      case '--missing':
        opts.missing = true;
        break;
      case '--help':
      case '-h':
        throw new UsageError('');
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }

  if (!opts.url) throw new UsageError('--url is required');
  let parsedUrl;
  try {
    parsedUrl = new URL(opts.url);
  } catch {
    throw new UsageError(`--url is not a valid URL: "${opts.url}"`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new UsageError('--url must be http(s)');
  }
  opts.url = parsedUrl.origin + (parsedUrl.pathname === '' ? '/' : parsedUrl.pathname);

  if (opts.mode !== 'cold') {
    if (!opts.file) throw new UsageError(`--file is required for --mode ${opts.mode}`);
    opts.file = path.resolve(process.cwd(), opts.file);
    if (!fs.existsSync(opts.file) || !fs.statSync(opts.file).isFile()) {
      throw new UsageError(`--file does not exist: ${opts.file}`);
    }
    if (opts.rows === null || opts.cols === null) {
      throw new UsageError(`--rows and --cols are required for --mode ${opts.mode}`);
    }
  }
  if (opts.holdMs === null) opts.holdMs = opts.steadyMs;
  return opts;
}

// ── Page/browser helpers ────────────────────────────────────────────────────

/** Browser monotonic clock read. */
function now(page) {
  return page.evaluate(() => performance.now());
}

/** Resolve on the next painted frame, returning the browser timestamp then. */
function nextPaint(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      }),
  );
}

/**
 * Wait for an in-page predicate and return the browser timestamp at which it held.
 * The predicate must RETURN a truthy value when satisfied (normally `performance.now()`),
 * so the timestamp belongs to the page's clock, not to the Node side.
 */
async function waitForTime(page, predicate, arg, timeoutMs) {
  const handle = await page.waitForFunction(predicate, arg, { polling: 'raf', timeout: timeoutMs });
  const value = await handle.jsonValue();
  return typeof value === 'number' ? value : await now(page);
}

/** Read the offline/env banner text, or null when no banner is shown. */
async function bannerText(page) {
  try {
    const banner = page.locator('.backend-banner').first();
    if ((await banner.count()) === 0) return null;
    if (!(await banner.isVisible())) return null;
    return ellipsis(await banner.innerText(), 120);
  } catch {
    return null;
  }
}

/** Body length of a response, preferring the declared Content-Length. */
async function responseBytesOf(response) {
  const declared = Number(response.headers()['content-length']);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  try {
    const body = await response.body();
    return body.length;
  } catch {
    return 0;
  }
}

/** Sanitize a pathname for phase matching. */
function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

// ── Network accounting ──────────────────────────────────────────────────────

/**
 * Attach per-request accounting to a page. A "meter" is the phase currently being
 * measured; requests are attributed to the meter that was active when they STARTED
 * (their bytes still land in that phase even if the answer arrives a moment later).
 * `/api/events` long polling is excluded everywhere: it is background traffic.
 */
function attachNetwork(page, net) {
  const byRequest = new WeakMap();
  page.on('request', (request) => {
    const pathname = pathnameOf(request.url());
    if (!pathname.startsWith('/api/') || pathname === EXCLUDED_API_PATH) return;
    let requestBytes = 0;
    try {
      requestBytes = request.postDataBuffer()?.length ?? 0;
    } catch {
      requestBytes = 0;
    }
    const entry = {
      method: request.method(),
      path: pathname,
      requestBytes,
      responseBytes: 0,
      status: null,
      meter: net.meter,
      bodyPromise: null,
    };
    byRequest.set(request, entry);
    net.entries.push(entry);
    if (entry.meter) {
      entry.meter.requests += 1;
      entry.meter.requestBytes += requestBytes;
    }
  });

  page.on('response', (response) => {
    const request = response.request();
    const entry = byRequest.get(request);
    if (!entry) return;
    entry.status = response.status();
    const isJsonPost =
      request.method() === 'POST' ||
      entry.path === '/api/hello' ||
      /^\/api\/nodes\/\d+$/.test(entry.path);
    if (isJsonPost) {
      entry.bodyPromise = response
        .json()
        .then((body) => {
          if (body && Number.isFinite(body.matrixId)) net.matrixIds.add(body.matrixId);
          if (body && Number.isFinite(body.nodeId)) net.nodeIds.add(body.nodeId);
          return body;
        })
        .catch(() => null);
    }
    void responseBytesOf(response).then((bytes) => {
      entry.responseBytes = bytes;
      if (entry.meter) entry.meter.responseBytes += bytes;
    });
  });
}

function beginMeter(net) {
  net.meter = { requests: 0, requestBytes: 0, responseBytes: 0 };
  return net.meter;
}

function endMeter(net) {
  net.meter = null;
}

/** Latest recorded entry for a pathname. */
function lastEntry(net, matcher) {
  for (let index = net.entries.length - 1; index >= 0; index -= 1) {
    const entry = net.entries[index];
    if (matcher(entry)) return entry;
  }
  return null;
}

/** Wait until a response body from a tracked entry is parsed (bounded). */
async function entryJson(entry, timeoutMs = 5_000) {
  if (!entry || !entry.bodyPromise) return null;
  let timer;
  try {
    return await Promise.race([
      entry.bodyPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-sample journey ──────────────────────────────────────────────────────

/**
 * One isolated journey: fresh context, real file chooser, phases in order, optional
 * steady marker + hold, backend cleanup, context close.
 *
 * Returns the records it emitted (or would emit for a warmup); main uses that for the
 * stderr summary only.
 */
async function runSample({ sampleIndex, emit, browser, args }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page;
  try {
    page = await context.newPage();
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  page.setDefaultTimeout(args.timeoutMs);
  page.setDefaultNavigationTimeout(args.timeoutMs);

  const net = { meter: null, entries: [], nodeIds: new Set(), matrixIds: new Set() };
  attachNetwork(page, net);

  let crashed = false;
  page.on('crash', () => {
    crashed = true;
  });
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  const records = [];
  const push = (record) => {
    records.push(record);
    if (!emit) return;
    const line = `${JSON.stringify(record)}\n`;
    try {
      fs.writeSync(1, line);
    } catch {
      process.stdout.write(line);
    }
  };

  // State shared between phases (each is the verified result of an earlier step).
  let matrixCell0Value = Number.NaN;
  let firstHeaderLabel = null;

  async function verifyMatrixShape() {
    return page.evaluate(() => {
      const card = document.querySelector('.card--matrix');
      if (!card) return null;
      const viewport = card.querySelector('.vtable__viewport');
      const row = card.querySelector('.vtable__row');
      const headers = card.querySelectorAll('.vtable__colhead');
      const rowHeight = row ? row.getBoundingClientRect().height : 0;
      return {
        headerCount: headers.length,
        firstHeader: headers[0] ? headers[0].textContent.trim() : '',
        domRows: card.querySelectorAll('.vtable__row').length,
        rowHeight,
        rows:
          viewport && rowHeight > 0 ? Math.round(viewport.scrollHeight / rowHeight) : 0,
      };
    });
  }

  // ── page_ready ────────────────────────────────────────────────────────────
  async function phasePageReady() {
    const phase = 'page_ready';
    try {
      await page.goto(args.url, { waitUntil: 'load', timeout: args.timeoutMs });
      await page.waitForSelector('.app', { timeout: args.timeoutMs });
      await page.waitForSelector('.empty-state, .card', { timeout: args.timeoutMs });
      const end = await nextPaint(page);
      const title = await page.title().catch(() => '');
      return buildRecord(sampleIndex, phase, 'ok', {
        elapsed_ms: roundMs(end),
        start_ms: 0,
        end_ms: roundMs(end),
        detail: `title="${ellipsis(title, 60)}"`,
      });
    } catch (error) {
      return buildRecord(sampleIndex, phase, classifyError(error), {
        detail: ellipsis(error?.message ?? error),
      });
    }
  }

  // ── backend_hello ─────────────────────────────────────────────────────────
  async function phaseBackendHello() {
    const phase = 'backend_hello';
    const meter = beginMeter(net);
    try {
      // The app's own handshake: its resource-timing entry is a pure browser-clock
      // measurement of the request. If the app made no such request (or it failed
      // before producing an entry), fall back to an explicit in-page fetch probe.
      let timing = null;
      try {
        await waitForTime(
          page,
          () => {
            const entries = performance
              .getEntriesByType('resource')
              .filter((entry) => {
                try {
                  return new URL(entry.name).pathname === '/api/hello';
                } catch {
                  return false;
                }
              });
            const last = entries[entries.length - 1];
            if (!last || !(last.responseEnd > 0)) return false;
            return performance.now();
          },
          null,
          Math.min(args.timeoutMs, 10_000),
        );
        timing = await page.evaluate(() => {
          const entries = performance
            .getEntriesByType('resource')
            .filter((entry) => {
              try {
                return new URL(entry.name).pathname === '/api/hello';
              } catch {
                return false;
              }
            });
          const last = entries[entries.length - 1];
          return last
            ? {
                start: last.startTime,
                end: last.responseEnd,
                decoded: last.decodedBodySize,
                transferred: last.transferSize,
              }
            : null;
        });
      } catch {
        timing = null;
      }

      let probe = null;
      if (!timing) {
        probe = await page.evaluate(async () => {
          const start = performance.now();
          try {
            const response = await fetch('/api/hello');
            const text = await response.text();
            return { start, end: performance.now(), status: response.status, text };
          } catch (error) {
            return { start, end: performance.now(), error: String(error) };
          }
        });
      }

      const entry = lastEntry(net, (candidate) => candidate.path === '/api/hello');
      const body = await entryJson(entry, 2_000);
      const parsed = body ?? (probe?.text ? safeJson(probe.text) : null);
      const httpStatus = probe?.status ?? entry?.status ?? 0;

      const capabilities = Array.isArray(parsed?.capabilities) ? parsed.capabilities : [];
      const status =
        httpStatus >= 200 &&
        httpStatus < 300 &&
        parsed &&
        parsed.protocol === 1 &&
        capabilities.includes('signature.v1')
          ? 'ok'
          : 'blocked';
      const start = timing ? timing.start : probe?.start;
      const end = timing ? timing.end : probe?.end;
      const responseBytes = entry?.responseBytes || timing?.decoded || probe?.text?.length || 0;
      return buildRecord(sampleIndex, phase, status, {
        ...(typeof start === 'number' && typeof end === 'number'
          ? {
              elapsed_ms: roundMs(end - start),
              start_ms: roundMs(start),
              end_ms: roundMs(end),
            }
          : {}),
        request_bytes: entry?.requestBytes ?? 0,
        response_bytes: responseBytes,
        requests: meter.requests || (timing || probe ? 1 : 0),
        detail: [
          `http=${httpStatus}`,
          `protocol=${parsed?.protocol ?? '?'}`,
          `build=${parsed?.build ?? '?'}`,
          `capabilities=${capabilities.length}`,
          `maxWindowRows=${parsed?.limits?.maxWindowRows ?? '?'}`,
          timing ? 'source=app' : 'source=probe',
        ].join(' '),
      });
    } catch (error) {
      return buildRecord(sampleIndex, phase, classifyError(error), {
        detail: ellipsis(error?.message ?? error),
      });
    } finally {
      endMeter(net);
    }
  }

  // ── register ──────────────────────────────────────────────────────────────
  async function phaseRegister() {
    const phase = 'register';
    const meter = beginMeter(net);
    try {
      await page.waitForSelector('.empty-state__button', { timeout: args.timeoutMs });
      const chooserPromise = page.waitForEvent('filechooser', { timeout: args.timeoutMs });
      await page.locator('.empty-state__button').click();
      const chooser = await chooserPromise;
      await page.evaluate((expected) => {
        const timing = { start: null, end: null, observer: null };
        window.__perfFirstCell = timing;
        // Chromium DevTools may evict response bodies for large uploads. Keep the
        // application's own text read as a fallback without cloning/resending a body.
        const nativeText = Response.prototype.text;
        window.__perfRegistration = null;
        window.__perfRestoreText = () => { Response.prototype.text = nativeText; };
        Response.prototype.text = function (...args) {
          const text = nativeText.apply(this, args);
          if (this.ok && /^\/api\/matrices(?:\/raw)?$/.test(new URL(this.url || location.href).pathname)) {
            void text.then((body) => { window.__perfRegistration = body; }, () => {});
          }
          return text;
        };
        window.addEventListener('change', (event) => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'file') return;
          timing.start = performance.now();
          const observe = () => {
            const cell = document.querySelector('.card--matrix .vtable__row .vtable__cell');
            if (cell?.textContent.trim() !== expected || !cell.getClientRects().length) return;
            timing.end = performance.now();
            timing.observer.disconnect();
          };
          timing.observer = new MutationObserver(observe);
          timing.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }, { capture: true, once: true });
      }, expectedCellText(0, 0, args.missing));
      const start = await now(page);
      const responsePromise = page.waitForResponse(
        (response) => {
          const pathname = pathnameOf(response.url());
          return (
            response.request().method() === 'POST' &&
            (pathname === '/api/matrices' || pathname === '/api/matrices/raw')
          );
        },
        { timeout: args.timeoutMs },
      );
      await chooser.setFiles(args.file);
      const response = await responsePromise;
      const end = await now(page);
      const httpStatus = response.status();

      const entry = lastEntry(
        net,
        (candidate) =>
          candidate.method === 'POST' &&
          (candidate.path === '/api/matrices' || candidate.path === '/api/matrices/raw'),
      );
      let body = await entryJson(entry, 5_000);
      if (httpStatus === 200 && body?.matrixId == null) {
        const handle = await page.waitForFunction(() => window.__perfRegistration, undefined, {
          timeout: Math.min(args.timeoutMs, 5_000),
        }).catch(() => null);
        if (handle) {
          const text = await handle.jsonValue();
          await handle.dispose();
          try { body = JSON.parse(text); } catch { /* malformed response is still a failure */ }
        }
      }
      if (Number.isFinite(body?.matrixId)) net.matrixIds.add(body.matrixId);
      const status = registerStatus(httpStatus, body);

      // UI outcome is reported, never used to decide the status.
      let ui = 'none';
      try {
        await page.waitForSelector('.card--matrix', { timeout: Math.min(5_000, args.timeoutMs) });
        ui = 'card';
      } catch {
        ui = 'none';
      }
      const banner = await bannerText(page);
      const detailParts = [
        `http=${httpStatus}`,
        body?.code ? `code=${body.code}` : null,
        Number.isFinite(body?.matrixId) ? `matrixId=${body.matrixId}` : null,
        `ui=${ui}`,
        banner ? `banner="${banner}"` : null,
      ].filter(Boolean);
      return buildRecord(sampleIndex, phase, status, {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        request_bytes: entry?.requestBytes ?? 0,
        response_bytes: entry?.responseBytes ?? 0,
        requests: meter.requests,
        detail: detailParts.join(' '),
      });
    } catch (error) {
      const banner = await bannerText(page);
      const status = banner ? 'blocked' : classifyError(error);
      return buildRecord(sampleIndex, phase, status, {
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        detail: [ellipsis(error?.message ?? error), banner ? `banner="${banner}"` : null]
          .filter(Boolean)
          .join(' '),
      });
    } finally {
      await page.evaluate(() => {
        window.__perfRestoreText?.();
        delete window.__perfRestoreText;
        delete window.__perfRegistration;
      }).catch(() => {});
      endMeter(net);
    }
  }

  // ── first_cell ────────────────────────────────────────────────────────────
  async function phaseFirstCell() {
    const phase = 'first_cell';
    const meter = beginMeter(net);
    const expected = expectedCellText(0, 0, args.missing);
    try {
      const handle = await page.waitForFunction(() => {
        const time = window.__perfFirstCell;
        return time?.end == null ? false : { start: time.start, end: time.end };
      }, undefined, { timeout: args.timeoutMs });
      const { start, end } = await handle.jsonValue();
      await handle.dispose();
      const shape = await verifyMatrixShape();
      if (!shape) {
        return buildRecord(sampleIndex, phase, 'blocked', { detail: 'matrix-card-missing' });
      }
      const rowsOk = shape.rows === args.rows;
      const colsOk = shape.headerCount === args.cols;
      const cellOk = true; // the wait above only resolves on the expected text
      const status = rowsOk && colsOk && cellOk ? 'ok' : 'wrong_result';
      matrixCell0Value = isMissingCell(0, 0, args.missing) ? Number.NaN : fixtureValue(0, 0);
      firstHeaderLabel = shape.firstHeader.split(/\s+/)[0] || null;
      return buildRecord(sampleIndex, phase, status, {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        displayed_rows: shape.domRows,
        result_rows: shape.rows,
        detail: `first=${expected} rows=${shape.rows}/${args.rows} cols=${shape.headerCount}/${args.cols} dom_rows=${shape.domRows}`,
      });
    } catch (error) {
      const shape = await verifyMatrixShape().catch(() => null);
      const banner = await bannerText(page);
      let status = classifyError(error);
      let detail = ellipsis(error?.message ?? error);
      if (banner) {
        status = 'blocked';
        detail = `banner="${banner}"`;
      } else if (shape) {
        const actual = await page
          .evaluate(() => {
            const cell = document.querySelector('.card--matrix .vtable__row .vtable__cell');
            return cell ? cell.textContent.trim() : null;
          })
          .catch(() => null);
        if (actual !== null && actual !== expected) {
          status = 'wrong_result';
          detail = `expected=${expected} actual=${actual} rows=${shape.rows}/${args.rows} cols=${shape.headerCount}/${args.cols}`;
        }
      }
      return buildRecord(sampleIndex, phase, status, {
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        detail,
      });
    } finally {
      endMeter(net);
    }
  }

  // ── scroll ────────────────────────────────────────────────────────────────
  async function phaseScroll() {
    const phase = 'scroll';
    const targetRow = args.rows - 1; // 0-based last row
    const expected = expectedCellText(targetRow, 0, args.missing);
    try {
      const start = await now(page);
      const geometry = await page.evaluate(() => {
        const viewport = document.querySelector('.card--matrix .vtable__viewport');
        const row = document.querySelector('.card--matrix .vtable__row');
        return { rowHeight: row ? row.getBoundingClientRect().height : 0 };
      });
      if (!(geometry.rowHeight > 0)) {
        return buildRecord(sampleIndex, phase, 'blocked', { detail: 'no table row geometry' });
      }
      await page.evaluate((top) => {
        const viewport = document.querySelector('.card--matrix .vtable__viewport');
        viewport.scrollTop = top;
      }, targetRow * geometry.rowHeight);
      const end = await waitForTime(
        page,
        (arg) => {
          const rows = [...document.querySelectorAll('.card--matrix .vtable__row')];
          const target = rows.find((row) => {
            const head = row.querySelector('.vtable__rowhead');
            const digits = head ? (head.textContent.match(/\d+/g) || []) : [];
            return digits.length > 0 && Number(digits[digits.length - 1]) === arg.rowNumber;
          });
          if (!target) return false;
          const cell = target.querySelector('.vtable__cell');
          if (!cell || cell.textContent.trim() !== arg.expected) return false;
          return performance.now();
        },
        { rowNumber: targetRow + 1, expected },
        args.timeoutMs,
      );
      const state = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.card--matrix .vtable__row')];
        return {
          domRows: rows.length,
          lastHead: rows[rows.length - 1]?.querySelector('.vtable__rowhead')?.textContent ?? '',
        };
      });
      return buildRecord(sampleIndex, phase, 'ok', {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        displayed_rows: state.domRows,
        result_rows: args.rows,
        detail: `row=${targetRow + 1} first=${expected} window_last=${ellipsis(state.lastHead, 20)}`,
      });
    } catch (error) {
      // A rendered row with the wrong cell value is a wrong result, not a timeout.
      const actual = await page
        .evaluate((rowNumber) => {
          const rows = [...document.querySelectorAll('.card--matrix .vtable__row')];
          const target = rows.find((row) => {
            const head = row.querySelector('.vtable__rowhead');
            const digits = head ? (head.textContent.match(/\d+/g) || []) : [];
            return digits.length > 0 && Number(digits[digits.length - 1]) === rowNumber;
          });
          return target ? target.querySelector('.vtable__cell')?.textContent.trim() ?? null : null;
        }, targetRow + 1)
        .catch(() => null);
      if (actual !== null && actual !== expected) {
        return buildRecord(sampleIndex, phase, 'wrong_result', {
          detail: `row=${targetRow + 1} expected=${expected} actual=${actual}`,
        });
      }
      return buildRecord(sampleIndex, phase, classifyError(error), {
        detail: ellipsis(error?.message ?? error),
      });
    }
  }

  // ── formula card shared setup + reading ───────────────────────────────────
  function formulaReference() {
    const label = (firstHeaderLabel ?? '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(label) && !/^[_.]/.test(label)) return label;
    return 'Pos.1';
  }

  async function readFormulaState() {
    return page.evaluate(() => {
      const card = document.querySelector('.card--formula');
      if (!card) return null;
      const input = card.querySelector('.formula-card__expr');
      const cell = card.querySelector('.formula-card__result .vtable__row .vtable__cell');
      const count = card.querySelector('.formula-card__result-count');
      const truncated = card.querySelector('.formula-card__result-truncated');
      const shape = card.querySelector('.formula-card__output-shape');
      const errors = [...card.querySelectorAll('.formula-card__error')].map((node) =>
        node.textContent.trim(),
      );
      const parseInts = (text) => (text ? (text.match(/\d+/g) || []).map(Number) : []);
      const countInts = parseInts(count?.textContent ?? '');
      const shapeInts = parseInts(shape?.textContent ?? '');
      return {
        expression: input ? input.value : null,
        cell: cell ? cell.textContent.trim() : null,
        countText: count ? count.textContent.trim() : null,
        truncatedText: truncated ? truncated.textContent.trim() : null,
        total: countInts.length >= 2 ? countInts[1] : shapeInts.length > 0 ? shapeInts[shapeInts.length - 1] : null,
        shown:
          countInts.length >= 2
            ? countInts[0]
            : shapeInts.length > 0
              ? shapeInts[shapeInts.length - 1]
              : null,
        domRows: card.querySelectorAll('.formula-card__result .vtable__row').length,
        errors,
      };
    });
  }

  async function ensureFormulaCard() {
    await page.locator('.card--matrix .vtable__colhead').first().click({ button: 'right' });
    await page.waitForSelector('.context-menu', { timeout: args.timeoutMs });
    await page
      .locator('.context-menu__item')
      .filter({ hasText: /New Formula Card|新建公式卡/ })
      .first()
      .click();
    await page.waitForSelector('.card--formula', { timeout: args.timeoutMs });
    // Wait for the initial expression to produce its first preview; editing before it
    // settles would measure the card's start-up, not the edit.
    await page.waitForFunction(
      () => {
        const card = document.querySelector('.card--formula');
        return Boolean(card && card.querySelector('.formula-card__result .vtable__row .vtable__cell'));
      },
      null,
      { polling: 'raf', timeout: args.timeoutMs },
    );
  }

  /** Fill an expression and wait for its NEW, non-stale preview. */
  async function previewPhase(phase, expression, expectedShared = {}) {
    const meter = beginMeter(net);
    try {
      const start = await now(page);
      const input = page.locator('.card--formula .formula-card__expr').first();
      await input.click();
      await input.fill(expression);
      const expected = expectedShared.expected;
      const end = await waitForTime(
        page,
        (arg) => {
          const card = document.querySelector('.card--formula');
          if (!card) return false;
          const inputNode = card.querySelector('.formula-card__expr');
          if (!inputNode || inputNode.value !== arg.expr) return false;
          if (card.querySelector('.formula-card__error')) return false;
          const cell = card.querySelector('.formula-card__result .vtable__row .vtable__cell');
          if (!cell || cell.textContent.trim() !== arg.expected) return false;
          const count = card.querySelector('.formula-card__result-count');
          const shape = card.querySelector('.formula-card__output-shape');
          const toInts = (text) => (text ? (text.match(/\d+/g) || []).map(Number) : []);
          const countInts = toInts(count?.textContent ?? '');
          const shapeInts = toInts(shape?.textContent ?? '');
          const total = countInts.length >= 2 ? countInts[1] : shapeInts.length > 0 ? shapeInts[shapeInts.length - 1] : null;
          const shown = countInts.length >= 2 ? countInts[0] : total;
          if (total !== arg.rows) return false;
          if (arg.rows > arg.previewRows && shown !== arg.previewRows) return false;
          if (arg.rows <= arg.previewRows && shown !== arg.rows) return false;
          return performance.now();
        },
        { expr: expression, expected, rows: args.rows, previewRows: RESULT_PREVIEW_ROWS },
        args.timeoutMs,
      );
      const state = await readFormulaState();
      const status = state && state.errors.length === 0 ? 'ok' : 'error';
      const valueOk = state?.cell === expected;
      const totalOk = state?.total === args.rows;
      const finalStatus = status === 'ok' && valueOk && totalOk ? 'ok' : 'wrong_result';
      return buildRecord(sampleIndex, phase, finalStatus, {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        displayed_rows: state?.domRows,
        result_rows: state?.total ?? undefined,
        detail: [
          `expr=${expression}`,
          `cell=${state?.cell ?? '?'}`,
          `shown=${state?.shown ?? '?'}`,
          `total=${state?.total ?? '?'}`,
          state?.truncatedText ? `truncated="${ellipsis(state.truncatedText, 40)}"` : null,
          state?.errors.length ? `errors="${ellipsis(state.errors.join(' | '), 100)}"` : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
    } catch (error) {
      const state = await readFormulaState().catch(() => null);
      let status = classifyError(error);
      let detail = ellipsis(error?.message ?? error);
      if (state) {
        if (state.errors.length > 0) {
          status = 'error';
          detail = `formula-error="${ellipsis(state.errors.join(' | '), 120)}"`;
        } else if (state.cell !== null && state.cell !== expectedShared.expected) {
          status = 'wrong_result';
          detail = `expected=${expectedShared.expected} actual=${state.cell} total=${state.total}/${args.rows} shown=${state.shown}`;
        } else if (state.total !== null && state.total !== args.rows) {
          status = 'wrong_result';
          detail = `total=${state.total}/${args.rows} shown=${state.shown}`;
        }
      }
      return buildRecord(sampleIndex, phase, status, {
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        detail,
      });
    } finally {
      endMeter(net);
    }
  }

  async function phaseFormulaPreview() {
    try {
      await ensureFormulaCard();
    } catch (error) {
      return buildRecord(sampleIndex, 'formula_preview', classifyError(error), {
        detail: `formula-card setup failed: ${ellipsis(error?.message ?? error)}`,
      });
    }
    const reference = formulaReference();
    const base = matrixCell0Value;
    const expected = formatCellValue(base * 2 + 1);
    return previewPhase('formula_preview', `${reference}*2+1`, { expected });
  }

  async function phaseRecomputePreview() {
    const reference = formulaReference();
    const base = matrixCell0Value;
    const expected = formatCellValue(base * 3 + 2);
    return previewPhase('recompute_preview', `${reference}*3+2`, { expected });
  }

  async function phaseShowMore() {
    const phase = 'show_more';
    const meter = beginMeter(net);
    try {
      const start = await now(page);
      const more = page.locator('.card--formula .formula-card__result-more .formula-card__show-more');
      if ((await more.count()) === 0) {
        const state = await readFormulaState();
        return buildRecord(sampleIndex, phase, 'ok', {
          elapsed_ms: 0,
          start_ms: roundMs(start),
          end_ms: roundMs(start),
          displayed_rows: state?.domRows,
          result_rows: state?.total ?? args.rows,
          detail: 'not-needed (result already complete)',
        });
      }
      await more.first().click();
      const end = await waitForTime(
        page,
        () => {
          const card = document.querySelector('.card--formula');
          if (!card) return false;
          const truncated = card.querySelector('.formula-card__result-truncated');
          const count = card.querySelector('.formula-card__result-count');
          if (truncated || !count) return performance.now();
          return false;
        },
        null,
        args.timeoutMs,
      );
      const state = await readFormulaState();
      const truncated = Boolean(state?.truncatedText);
      let resumed = state;
      if (truncated) {
        const cap = (state.truncatedText.match(/\d+/g) || []).map(Number).pop();
        return buildRecord(sampleIndex, phase, 'resource_limit', {
          elapsed_ms: roundMs(end - start),
          start_ms: roundMs(start),
          end_ms: roundMs(end),
          request_bytes: meter.requestBytes,
          response_bytes: meter.responseBytes,
          requests: meter.requests,
          displayed_rows: state.domRows,
          result_rows: state.total ?? args.rows,
          detail: `local-display-cap=${cap ?? '?'} of ${args.rows} rows`,
        });
      }
      const total = resumed?.total ?? args.rows;
      return buildRecord(sampleIndex, phase, total === args.rows ? 'ok' : 'wrong_result', {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        displayed_rows: resumed?.domRows,
        result_rows: total,
        detail: `complete total=${total}/${args.rows} dom_rows=${resumed?.domRows ?? '?'}`,
      });
    } catch (error) {
      const state = await readFormulaState().catch(() => null);
      return buildRecord(sampleIndex, phase, classifyError(error), {
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        detail: ellipsis(error?.message ?? error),
      });
    } finally {
      endMeter(net);
    }
  }

  // ── chart phases ──────────────────────────────────────────────────────────
  async function openChart() {
    let action = 'acknowledge workspace gate';
    try {
      // A rejected registration can leave the local table available behind this modal.
      // Acknowledge it as a user would; do not clear the backend blocker or force-click.
      const ack = page.locator('.blocking-gate__ack');
      const acknowledged = await ack.isVisible();
      if (acknowledged) await ack.click();
      action = 'open column menu';
      await page.locator('.card--matrix .vtable__colhead').first().click({ button: 'right' });
      action = 'open chart submenu';
      await page
        .locator('.context-menu__item')
        .filter({ hasText: /Draw chart|绘制图表/ })
        .first()
        .hover();
      action = 'choose line chart';
      await page
        .locator('.context-menu__item')
        .filter({ hasText: /^Line$|^折线图$/ })
        .first()
        .click();
      action = 'wait for chart card';
      await page.waitForSelector('.card--chart', { timeout: args.timeoutMs });
      return acknowledged;
    } catch (error) {
      error.message = `${action}: ${error.message}`;
      throw error;
    }
  }

  /** Read the live ECharts series and the raw source badge (points in/out). */
  async function readChartInfo() {
    return page.evaluate(() => {
      const container = document.querySelector('.chart-card__plot');
      const echarts = window.echarts;
      const instance = container && echarts ? echarts.getInstanceByDom(container) : null;
      const option = instance ? instance.getOption() : null;
      const series = option?.series ?? [];
      const first = series[0];
      const data = Array.isArray(first?.data) ? first.data : [];
      const normalize = (point) => {
        if (Array.isArray(point)) return { x: point[0], y: point[1] };
        if (point && typeof point === 'object' && 'value' in point) {
          const value = point.value;
          if (Array.isArray(value)) return { x: value[0], y: value[1] };
          return { x: null, y: value };
        }
        return { x: null, y: point };
      };
      const zoom = option?.dataZoom?.[0] ?? null;
      // The badge states the RAW point count (source.raw.length). The option data
      // is what the app passed to ECharts, after missing-value handling and thinning.
      // Do not infer this from SVG path verbs: zoom clipping can change those.
      const badge = document.querySelector('.card--chart .card__badge')?.textContent?.trim() ?? '';
      const badgeInts = (badge.match(/\d+/g) || []).map(Number);
      let firstFinite = null;
      for (let index = 0; index < data.length; index += 1) {
        const point = normalize(data[index]);
        if (typeof point.y === 'number' && Number.isFinite(point.y)) {
          firstFinite = point;
          break;
        }
      }
      return {
        badge,
        badgePoints: badgeInts.length >= 2 ? badgeInts[1] : null,
        seriesCount: series.length,
        seriesType: first?.type ?? null,
        pointsOut: data.length,
        firstFinite,
        zoomStart: typeof zoom?.start === 'number' ? zoom.start : null,
        zoomEnd: typeof zoom?.end === 'number' ? zoom.end : null,
      };
    });
  }

  async function phaseChartFirstDraw() {
    const phase = 'chart_first_draw';
    const meter = beginMeter(net);
    try {
      const start = await now(page);
      const acknowledged = await openChart();
      const end = await waitForTime(
        page,
        (arg) => {
          const container = document.querySelector('.chart-card__plot');
          const echarts = window.echarts;
          const instance = container && echarts ? echarts.getInstanceByDom(container) : null;
          const series = instance?.getOption()?.series ?? [];
          const data = series[0]?.data ?? [];
          if (data.length === 0) return false;
          if (!container.querySelector('svg path')) return false;
          return performance.now();
        },
        null,
        args.timeoutMs,
      );
      const info = await readChartInfo();
      const pointsIn = info.badgePoints;
      const first = info.firstFinite;
      // The line series encodes x as the 1-BASED row number: [index + 1, value].
      const row = first && typeof first.x === 'number' ? Math.round(first.x) - 1 : null;
      const expected =
        row === null ? null : isMissingCell(row, 0, args.missing) ? Number.NaN : fixtureValue(row, 0);
      const firstOk =
        first !== null &&
        expected !== null &&
        Number.isFinite(first.y) &&
        Number.isFinite(expected) &&
        Math.abs(first.y - expected) <= 1e-12 * Math.max(1, Math.abs(expected));
      const status =
        pointsIn === args.rows && info.pointsOut > 0 && info.pointsOut <= pointsIn &&
        info.seriesType === 'line' && firstOk ? 'ok' : 'wrong_result';
      return buildRecord(sampleIndex, phase, status, {
        elapsed_ms: roundMs(end - start),
        start_ms: roundMs(start),
        end_ms: roundMs(end),
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        points_in: pointsIn,
        points_out: info.pointsOut,
        detail:
          `modal_ack=${Number(acknowledged)} series=${info.seriesCount} type=${info.seriesType} series_data=${info.pointsOut} ` +
          `first_row=${row ?? '?'} first_y=${first ? first.y : '?'} expected=${expected ?? '?'} badge="${ellipsis(info.badge, 40)}"`,
      });
    } catch (error) {
      return buildRecord(sampleIndex, phase, classifyError(error), {
        request_bytes: meter.requestBytes,
        response_bytes: meter.responseBytes,
        requests: meter.requests,
        detail: ellipsis(error?.message ?? error),
      });
    } finally {
      endMeter(net);
    }
  }

  async function phaseChartZoom() {
    const phase = 'chart_zoom_frame_p95';
    try {
      const box = await page.locator('.chart-card__plot').boundingBox();
      if (!box) {
        return buildRecord(sampleIndex, phase, 'blocked', { detail: 'chart plot has no box' });
      }
      const before = await readChartInfo();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.evaluate(() => {
        window.__perfFrames = [];
        window.__perfFrameStop = false;
        window.__perfFrameStart = performance.now();
        let last = performance.now();
        const loop = () => {
          const current = performance.now();
          window.__perfFrames.push(current - last);
          last = current;
          if (!window.__perfFrameStop) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      for (let tick = 0; tick < 24; tick += 1) {
        await page.mouse.wheel(0, -60);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(140);
      const frames = await page.evaluate(() => {
        window.__perfFrameStop = true;
        return {
          frames: window.__perfFrames,
          start: window.__perfFrameStart,
          end: performance.now(),
        };
      });
      const info = await readChartInfo();
      const deltas = frames.frames.slice(1).filter((value) => Number.isFinite(value) && value >= 0);
      const sorted = [...deltas].sort((a, b) => a - b);
      const pick = (fraction) => {
        if (sorted.length === 0) return null;
        const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
        return sorted[index];
      };
      const p50 = pick(0.5);
      const p95 = pick(0.95);
      const max = sorted.length > 0 ? sorted[sorted.length - 1] : null;
      const zoomChanged =
        before.zoomStart !== null &&
        info.zoomStart !== null &&
        (Math.abs((before.zoomStart ?? 0) - (info.zoomStart ?? 0)) > 1e-6 ||
          Math.abs((before.zoomEnd ?? 0) - (info.zoomEnd ?? 0)) > 1e-6);
      const status = deltas.length >= 8 && zoomChanged && p95 !== null ? 'ok' : 'wrong_result';
      return buildRecord(sampleIndex, phase, status, {
        // The phase name promises a p95; that is the number root's report wants.
        elapsed_ms: p95 === null ? undefined : roundMs(p95),
        start_ms: roundMs(frames.start),
        end_ms: roundMs(frames.end),
        points_in: info.badgePoints ?? undefined,
        points_out: info.pointsOut,
        frames: deltas.length,
        frame_gap_p50_ms: p50 === null ? undefined : roundMs(p50),
        frame_gap_p95_ms: p95 === null ? undefined : roundMs(p95),
        frame_gap_max_ms: max === null ? undefined : roundMs(max),
        detail:
          `frames=${deltas.length} p50=${p50 === null ? '?' : roundMs(p50)} p95=${p95 === null ? '?' : roundMs(p95)} max=${max === null ? '?' : roundMs(max)} ` +
          `zoom=${before.zoomStart ?? '?'}-${before.zoomEnd ?? '?'}->${info.zoomStart ?? '?'}-${info.zoomEnd ?? '?'}`,
      });
    } catch (error) {
      return buildRecord(sampleIndex, phase, classifyError(error), {
        detail: ellipsis(error?.message ?? error),
      });
    }
  }

  const runners = {
    page_ready: phasePageReady,
    backend_hello: phaseBackendHello,
    register: phaseRegister,
    first_cell: phaseFirstCell,
    scroll: phaseScroll,
    formula_preview: phaseFormulaPreview,
    recompute_preview: phaseRecomputePreview,
    show_more: phaseShowMore,
    chart_first_draw: phaseChartFirstDraw,
    chart_zoom_frame_p95: phaseChartZoom,
  };

  const emittedPhases = new Set();
  try {
    let blocker = null;
    for (const phase of phasesForMode(args.mode)) {
      const runner = runners[phase];
      if (!runner) continue;
      let record;
      // A 413 does not invalidate local CSV rendering, but still blocks remote work.
      if (!canRunPhase(phase, blocker)) {
        record = buildRecord(sampleIndex, phase, 'blocked', {
          detail: `prerequisite=${blocker.phase} failed`,
        });
      } else {
        record = await runner();
        if (record.status !== 'ok') blocker = { phase, status: record.status };
      }
      emittedPhases.add(phase);
      push(record);
    }
  } catch (error) {
    // An infrastructure failure between phases (page closed, CDP error) must still leave
    // one record per promised phase, otherwise a sample looks like it simply did not run.
    const status = classifyError(error);
    for (const phase of phasesForMode(args.mode)) {
      if (emittedPhases.has(phase)) continue;
      push(
        buildRecord(sampleIndex, phase, status, {
          detail: `harness-abort: ${ellipsis(error?.message ?? error)}`,
        }),
      );
    }
  }

  try {
    // Steady marker: only emitted samples, and only when requested. It is written with
    // a synchronous write so root sees it at the idle instant, then the tab is held.
    if (emit && args.steadyMs > 0) {
      const steady = await runSteady(page, crashed, args, sampleIndex);
      push(steady);
      if (!crashed) await holdOpen(args.holdMs);
    }
  } finally {
    await cleanupAllocations(args, net);
    await context.close().catch(() => {});
    if (runtimeErrors.length > 0) {
      process.stderr.write(
        `[perf-browser] sample ${sampleIndex}: ${runtimeErrors.length} browser error(s): ${ellipsis(runtimeErrors[0], 140)}\n`,
      );
    }
  }
  return records;
}

// ── steady + hold ───────────────────────────────────────────────────────────

/**
 * Emit time: no DOM mutation for `steadyMs`. The tab keeps its loaded data; nothing is
 * poked while waiting, so a memory snapshot taken after the marker describes the state
 * the journey produced.
 */
async function runSteady(page, crashed, args, sampleIndex) {
  const phase = 'steady';
  if (crashed) {
    return buildRecord(sampleIndex, phase, 'browser_crash', { detail: 'renderer crashed' });
  }
  try {
    const result = await page.evaluate(
      async ({ steadyMs, timeoutMs }) => {
        return await new Promise((resolve) => {
          let last = performance.now();
          let mutations = 0;
          const observer = new MutationObserver(() => {
            mutations += 1;
            last = performance.now();
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          const deadline = performance.now() + Math.max(timeoutMs, steadyMs + 1_000);
          const tick = () => {
            const current = performance.now();
            if (current - last >= steadyMs) {
              observer.disconnect();
              resolve({ ok: true, start: last, end: current, mutations });
              return;
            }
            if (current > deadline) {
              observer.disconnect();
              resolve({ ok: false, start: last, end: current, mutations });
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { steadyMs: args.steadyMs, timeoutMs: args.timeoutMs },
    );
    return buildRecord(sampleIndex, phase, result.ok ? 'ok' : 'timeout', {
      elapsed_ms: roundMs(result.end - result.start),
      start_ms: roundMs(result.start),
      end_ms: roundMs(result.end),
      detail: `idle_ms=${roundMs(result.end - result.start)} mutations=${result.mutations}`,
    });
  } catch (error) {
    return buildRecord(sampleIndex, phase, classifyError(error), {
      detail: ellipsis(error?.message ?? error),
    });
  }
}

/**
 * Keep the tab open after the steady marker. Released early by a newline on stdin
 * (hold/wake handshake); otherwise the hold window expires. stdin EOF is NOT a wake:
 * a caller that never writes simply gets the full hold window.
 */
async function holdOpen(holdMs) {
  if (!(holdMs > 0)) return;
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
      // A paused pipe may still keep Node alive after the browser has closed.
      process.stdin.unref?.();
      resolve();
    };
    const timer = setTimeout(finish, holdMs);
    const onData = (chunk) => {
      if (String(chunk).includes('\n')) finish();
    };
    const onEnd = () => {
      // No wake channel: keep the tab open for the promised window.
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

// ── Backend cleanup ─────────────────────────────────────────────────────────

async function deleteResource(origin, pathname) {
  try {
    const response = await fetch(origin + pathname, { method: 'DELETE' });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    // 404 means the allocation is already gone (e.g. the app cleaned it up first).
    return {
      ok: response.ok || response.status === 404,
      detail: `${response.status}${body?.code ? ` ${body.code}` : ''}`,
    };
  } catch (error) {
    return { ok: false, detail: ellipsis(error?.message ?? error) };
  }
}

/**
 * Delete every backend allocation this sample created. Nodes go first (children before
 * parents), then uploaded matrices: a matrix owned/read by a node refuses deletion.
 * Failures are reported on stderr; the caller may then need one backend per run.
 */
async function cleanupAllocations(args, net) {
  if (net.nodeIds.size === 0 && net.matrixIds.size === 0) return;
  const origin = new URL(args.url).origin;
  const failures = [];
  const nodeIds = [...net.nodeIds];
  for (const nodeId of [...nodeIds].sort((a, b) => b - a)) {
    const outcome = await deleteResource(origin, `/api/nodes/${nodeId}`);
    if (!outcome.ok) failures.push(`node ${nodeId}: ${outcome.detail}`);
  }
  for (const matrixId of [...net.matrixIds].sort((a, b) => b - a)) {
    const outcome = await deleteResource(origin, `/api/matrices/${matrixId}`);
    if (!outcome.ok) failures.push(`matrix ${matrixId}: ${outcome.detail}`);
  }
  // Verify the node deletions against the backend's own list (matrices have no list endpoint).
  try {
    const response = await fetch(`${origin}/api/nodes`);
    const body = await response.json();
    const live = Array.isArray(body?.nodes) ? body.nodes.map(Number) : [];
    const leftover = nodeIds.filter((id) => live.includes(id));
    if (leftover.length > 0) failures.push(`still live nodes: ${leftover.join(',')}`);
  } catch {
    // A read failure is itself reported by the deletion failures below (if any).
  }
  if (failures.length > 0) {
    process.stderr.write(
      `[perf-browser] cleanup failed (${failures.length}): ${ellipsis(failures.join('; '), 240)}\n` +
        '[perf-browser] use one backend process per invocation if this persists\n',
    );
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function printUsage(stream, message) {
  if (message) stream.write(`${message}\n`);
  stream.write(
    'usage: node web/scripts/perf-browser.mjs --url URL [--file PATH --rows N --cols N]\n' +
      '       [--samples N] [--warmup N] [--timeout-ms N] [--mode import|chart|cold]\n' +
      '       [--steady-ms N] [--hold-ms N] [--missing]\n',
  );
}

function writeMetadata(browserVersion) {
  const line = `${JSON.stringify({ phase: 'metadata', status: 'ok', browser_version: browserVersion })}\n`;
  try {
    fs.writeSync(1, line);
  } catch {
    process.stdout.write(line);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) printUsage(process.stderr, error.message);
      else printUsage(process.stdout);
      return error.message ? 2 : 0;
    }
    throw error;
  }

  async function relaunchBrowser() {
    try {
      return await chromium.launch();
    } catch (error) {
      process.stderr.write(
        `[perf-browser] browser relaunch failed: ${ellipsis(error?.message ?? error)}\n`,
      );
      return null;
    }
  }

  let browser = await relaunchBrowser();
  if (!browser) {
    process.stderr.write(
      '[perf-browser] check PLAYWRIGHT_BROWSERS_PATH (and LD_LIBRARY_PATH/FONTCONFIG_PATH on minimal hosts)\n',
    );
    return 1;
  }

  try {
    writeMetadata(browser.version());
    for (let warmupIndex = 0; warmupIndex < args.warmup; warmupIndex += 1) {
      process.stderr.write(`[perf-browser] warmup ${warmupIndex + 1}/${args.warmup}\n`);
      try {
        const records = await runSample({ sampleIndex: 0, emit: false, browser, args });
        const failed = records.filter((record) => record.status !== 'ok');
        if (failed.length > 0) {
          process.stderr.write(
            `[perf-browser] warmup ${warmupIndex + 1}: ${failed.map((record) => `${record.phase}=${record.status}`).join(' ')}\n`,
          );
        }
      } catch (error) {
        process.stderr.write(
          `[perf-browser] warmup ${warmupIndex + 1} aborted: ${ellipsis(error?.message ?? error)}\n`,
        );
      }
      if (!browser.isConnected()) {
        browser = await relaunchBrowser();
        if (!browser) return 1;
      }
    }
    for (let sample = 1; sample <= args.samples; sample += 1) {
      process.stderr.write(`[perf-browser] sample ${sample}/${args.samples} (${args.mode})\n`);
      try {
        await runSample({ sampleIndex: sample, emit: true, browser, args });
      } catch (error) {
        // A sample that dies before its phase loop (context/page creation) leaves no
        // records; report it on stderr and continue with the remaining samples.
        process.stderr.write(
          `[perf-browser] sample ${sample} aborted: ${ellipsis(error?.message ?? error)}\n`,
        );
      }
      if (!browser.isConnected()) {
        browser = await relaunchBrowser();
        if (!browser) return 1;
      }
    }
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[perf-browser] fatal: ${ellipsis(error?.stack ?? error, 800)}\n`);
      process.exitCode = 1;
    });
}
