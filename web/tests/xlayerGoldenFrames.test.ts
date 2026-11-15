/**
 * Golden fixtures, LAYER 3/3 (client): the same five cases through the front end's own code.
 *
 * The fixtures under `backend/tests/py/fixtures/` are replayed by three layers and each one
 * judges the seam only it can see (`backend/tests/py/fixtures/README.md`):
 *
 *   1. runner — `backend/tests/py/test_fixtures.py` (ctest `py_fixtures`), byte for byte;
 *   2. node   — `backend/tests/xlayer_fixture_node_test.cpp` (ctest `xlayer_fixture_node`),
 *               the real HTTP surface: upload → create → compute → result;
 *   3. client — THIS file: the front end decodes the input frame with its own frame decoder,
 *               registers it, drives a `builtin:python` card through `BackendClient`, and
 *               compares the frame it receives with `expected/` under the same rule.
 *
 * The comparison rule is the lead's (2026-11-15): magic/rows/cols/totalRows/totalCols equal
 * field by field, the data segment byte for byte, and the names segment semantically —
 * Python's `json.dumps` writes `["Pos.1", "Pos.2"]`, C++ writes `["Pos.1","Pos.2"]`, and
 * both are legal "names UTF-8 JSON array" payloads. The header's namesLen field (bytes
 * 12..16) is therefore the one header field not compared.
 *
 * Layer 3 is why a misread frame cannot hide: the number of rows/columns the CLIENT thinks it
 * read (`decodeMatrixFrame`, column-major) decides what gets uploaded, so a swapped axis or a
 * row-major reading changes the bytes the server computes over and the expected frame stops
 * matching. If this suite is red while layer 2 is green, the seam is in the browser.
 *
 * Opt-in, like `backendIntegration.test.ts`: without `DC_RUN_INTEGRATION=1` the suite is
 * skipped, so CI stays hermetic. Point `DC_BACKEND_URL` at a backend built from this tree
 * (default: the dev instance on 37811). Every node and matrix it creates is deleted
 * afterwards, scoped to itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BackendClient,
  decodeMatrixFrame,
  type MatrixWindow,
  type PortBindingDto,
} from '../src/backend/client.ts';

const enabled = process.env.DC_RUN_INTEGRATION === '1';
const BASE = process.env.DC_BACKEND_URL ?? 'http://127.0.0.1:37811/api';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'backend',
  'tests',
  'py',
  'fixtures',
);

interface PortEntry {
  port: string;
  frame: string;
}

interface Meta {
  script: string;
  outputs: string[];
  timeout_ms?: number;
}

interface ManifestEntry {
  name: string;
  frame: string;
  rows: number;
  cols: number;
}

/** Additive wire field the typed client does not declare (outputs 1..K-1 of a card). */
interface ExtraOutput {
  name: string;
  matrixId: number;
  rows: number;
  cols: number;
}

/**
 * The five case directories, in the order their numeric prefix declares. A checkout without
 * `backend/` (a stand-alone web/ tree) must produce an assertion sentence in the test below,
 * not an exception at import time that takes the whole vitest run down with it.
 */
const cases: string[] = (() => {
  try {
    return readdirSync(FIXTURES)
      .filter((name) => /^\d\d-/.test(name))
      .sort();
  } catch {
    return [];
  }
})();

const EXPECTED_CASES = [
  '01-identity',
  '02-transpose',
  '03-nan-filter',
  '04-int-widen',
  '05-multi-output',
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Buffer -> ArrayBuffer slice: decodeMatrixFrame takes the frame as it arrives on the wire. */
function frameBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Rule B for one pair of frames, as a list of problems (empty = equal). Kept free of
 * `expect` so the rule itself is unit-tested below: a comparison gate that cannot fail is
 * indistinguishable from one that passes.
 */
export function frameDifferences(got: Buffer, expected: Buffer): string[] {
  if (got.length < 24) return [`frame is ${got.length} bytes, shorter than the header`];
  if (expected.length < 24) return [`expected/ frame is ${expected.length} bytes`];
  const problems: string[] = [];
  if (got.readUInt32LE(0) !== 0x44434d32) problems.push('magic is not DCM2');

  // namesLen (bytes 12..16) is exempted by the ruling; these four fields are not.
  const headerFields: Array<[string, number]> = [
    ['rows', 4],
    ['cols', 8],
    ['totalRows', 16],
    ['totalCols', 20],
  ];
  for (const [name, offset] of headerFields) {
    const g = got.readUInt32LE(offset);
    const w = expected.readUInt32LE(offset);
    if (g !== w) problems.push(`header field ${name}: got ${g} want ${w} (offset ${offset})`);
  }
  if (problems.length > 0) return problems;

  const rows = got.readUInt32LE(4);
  const cols = got.readUInt32LE(8);
  const dataLen = rows * cols * 8;
  const namesLen = got.readUInt32LE(12);
  if (got.length !== 24 + dataLen + namesLen) {
    problems.push(`frame is ${got.length} bytes; the header promises ${24 + dataLen + namesLen}`);
    return problems;
  }

  // Data segment: strict bytes, with the FIRST differing offset in the message.
  const gotData = got.subarray(24, 24 + dataLen);
  const wantData = expected.subarray(24, 24 + dataLen);
  let firstDiff = -1;
  for (let i = 0; i < Math.min(gotData.length, wantData.length); i += 1) {
    if (gotData[i] !== wantData[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff >= 0) {
    problems.push(
      `first differing data byte at offset ${24 + firstDiff} ` +
        `(got 0x${gotData[firstDiff].toString(16).padStart(2, '0')} ` +
        `want 0x${wantData[firstDiff].toString(16).padStart(2, '0')})`,
    );
  }

  // Names segment: JSON semantics, not bytes (the exemption). Order and strings must match.
  const wantNamesLen = expected.readUInt32LE(12);
  if (expected.length < 24 + dataLen + wantNamesLen) {
    problems.push('expected/ frame is truncated');
    return problems;
  }
  const gotNames = JSON.parse(got.subarray(24 + dataLen, 24 + dataLen + namesLen).toString('utf8'));
  const wantNames = JSON.parse(
    expected.subarray(24 + dataLen, 24 + dataLen + wantNamesLen).toString('utf8'),
  );
  if (JSON.stringify(gotNames) !== JSON.stringify(wantNames)) {
    problems.push(`names: got ${JSON.stringify(gotNames)} want ${JSON.stringify(wantNames)}`);
  }
  return problems;
}

/** `expect` wrapper around the rule for one client-decoded window. */
function expectFrame(where: string, window: MatrixWindow, expected: Buffer): void {
  expect(window.ok, `${where}: the client rejected the frame (${window.code ?? 'unknown'})`).toBe(
    true,
  );
  const got = Buffer.from(window.buffer as ArrayBuffer);
  const problems = frameDifferences(got, expected);
  expect(problems, `${where}: ${problems.join('; ')}`).toEqual([]);
  const rows = expected.readUInt32LE(4);
  const cols = expected.readUInt32LE(8);
  const namesLen = expected.readUInt32LE(12);
  const expectedNames = JSON.parse(
    expected.subarray(24 + rows * cols * 8, 24 + rows * cols * 8 + namesLen).toString('utf8'),
  ) as string[];
  expect(window.names, `${where}: names as the client parsed them`).toEqual(expectedNames);
  expect(window.rows, `${where}: window rows`).toBe(rows);
  expect(window.columns, `${where}: window columns`).toBe(cols);
}

/** A DCM2 frame, written little-endian like the codec on both sides of the wire. */
function makeFrame(
  rows: number,
  cols: number,
  totalRows: number,
  totalCols: number,
  columnMajor: number[],
  names: string,
): Buffer {
  const namesBytes = Buffer.from(names, 'utf8');
  const out = Buffer.alloc(24 + columnMajor.length * 8 + namesBytes.length);
  out.writeUInt32LE(0x44434d32, 0);
  out.writeUInt32LE(rows, 4);
  out.writeUInt32LE(cols, 8);
  out.writeUInt32LE(namesBytes.length, 12);
  out.writeUInt32LE(totalRows, 16);
  out.writeUInt32LE(totalCols, 20);
  columnMajor.forEach((value, index) => out.writeDoubleLE(value, 24 + index * 8));
  namesBytes.copy(out, 24 + columnMajor.length * 8);
  return out;
}

const client = new BackendClient(BASE);
const createdNodes: number[] = [];
const createdMatrices: number[] = [];

afterAll(async () => {
  if (!enabled) return;
  for (const nodeId of createdNodes) await client.deleteNode(nodeId);
  for (const matrixId of createdMatrices) await client.deleteMatrix(matrixId);
});

describe.skipIf(!enabled)('golden fixtures through the real client', () => {
  for (const name of cases) {
    it(`${name}: upload → compute → the frame the client decodes matches expected/`, async () => {
      const dir = join(FIXTURES, name);
      const ports = readJson<PortEntry[]>(join(dir, 'ports.json'));
      const meta = readJson<Meta>(join(dir, 'meta.json'));
      const manifest = readJson<ManifestEntry[]>(join(dir, 'expected', 'out.manifest.json'));

      // ── upload: the client's own decoder decides what the server receives ──
      const bindings: PortBindingDto[] = [];
      for (const [index, entry] of ports.entries()) {
        const inputBytes = readFileSync(join(dir, entry.frame));
        const decoded = decodeMatrixFrame(frameBuffer(inputBytes));
        expect(
          decoded.ok,
          `${entry.frame}: the client could not decode the input frame (${decoded.code ?? 'unknown'})`,
        ).toBe(true);
        const columns = (decoded.data ?? []).map((column, columnIndex) => ({
          posName: decoded.names?.[columnIndex] ?? `Pos.${columnIndex + 1}`,
          annotation: '',
          data: Array.from(column),
        }));
        const registered = await client.registerMatrix(`${name}/${entry.frame}`, columns);
        expect(registered.ok, `${entry.frame}: registerMatrix failed (${registered.code})`).toBe(
          true,
        );
        const matrixId = registered.matrixId ?? -1;
        expect(matrixId).toBeGreaterThan(0);
        createdMatrices.push(matrixId);
        bindings.push({
          portId: `port${index}`,
          varName: entry.port,
          mode: 'matrix',
          sourceMatrixId: matrixId,
        });
      }

      // ── declare the card from the fixture's own meta.json ──
      const params: Record<string, unknown> = {
        script: meta.script,
        portNames: ports.map((entry) => entry.port),
        outputs: meta.outputs,
      };
      if (typeof meta.timeout_ms === 'number' && meta.timeout_ms > 0) {
        params.timeout_ms = meta.timeout_ms;
      }
      const created = await client.createNode(bindings, {
        signatureId: 'builtin:python',
        params,
      });
      expect(created.ok, `createNode failed (${created.code})`).toBe(true);
      // A script card is lazy: creating it must not run the script.
      expect(created.state).toBe('dirty');
      const nodeId = created.nodeId ?? -1;
      expect(nodeId).toBeGreaterThan(0);
      createdNodes.push(nodeId);

      // ── compute: the one trigger ──
      const computed = await client.computeNode(nodeId);
      expect(computed.ok, `computeNode failed (${computed.code})`).toBe(true);
      expect(computed.state).toBe('done');

      // ── output 0 is the display matrix ──
      const resultMatrixId = computed.resultMatrixIds?.[0] ?? created.resultMatrixId ?? -1;
      expect(resultMatrixId).toBeGreaterThan(0);
      const primary = await client.nodeResult(resultMatrixId);
      expectFrame(
        `${name}: result frame`,
        primary,
        readFileSync(join(dir, 'expected', 'out.dcm2')),
      );

      // The manifest is the runner's own description of the output; entry 0 must agree with
      // the frame the client just decoded, or the two halves describe different matrices.
      expect(primary.rows, `${name}: manifest rows`).toBe(manifest[0]?.rows);
      expect(primary.columns, `${name}: manifest cols`).toBe(manifest[0]?.cols);

      // ── declared extra outputs: extraOutputs entry ↔ expected/out.N.dcm2 ──
      const extras =
        (computed as unknown as { extraOutputs?: ExtraOutput[] }).extraOutputs ?? [];
      expect(extras.length, `${name}: number of extra outputs`).toBe(manifest.length - 1);
      for (const entry of manifest.slice(1)) {
        const extra = extras.find((candidate) => candidate.name === entry.name);
        expect(extra, `${name}: extra output '${entry.name}'`).toBeDefined();
        if (extra === undefined) continue;
        expect(extra.rows, `${name}: extra '${entry.name}' rows`).toBe(entry.rows);
        expect(extra.cols, `${name}: extra '${entry.name}' cols`).toBe(entry.cols);
        const window = await client.window(extra.matrixId, 0, 5000);
        expectFrame(
          `${name}: extra '${entry.name}' frame`,
          window,
          readFileSync(join(dir, 'expected', entry.frame)),
        );
      }
    });
  }
});

// The rule itself, checked on synthetic frames. This runs in the default (hermetic) vitest
// pass, so the comparison logic is gated even on a machine that never starts a backend: the
// integration suite above is opt-in, and an opt-in gate that is never run is not a gate.
describe('frame comparison rule (unit)', () => {
  it('finds the five cases the other two layers replay', () => {
    // A differential gate whose fixture set quietly shrank would still print "ok": the set
    // itself is part of the contract.
    expect(cases, `no cases under ${FIXTURES}`).toEqual(EXPECTED_CASES);
  });

  // Same 2x2 numbers, Python's names spelling (`", "`), C++'s compact spelling, one changed
  // data byte, swapped names, and a changed full-matrix shape.
  const python = makeFrame(2, 2, 2, 2, [1, 2, 3, 4], '["Pos.1", "Pos.2"]');
  const compact = makeFrame(2, 2, 2, 2, [1, 2, 3, 4], '["Pos.1","Pos.2"]');
  const flipped = makeFrame(2, 2, 2, 2, [1, 2, 3, 5], '["Pos.1", "Pos.2"]');
  const reordered = makeFrame(2, 2, 2, 2, [1, 2, 3, 4], '["Pos.2", "Pos.1"]');
  const reshaped = makeFrame(2, 2, 3, 2, [1, 2, 3, 4], '["Pos.1", "Pos.2"]');

  it('accepts identical frames and the two legal names spellings', () => {
    expect(frameDifferences(python, python)).toEqual([]);
    expect(frameDifferences(compact, python)).toEqual([]);
  });

  it('reports the first differing data byte OFFSET', () => {
    const problems = frameDifferences(flipped, python);
    expect(problems).toHaveLength(1);
    // 4.0 and 5.0 differ in the 7th byte of the 4th (last) double: 24 + 3*8 + 6.
    expect(problems[0]).toContain('first differing data byte at offset 54');
  });

  it('rejects a swapped names array and a changed shape', () => {
    expect(frameDifferences(reordered, python)).toEqual([
      'names: got ["Pos.2","Pos.1"] want ["Pos.1","Pos.2"]',
    ]);
    expect(frameDifferences(reshaped, python)).toEqual([
      'header field totalRows: got 3 want 2 (offset 16)',
    ]);
  });

  it('rejects a truncated frame instead of comparing past its end', () => {
    expect(frameDifferences(python.subarray(0, 30), python)[0]).toContain('header promises');
  });

  it('decodes the fixture frames with the real client decoder', () => {
    // The export path also proves decodeMatrixFrame is part of this layer, not the mock.
    for (const name of cases) {
      const expected = readFileSync(join(FIXTURES, name, 'expected', 'out.dcm2'));
      const decoded = decodeMatrixFrame(frameBuffer(expected));
      expect(decoded.ok, `${name}: expected/out.dcm2`).toBe(true);
      const rows = expected.readUInt32LE(4);
      const cols = expected.readUInt32LE(8);
      expect(decoded.rows).toBe(rows);
      expect(decoded.columns).toBe(cols);
      expect(frameDifferences(Buffer.from(decoded.buffer as ArrayBuffer), expected)).toEqual([]);
    }
  });
});
