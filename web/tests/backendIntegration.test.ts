/**
 * Live integration: the REAL `BackendClient` against the REAL compute backend.
 *
 * Opt-in, like the backend's fuzz/stress gates: without `DC_RUN_INTEGRATION=1` the suite is
 * skipped so CI stays fast and hermetic. With it, this exercises the pieces the unit tests
 * deliberately stub out — DCM1 framing, HTTP status mapping, structured error bodies, and
 * the v2 signature round-trip (portId → K outputs → column contract).
 *
 * Run against an isolated backend via `DC_BACKEND_URL`. Fixtures track the matrix/node IDs
 * they create for cleanup.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { BackendClient, decodeMatrixFrame } from '../src/backend/client.ts';
import { client as parseClient, disposeParseWorker } from '../src/loaders/parseWorker.ts';
import { migrateWorkspace } from '../src/ui/migrate.ts';

const enabled = process.env.DC_RUN_INTEGRATION === '1';
const BASE = process.env.DC_BACKEND_URL ?? 'http://127.0.0.1:37811/api';

const client = new BackendClient(BASE);
const createdNodes: number[] = [];
const createdMatrices: number[] = [];

afterAll(async () => {
  for (const nodeId of createdNodes) await client.deleteNode(nodeId);
  for (const matrixId of createdMatrices) await client.deleteMatrix(matrixId);
});

describe.skipIf(!enabled)('live backend integration', () => {
  it('handshakes with protocol 1 and advertises the v2 capabilities', async () => {
    const hello = await client.hello();
    expect(hello.ok).toBe(true);
    expect(hello.protocol).toBe(1);
    expect(hello.maxWindowRows).toBeGreaterThan(0);
    // Additive fields are not self-announcing: a client that needs signatures must be able
    // to refuse a backend that would silently ignore `signatureId`.
    expect(hello.capabilities).toContain('signature.v1');
    expect(hello.capabilities).toContain('card.v2');
  });

  it('lists the function signatures it can evaluate', async () => {
    const signatures = await client.signatures();
    const expressionColumns = signatures.find((s) => s.id === 'builtin:expression-columns');
    expect(expressionColumns).toBeDefined();
    expect(expressionColumns!.version).toBe(1);
    expect(expressionColumns!.inputs.map((input) => input.portId)).toEqual(['src']);
    expect(expressionColumns!.outputs.map((output) => output.outputId)).toEqual(['result']);
  });

  it('checks a script through the compile-only endpoint: lint, syntax, no execution', async () => {
    // The same three verdicts the backend's own gate covers, seen from the client: this is
    // the seam the editor's authoritative layer actually calls.
    const clean = await client.checkScript('result = 1\n');
    expect(clean).toEqual({ ok: true, impure: [] });

    const impure = await client.checkScript('import socket\nvalue = socket.gethostname()\n');
    expect(impure.ok).toBe(true);
    expect(impure.impure.some((item) => item.includes('socket'))).toBe(true);

    const broken = await client.checkScript('def f(:\n    pass\n');
    expect(broken.ok).toBe(false);
    expect(broken.error?.code).toBe('syntaxError');
    expect(broken.error?.line).toBe(1);
    expect(broken.error?.col).toBeGreaterThan(0);
  });

  it('registers a table and reads it back through a DCM1 window', async () => {
    const registered = await client.registerMatrix('it-source', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3] },
      { posName: 'Pos.2', annotation: 'B', data: [10, 20, 30] },
    ]);
    expect(registered.ok).toBe(true);
    createdMatrices.push(registered.matrixId!);

    const frame = await client.window(registered.matrixId!, 0, 10);
    expect(frame.ok).toBe(true);
    expect(frame.rows).toBe(3);
    expect(frame.columns).toBe(2);
    expect(frame.names).toEqual(['Pos.1 A', 'Pos.2 B']);
    expect(Array.from(frame.data![1])).toEqual([10, 20, 30]);
  });

  it('rejects a mixed-validity cell PATCH without changing data, revision, or downstream state', async () => {
    const source = await client.registerMatrix('it-atomic-patch', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3] },
    ]);
    expect(source.ok).toBe(true);
    const matrixId = source.matrixId!;
    createdMatrices.push(matrixId);
    expect(source.revision).toBe(1);

    const node = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: matrixId }],
      { signatureId: 'builtin:summary', params: {} },
    );
    expect(node.ok).toBe(true);
    const nodeId = node.nodeId!;
    createdNodes.push(nodeId);
    expect(await client.computeNode(nodeId)).toMatchObject({ ok: true, state: 'done' });

    // Use raw HTTP here: BackendClient.patchCells intentionally discards status and revision.
    const patch = (cells: Array<{ row: number; col: number; value: number }>) => fetch(`${BASE}/matrices/${matrixId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cells }),
    });
    const edit = { row: 0, col: 0, value: 100 };
    const rejected = await patch([edit, { row: 3, col: 0, value: 200 }]);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'shapeMismatch' });

    const unchanged = await client.window(matrixId, 0, 3);
    expect(unchanged.ok).toBe(true);
    expect(Array.from(unchanged.data![0])).toEqual([1, 2, 3]);
    expect(await client.getNode(nodeId)).toMatchObject({ state: 'done' });

    const accepted = await patch([edit]);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ matrixId, revision: source.revision! + 1 });
  });

  describe('matrix DELETE', () => {
    async function registerSource() {
      const registered = await client.registerMatrix('it-delete', [
        { posName: 'Pos.1', annotation: 'A', data: [2, 4] },
      ]);
      expect(registered.ok).toBe(true);
      const matrixId = registered.matrixId!;
      createdMatrices.push(matrixId);
      return matrixId;
    }

    async function createReader(matrixId: number) {
      const created = await client.createNode(
        [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: matrixId }],
        {
          signatureId: 'builtin:expression-columns',
          params: { formulas: [{ name: 'double', expression: 'A * 2' }] },
        },
      );
      expect(created.ok).toBe(true);
      const nodeId = created.nodeId!;
      createdNodes.push(nodeId);
      expect(created.state).toBe('done');
      expect(created.resultMatrixIds).toHaveLength(1);
      return { nodeId, outputId: created.resultMatrixIds![0] };
    }

    // BackendClient.deleteMatrix intentionally drops the HTTP status and params.
    const deleteMatrix = (id: number) => fetch(`${BASE}/matrices/${id}`, { method: 'DELETE' });

    it('deletes an orphan and returns 404 with the same id when it is now missing', async () => {
      const matrixId = await registerSource();
      const deleted = await deleteMatrix(matrixId);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: matrixId });
      expect(await client.window(matrixId, 0, 10)).toMatchObject({ ok: false, code: 'unknownMatrix' });

      const missing = await deleteMatrix(matrixId);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ code: 'unknownMatrix', params: { matrixId } });
    });

    it('refuses to delete an owned result even when no node reads it', async () => {
      const sourceId = await registerSource();
      const { nodeId, outputId } = await createReader(sourceId);
      const owned = await deleteMatrix(outputId);
      expect(owned.status).toBe(409);
      expect(await owned.json()).toEqual({ code: 'hasDependents', params: { matrixId: outputId } });

      const frame = await client.window(outputId, 0, 10);
      expect(frame.ok).toBe(true);
      expect(Array.from(frame.data![0])).toEqual([4, 8]);
      expect(await client.getNode(nodeId)).toMatchObject({ state: 'done', resultMatrixId: outputId });
    });

    it('refuses to delete a referenced source until its reader is removed', async () => {
      const matrixId = await registerSource();
      const { nodeId } = await createReader(matrixId);
      const referenced = await deleteMatrix(matrixId);
      expect(referenced.status).toBe(409);
      expect(await referenced.json()).toEqual({ code: 'hasDependents', params: { matrixId } });

      const frame = await client.window(matrixId, 0, 10);
      expect(frame.ok).toBe(true);
      expect(Array.from(frame.data![0])).toEqual([2, 4]);
      expect(await client.getNode(nodeId)).toMatchObject({ state: 'done' });

      expect(await client.deleteNode(nodeId)).toMatchObject({ ok: true });
      const deleted = await deleteMatrix(matrixId);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: matrixId });
    });
  });

  it('creates a signature node with ONE output holding a wide table', async () => {
    const registered = await client.registerMatrix('it-signature', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3] },
      { posName: 'Pos.2', annotation: 'B', data: [10, 20, 30] },
    ]);
    createdMatrices.push(registered.matrixId!);

    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: {
          formulas: [
            { name: 'double', expression: 'A * 2' },
            { name: 'sum', expression: 'A + B' },
          ],
        },
      },
    );
    expect(created.ok).toBe(true);
    createdNodes.push(created.nodeId!);
    expect(created.signatureId).toBe('builtin:expression-columns');
    expect(created.state).toBe('done');
    // K is fixed by the signature: one output, whatever its width.
    expect(created.resultMatrixIds).toHaveLength(1);

    const result = await client.nodeResult(created.resultMatrixIds![0]);
    expect(result.ok).toBe(true);
    expect(result.columns).toBe(2);
    expect(result.names).toEqual(['Pos.1 double', 'Pos.2 sum']);
    expect(Array.from(result.data![0])).toEqual([2, 4, 6]);
    expect(Array.from(result.data![1])).toEqual([11, 22, 33]);
  });

  it('round-trips params edits: one PATCH recomputes the whole card', async () => {
    const registered = await client.registerMatrix('it-params', [
      { posName: 'Pos.1', annotation: 'A', data: [2, 4] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: { formulas: [{ name: 'a', expression: 'A' }] },
      },
    );
    createdNodes.push(created.nodeId!);
    createdMatrices.push(created.resultMatrixIds![0]);

    const patched = await client.patchNode(created.nodeId!, {
      params: { formulas: [{ name: 'square', expression: 'A * A' }] },
    });
    expect(patched.ok).toBe(true);
    const result = await client.nodeResult(created.resultMatrixIds![0]);
    expect(Array.from(result.data![0])).toEqual([4, 16]);
    expect(result.names).toEqual(['Pos.1 square']);
  });

  it('stops the flow with a structured error when the column contract is broken', async () => {
    const registered = await client.registerMatrix('it-contract', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: {
          formulas: [{ name: 'a', expression: 'A' }],
          columnContract: { outputId: 'result', columns: 1 },
        },
      },
    );
    createdNodes.push(created.nodeId!);
    createdMatrices.push(created.resultMatrixIds![0]);

    // One more expression than the contract promised ⇒ the node must refuse to publish.
    await client.patchNode(created.nodeId!, {
      params: {
        formulas: [
          { name: 'a', expression: 'A' },
          { name: 'b', expression: 'A * 2' },
        ],
        columnContract: { outputId: 'result', columns: 1 },
      },
    });
    const status = await client.getNode(created.nodeId!);
    expect(status?.state).toBe('error');
    expect(status?.code).toBe('columnContractViolation');
    expect(status?.params).toEqual({ expected: 1, actual: 2 });

    // …and the old numbers are gone, so nothing downstream can read stale values.
    const cleared = await client.nodeResult(created.resultMatrixIds![0]);
    expect(cleared.ok).toBe(true);
    expect(cleared.columns).toBe(0);
  });

  it('evaluates a regression card bound to two columns of ONE table', async () => {
    const registered = await client.registerMatrix('it-regression', [
      { posName: 'Pos.1', annotation: 'X', data: [1, 2, 3, 4] },
      { posName: 'Pos.2', annotation: 'Y', data: [2, 4, 6, 8] },
    ]);
    createdMatrices.push(registered.matrixId!);

    // Exactly what the store sends for a regression card: two cell ports, one column each,
    // both pointing at the same table.
    const created = await client.createNode(
      [
        {
          portId: 'x',
          varName: 'x',
          mode: 'cell',
          sourceMatrixId: registered.matrixId!,
          columnIndex: 0,
        },
        {
          portId: 'y',
          varName: 'y',
          mode: 'cell',
          sourceMatrixId: registered.matrixId!,
          columnIndex: 1,
        },
      ],
      { signatureId: 'builtin:linear-regression', params: {} },
    );
    expect(created.ok).toBe(true);
    createdNodes.push(created.nodeId!);
    createdMatrices.push(created.resultMatrixIds![0]);

    const result = await client.nodeResult(created.resultMatrixIds![0]);
    // The output's shape is fixed by the signature: one row, five named statistics.
    expect(result.rows).toBe(1);
    expect(result.names).toEqual([
      'Pos.1 slope',
      'Pos.2 intercept',
      'Pos.3 r',
      'Pos.4 r2',
      'Pos.5 n',
    ]);
    // One row × five columns: the row index is constant, the columns carry the statistics.
    const values = result.data!.map((column) => column[0]);
    expect(values[0]).toBeCloseTo(2, 12);
    expect(values[1]).toBeCloseTo(0, 12);
    expect(values[2]).toBeCloseTo(1, 12);
    expect(values[4]).toBe(4);
  });

  it('refuses a port the signature does not declare', async () => {
    const registered = await client.registerMatrix('it-port', [
      { posName: 'Pos.1', annotation: 'A', data: [1] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'nope', varName: 'nope', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      { signatureId: 'builtin:expression-columns', params: { formulas: [] } },
    );
    expect(created.ok).toBe(false);
    expect(created.code).toBe('unknownPort');
  });

  it('rejects an unknown signature with a structured refusal', async () => {
    const registered = await client.registerMatrix('it-unknown', [
      { posName: 'Pos.1', annotation: 'A', data: [1] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      { signatureId: 'builtin:does-not-exist', params: {} },
    );
    expect(created.ok).toBe(false);
    expect(created.code).toBe('unknownSignature');
  });

  it('migrates a v1 snapshot that mentions a real matrix id', () => {
    const registered = migrateWorkspace({
      version: 1,
      savedAt: '2026-10-01T00:00:00.000Z',
      cards: [
        {
          kind: 'matrix',
          id: 1,
          title: '',
          x: 0,
          y: 0,
          width: 640,
          height: 420,
          z: 1,
          createdAt: 1,
          sources: [{ name: 'a.txt', matrixId: 10 }],
          activeSource: 0,
          readOnly: true,
        },
      ],
      matrices: [{ id: 10, name: 'a.txt', columns: [] }],
      nextCardId: 2,
      nextMatrixId: 11,
    });
    expect(registered.version).toBe(2);
    expect(registered.cards).toHaveLength(1);
    expect(registered.cards[0].inputs).toEqual([]);
  });

  describe('summary filters', () => {
    async function createSummary(columns: string[]) {
      const registered = await client.registerMatrix('it-summary-filter', [
        { posName: 'Pos.1', annotation: 'Air Temp', data: [2, 4, 6] },
        { posName: 'Pos.2', annotation: 'Humidity', data: [50, 70, 90] },
        { posName: 'Pos.3', annotation: '', data: [10, 20, 30] },
      ]);
      expect(registered.ok).toBe(true);
      const matrixId = registered.matrixId!;
      createdMatrices.push(matrixId);
      const created = await client.createNode(
        [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: matrixId }],
        { signatureId: 'builtin:summary', params: { columns, stats: ['MAX', 'mean', 'max'] } },
      );
      expect(created.ok).toBe(true);
      const nodeId = created.nodeId!;
      createdNodes.push(nodeId);
      expect(created.state).toBe('dirty');
      expect(created.resultMatrixIds).toHaveLength(1);
      return { nodeId, resultId: created.resultMatrixIds![0] };
    }

    it('matches annotation or unannotated posName case-insensitively and keeps source order without duplicates', async () => {
      const { nodeId, resultId } = await createSummary(['POS.3', 'air temp', 'pos.3', 'AIR TEMP']);
      expect(await client.computeNode(nodeId)).toMatchObject({
        ok: true, state: 'done', resultMatrixIds: [resultId],
      });

      const frame = await client.window(resultId, 0, 10);
      expect(frame).toMatchObject({ ok: true, rows: 2, columns: 2, names: ['Pos.1 Air Temp', 'Pos.3'] });
      // Catalogue order is mean then max, not the order of the stats filter.
      expect(frame.data?.map((column) => Array.from(column))).toEqual([[4, 6], [20, 30]]);
    });

    it.each(['MiSsInG', 'pOs.1', ''])('rejects unknown column %j with its original name', async (name) => {
      // A valid filter first rules out silently dropping just the unknown entry.
      // Pos.1 is not an alias for an annotated column; posName only names headerless columns.
      const { nodeId, resultId } = await createSummary(['AIR TEMP', name]);
      const computed = await fetch(`${BASE}/nodes/${nodeId}/compute`, { method: 'POST' });
      expect(computed.status).toBe(200);
      const diagnostic = { state: 'error', code: 'unknownColumn', params: { name } };
      expect(await computed.json()).toMatchObject({ nodeId, ...diagnostic });
      expect(await client.getNode(nodeId)).toMatchObject(diagnostic);
      expect(await client.window(resultId, 0, 10)).toMatchObject({ ok: true, rows: 0, columns: 0 });
    });
  });

  describe('summary (lazy signature)', () => {
    let sourceMatrixId = 0;
    let nodeId = 0;
    let resultMatrixId = 0;

    it('does not compute on creation: dirty, notRequested, empty result matrix', async () => {
      const registered = await client.registerMatrix('it-summary', [
        { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3, 4] },
        { posName: 'Pos.2', annotation: 'B', data: [10, 20, 30, 40] },
      ]);
      expect(registered.ok).toBe(true);
      sourceMatrixId = registered.matrixId!;
      createdMatrices.push(sourceMatrixId);

      const created = await client.createNode(
        [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: sourceMatrixId }],
        { signatureId: 'builtin:summary', params: {} },
      );
      expect(created.ok).toBe(true);
      nodeId = created.nodeId!;
      createdNodes.push(nodeId);
      expect(created.state).toBe('dirty');
      expect(created.reason).toBe('notRequested');
      expect(created.resultMatrixIds).toHaveLength(1);
      resultMatrixId = created.resultMatrixIds![0];
      createdMatrices.push(resultMatrixId);

      // The result matrix exists but is empty: 0 columns, no stale numbers.
      const frame = await client.window(resultMatrixId, 0, 10);
      expect(frame.ok).toBe(true);
      expect(frame.columns).toBe(0);
    });

    it('computes on explicit trigger: 12 statistics rows × input variable columns', async () => {
      const triggered = await client.computeNode(nodeId);
      expect(triggered.ok).toBe(true);
      expect(triggered.state).toBe('done');
      expect(triggered.resultMatrixIds).toEqual([resultMatrixId]);

      const status = await client.getNode(nodeId);
      expect(status?.state).toBe('done');

      const frame = await client.window(resultMatrixId, 0, 20);
      expect(frame.ok).toBe(true);
      expect(frame.rows).toBe(12);
      expect(frame.columns).toBe(2);
      expect(frame.names).toEqual(['Pos.1 A', 'Pos.2 B']);

      // Rows are the fixed 12 statistics (n, nan, mean, sd, var, min, q1, median, q3,
      // max, iqr, sem); columns are the input variables; data is column-major.
      const a = frame.data![0];
      const b = frame.data![1];
      expect(a[0]).toBe(4); // n
      expect(a[1]).toBe(0); // nan
      expect(a[2]).toBeCloseTo(2.5, 9); // mean
      expect(a[3]).toBeCloseTo(1.2909944487358056, 9); // sd
      expect(a[4]).toBeCloseTo(1.6666666666666667, 9); // var
      expect(a[5]).toBe(1); // min
      expect(a[6]).toBeCloseTo(1.75, 9); // q1
      expect(a[7]).toBeCloseTo(2.5, 9); // median
      expect(a[8]).toBeCloseTo(3.25, 9); // q3
      expect(a[9]).toBe(4); // max
      expect(a[10]).toBeCloseTo(1.5, 9); // iqr
      expect(a[11]).toBeCloseTo(0.6454972243679028, 9); // sem
      expect(b[0]).toBe(4); // n
      expect(b[1]).toBe(0); // nan
      expect(b[2]).toBe(25); // mean
      expect(b[3]).toBeCloseTo(12.909944487358056, 9); // sd
      expect(b[4]).toBeCloseTo(166.66666666666666, 9); // var
      expect(b[5]).toBe(10); // min
      expect(b[6]).toBeCloseTo(17.5, 9); // q1
      expect(b[7]).toBe(25); // median
      expect(b[8]).toBeCloseTo(32.5, 9); // q3
      expect(b[9]).toBe(40); // max
      expect(b[10]).toBe(15); // iqr
      expect(b[11]).toBeCloseTo(6.454972243679028, 9); // sem
    });

    it('goes dirty with reason upstreamChanged and clears the result when the upstream matrix changes', async () => {
      const patched = await client.patchCells(sourceMatrixId, [{ row: 0, col: 0, value: 100 }]);
      expect(patched.ok).toBe(true);

      const status = await client.getNode(nodeId);
      expect(status?.state).toBe('dirty');
      expect(status?.reason).toBe('upstreamChanged');

      // Never silently serve the old matrix: 0 columns.
      const frame = await client.window(resultMatrixId, 0, 20);
      expect(frame.ok).toBe(true);
      expect(frame.columns).toBe(0);
    });

    it('computes again and picks up the changed upstream values', async () => {
      const triggered = await client.computeNode(nodeId);
      expect(triggered.ok).toBe(true);
      expect(triggered.state).toBe('done');

      const frame = await client.window(resultMatrixId, 0, 20);
      expect(frame.ok).toBe(true);
      const a = frame.data![0];
      expect(a[0]).toBe(4); // n
      expect(a[2]).toBeCloseTo(27.25, 9); // mean = (100+2+3+4)/4
      expect(a[5]).toBe(2); // min
      expect(a[9]).toBe(100); // max
    });
  });
});

// ── Hermetic regressions ──────────────────────────────────────────────────────────────
// These never touch the live backend, so they sit OUTSIDE the opt-in `describe.skipIf`
// above and run on every CI pass (a regression that only runs with DC_RUN_INTEGRATION=1
// would not protect anything).

describe('decodeMatrixFrame — short DCM2 header (bug #13)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A DCM2 frame truncated to `bytes`: magic + rows/cols/namesLen, no totalRows/totalCols. */
  function shortDcm2(bytes: number): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes);
    const view = new DataView(buffer);
    view.setUint32(0, 0x44434d32, true); // 'DCM2'
    view.setUint32(4, 0, true); // rows
    view.setUint32(8, 0, true); // cols
    view.setUint32(12, 0, true); // namesLen
    return buffer;
  }

  it('returns badFrame for a 16-byte DCM2 frame instead of throwing RangeError', () => {
    expect(decodeMatrixFrame(shortDcm2(16))).toEqual({ ok: false, code: 'badFrame' });
  });

  it('returns badFrame for a 23-byte DCM2 frame (one byte short of the V2 header)', () => {
    expect(decodeMatrixFrame(shortDcm2(23))).toEqual({ ok: false, code: 'badFrame' });
  });

  it('window() reports badFrame, not backendUnavailable, for a short DCM2 body', async () => {
    const body = shortDcm2(16);
    globalThis.fetch = (async () =>
      ({ ok: true, arrayBuffer: async () => body }) as unknown as Response) as typeof fetch;
    const frame = await new BackendClient('http://backend.test/api').window(1, 0, 10);
    expect(frame).toEqual({ ok: false, code: 'badFrame' });
  });

  it('still decodes a complete DCM2 frame (24-byte header + payload)', () => {
    const buffer = new ArrayBuffer(24 + 8);
    const view = new DataView(buffer);
    view.setUint32(0, 0x44434d32, true);
    view.setUint32(4, 1, true); // rows
    view.setUint32(8, 1, true); // cols
    view.setUint32(12, 0, true); // namesLen
    view.setUint32(16, 1, true); // totalRows
    view.setUint32(20, 1, true); // totalCols
    view.setFloat64(24, 7, true);
    const frame = decodeMatrixFrame(buffer);
    expect(frame.ok).toBe(true);
    expect(frame.totalRows).toBe(1);
    expect(frame.totalCols).toBe(1);
    expect(Array.from(frame.data![0])).toEqual([7]);
  });
});

describe('parseWorker — pending cleanup when postMessage throws (bug #17)', () => {
  /** A Worker whose postMessage always throws, like a DataCloneError on an uncloneable File. */
  class ThrowingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    postMessage(): void {
      throw new DOMException('The object could not be cloned.', 'DataCloneError');
    }
    terminate(): void {}
  }

  afterEach(() => {
    disposeParseWorker();
    vi.unstubAllGlobals();
  });

  it('rejects the parse and removes the pending entry (no File leak)', async () => {
    disposeParseWorker(); // start from a clean singleton
    // ensure() takes the worker path only when both a Worker global and self.postMessage exist.
    vi.stubGlobal('self', { postMessage: () => {} });
    vi.stubGlobal('Worker', ThrowingWorker);

    const pending = (parseClient as unknown as { pending: Map<number, unknown> }).pending;
    const file = new File(['1 2\n3 4\n'], 'a.txt', { type: 'text/plain' });

    await expect(parseClient.parse('a.txt', file)).rejects.toThrow('could not be cloned');
    // Before the fix the executor threw (rejecting the promise) but the entry stayed forever.
    expect(pending.size).toBe(0);
  });
});
