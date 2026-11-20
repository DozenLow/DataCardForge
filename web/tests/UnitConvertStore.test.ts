/**
 * Unit-conversion card store (units v1 P2) — `addUnitConvertCard` / `convertUnits`.
 *
 * The dom suite covers what the card RENDERS; this one covers what the STORE guarantees,
 * because those are the rules a second entry point (a key binding, a chain, a restore)
 * would otherwise break silently:
 *
 *   - `addUnitConvertCard` creates exactly the card model the contract locks (one `src`
 *     matrix port, `targets: []`, one declared `result`, an EMPTY display cache, a fresh
 *     node, one dependency edge) and converts nothing;
 *   - `convertUnits` is the only trigger: it pushes the targets, computes once and pulls the
 *     result into the display cache;
 *   - the parameter on the card and the parameter on the wire are the same array, and every
 *     entry carries an explicit `from`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { UNIT_CONVERT_SIGNATURE } from '../src/ui/migrate.ts';
import {
  unitConvertTargets,
  useWorkspace,
  type UnitConvertTarget,
} from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel, MatrixCardModel } from '../src/ui/types.ts';

const store = () => useWorkspace.getState();

function matrix(): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', [100, 250]);
  mat.setColumnAnnotation(0, 'pressure_kpa');
  mat.appendColumn('Pos.2', [2, 3]);
  mat.setColumnAnnotation(1, 'current_a');
  return mat;
}

function encodeFrame(columns: number[][], names: string[]): ArrayBuffer {
  const rows = columns[0]?.length ?? 0;
  const cols = columns.length;
  const namesBytes = new TextEncoder().encode(JSON.stringify(names));
  const buffer = new ArrayBuffer(24 + cols * rows * 8 + namesBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x44434d32, true);
  view.setUint32(4, rows, true);
  view.setUint32(8, cols, true);
  view.setUint32(12, namesBytes.length, true);
  view.setUint32(16, rows, true);
  view.setUint32(20, cols, true);
  let offset = 24;
  for (const column of columns) {
    for (let r = 0; r < rows; ++r) view.setFloat64(offset + r * 8, column[r] ?? NaN, true);
    offset += rows * 8;
  }
  new Uint8Array(buffer, offset, namesBytes.length).set(namesBytes);
  return buffer;
}

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stubBackend() {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 100;
  const resultOf = new Map<number, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith('/api/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    if (url.endsWith('/api/nodes') && method === 'POST') {
      const nodeId = nextNodeId++;
      const resultMatrixId = nextMatrixId++;
      resultOf.set(nodeId, resultMatrixId);
      return json({
        nodeId,
        resultMatrixId,
        resultMatrixIds: [resultMatrixId],
        state: 'dirty',
        reason: 'notRequested',
      });
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'PATCH') return json({ nodeId: Number(nodePath[1]), state: 'dirty' });
    if (nodePath && method === 'GET') {
      return json({ nodeId: Number(nodePath[1]), state: 'done', resultMatrixId: resultOf.get(Number(nodePath[1])) });
    }
    if (url.includes('/window')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          encodeFrame([[1, 2.5], [2000, 3000]], ['Pos.1 pressure_bar', 'Pos.2 current_mA']),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

/** Let every fire-and-forget transport call settle. */
async function settle(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let backend: ReturnType<typeof stubBackend> | null = null;

beforeEach(async () => {
  backend = stubBackend();
  store().reset();
  store().setLocale('zh');
  await settle(2);
  backend.calls.length = 0;
});

afterEach(() => {
  backend?.restore();
  backend = null;
});

/** Register a data card and return it, with its upload already settled. */
async function addDataCard(): Promise<MatrixCardModel> {
  const id = store().addMatrixCard([{ name: 'u.csv', matrix: matrix() }]);
  await settle();
  return store().cards.find((card) => card.id === id) as MatrixCardModel;
}

describe('addUnitConvertCard', () => {
  it('creates the contracted card model and converts nothing', async () => {
    const source = await addDataCard();
    const id = store().addUnitConvertCard(source.id);
    expect(id).not.toBeNull();
    await settle();

    const card = store().cards.find((entry) => entry.id === id) as FunctionCardModel;
    expect(card.kind).toBe('formula');
    expect(card.signatureId).toBe(UNIT_CONVERT_SIGNATURE);
    expect(card.inputs).toHaveLength(1);
    expect(card.inputs[0].portId).toBe('src');
    expect(card.inputs[0].target).toEqual({
      type: 'matrix',
      cardId: source.id,
      matrixId: source.sources[0].matrixId,
    });
    expect(card.outputs).toEqual([{ outputId: 'result', resultMatrixId: expect.any(Number) }]);
    expect(unitConvertTargets(card)).toEqual([]);
    // A fresh display cache: the browser never holds numbers it did not receive.
    expect(store().matrices.get(card.displayMatrixId)?.columnCount() ?? 0).toBe(0);
    // The dependency edge is registered, so close protection and the DAG see it.
    expect(store().dependencies.getDependents(source.id)).toContain(id);
    // The node exists (creation binds) and is NOT computed (explicitCompute).
    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(0);
    const newId = id as number;
    expect(store().unitRuns[newId]?.status ?? 'idle').toBe('idle');
  });

  it('binds an explicit matrix, and refuses one the source does not own', async () => {
    const source = await addDataCard();
    const other = await addDataCard();
    const owned = source.sources[0].matrixId;
    // A matrix id belonging to ANOTHER card is not this card's to capture.
    expect(store().addUnitConvertCard(source.id, other.sources[0].matrixId)).toBeNull();
    // …while an explicit id the source does own is honoured.
    const id = store().addUnitConvertCard(source.id, owned);
    expect(id).not.toBeNull();
    const card = store().cards.find((entry) => entry.id === id) as FunctionCardModel;
    expect(card.inputs[0].target.type === 'matrix' && card.inputs[0].target.matrixId).toBe(owned);
  });
});

describe('convertUnits', () => {
  const TARGETS: UnitConvertTarget[] = [
    { column: 0, from: 'kPa', to: 'bar' },
    { column: 1, from: 'A', to: 'mA' },
  ];

  it('stores the targets, computes once and pulls the result into the display cache', async () => {
    const source = await addDataCard();
    const id = store().addUnitConvertCard(source.id)!;
    await settle();
    backend!.calls.length = 0;

    store().convertUnits(id, TARGETS);
    await settle();

    // The parameter is on the card, in exactly the shape the contract names.
    const card = store().cards.find((entry) => entry.id === id) as FunctionCardModel;
    expect(unitConvertTargets(card)).toEqual(TARGETS);
    // One compute, and the declaration went out with it (a PATCH on the node creation made).
    const compute = backend!.calls.filter((call) => /\/compute$/.test(call.url));
    expect(compute).toHaveLength(1);
    const pushed = backend!.calls[backend!.calls.indexOf(compute[0]) - 1];
    expect(JSON.parse(pushed.body ?? '{}')).toMatchObject({ params: { targets: TARGETS } });

    // The numbers land in the display cache, with the backend's rewritten annotations.
    const result = store().matrices.get(card.displayMatrixId)!;
    expect(result.columnCount()).toBe(2);
    expect(result.columns().map((column) => column.annotation)).toEqual([
      'pressure_bar',
      'current_mA',
    ]);
    // The source table is untouched: a conversion produces a new table.
    expect(store().matrices.get(source.sources[0].matrixId)!.cell(0, 0)).toBe(100);
    expect(store().unitRuns[id]).toMatchObject({ status: 'done', code: null });
  });

  it('does nothing when there is no target (keep-as-is is not an action)', async () => {
    const source = await addDataCard();
    const id = store().addUnitConvertCard(source.id)!;
    await settle();
    backend!.calls.length = 0;

    store().convertUnits(id, []);
    await settle();

    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(0);
    expect(unitConvertTargets(store().cards.find((entry) => entry.id === id) as FunctionCardModel)).toEqual(
      [],
    );
  });

  it('ignores a card that is not a conversion card', async () => {
    const source = await addDataCard();
    store().convertUnits(source.id, TARGETS);
    await settle();
    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(0);
    // A matrix card has no `targets` parameter to store them in.
    expect((store().cards.find((entry) => entry.id === source.id) as MatrixCardModel & { params?: unknown }).params)
      .toBeUndefined();
  });
});

describe('unitConvertTargets', () => {
  it('drops malformed entries instead of forwarding them', () => {
    const card = {
      kind: 'formula',
      signatureId: UNIT_CONVERT_SIGNATURE,
      params: {
        targets: [
          { column: 0, from: 'kPa', to: 'bar' },
          // A hand-edited workspace file can hold anything; none of these is a target.
          { column: 1, to: 'mA' },
          { column: 2, from: '', to: 'bar' },
          { column: 3, from: 'A', to: 5 },
          'nonsense',
        ],
      },
    } as unknown as FunctionCardModel;
    expect(unitConvertTargets(card)).toEqual([{ column: 0, from: 'kPa', to: 'bar' }]);
  });

  it('treats a missing targets parameter as "nothing chosen"', () => {
    const card = { kind: 'formula', signatureId: UNIT_CONVERT_SIGNATURE, params: {} } as unknown as FunctionCardModel;
    expect(unitConvertTargets(card)).toEqual([]);
  });
});