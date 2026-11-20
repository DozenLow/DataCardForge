/**
 * Units L2a at the STORE layer (docs/tasks/2026-11-19-units-l2.md §L2a).
 *
 * Inheritance is derived metadata, and every contract here is about keeping it that way:
 *
 *   1. **Recomputed on every pull.** The derivation is read from `params.formulas[i].expression`
 *      plus the SOURCE table's resolutions, and written under the RESULT table's signature —
 *      so a new expression (or a new source unit) re-derives, and an old derivation can never
 *      survive under a key that means something else.
 *   2. **Session-only and separate.** It lives in `inheritedUnits`, never in
 *      `unitConfirmations` and never in a snapshot; a restore starts empty, so a nested
 *      workspace can never inherit another workspace's derivation.
 *   3. **Below the user.** `unitResolutionContext` carries it, and the chain gives a user
 *      confirmation/assertion priority over it — asserted wins, inherited beats preconfirm.
 *
 * The backend is stubbed like the other store suites (transport must never reach the network).
 * `globalSettings` supplies the global pre-confirmation layer through `localStorage`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { columnUnitResolutions, unitSignature } from '../src/core/units.ts';
import { resetGlobalSettingsCache, setGlobalSettings } from '../src/ui/globalSettings.ts';
import { unitResolutionContext, useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel, MatrixCardModel } from '../src/ui/types.ts';

const store = () => useWorkspace.getState();

function matrix(annotations: string[], rows = 3): MatrixData {
  const mat = new MatrixData();
  annotations.forEach((annotation, index) => {
    mat.appendColumn(`Pos.${index + 1}`, Array.from({ length: rows }, (_, r) => r + index));
    mat.setColumnAnnotation(index, annotation);
  });
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

/**
 * Stub transport. Two knobs matter here: `setResult` describes the table the next window
 * read returns (the RESULT table the derivation is keyed to), and `setPatchState` decides
 * whether a push leaves the node done or dirty (which must clear the derivation).
 */
function stubBackend() {
  let nextNodeId = 1;
  let nextMatrixId = 700;
  const resultOf = new Map<number, number>();
  const frame: { names: string[]; columns: number[][] } = {
    names: ['Pos.1 Col1'],
    columns: [[1, 2, 3]],
  };
  const state: { patchState: string } = { patchState: 'done' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    if (url.endsWith('/api/nodes') && method === 'POST') {
      const nodeId = nextNodeId++;
      const resultMatrixId = nextMatrixId++;
      resultOf.set(nodeId, resultMatrixId);
      return json({ nodeId, resultMatrixId, resultMatrixIds: [resultMatrixId], state: 'done' });
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'PATCH') {
      return json({ nodeId: Number(nodePath[1]), state: state.patchState });
    }
    if (nodePath && method === 'GET') {
      return json({
        nodeId: Number(nodePath[1]),
        state: 'done',
        resultMatrixId: resultOf.get(Number(nodePath[1])),
      });
    }
    if (url.includes('/window')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => encodeFrame(frame.columns, frame.names),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return {
    setResult(columns: number[][], names: string[]) {
      frame.columns = columns;
      frame.names = names;
    },
    setPatchState(next: string) {
      state.patchState = next;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function settle(rounds = 24): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let backend: ReturnType<typeof stubBackend> | null = null;

beforeEach(async () => {
  localStorage.clear();
  resetGlobalSettingsCache();
  backend = stubBackend();
  store().reset();
  store().setLocale('zh');
  await settle(2);
});

afterEach(() => {
  backend?.restore();
  backend = null;
  localStorage.clear();
  resetGlobalSettingsCache();
});

function liveCard(cardId: number): FunctionCardModel {
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

/** Result-table signature of a formula card, derived the same way the store derives it. */
function resultSignature(cardId: number): string {
  const card = liveCard(cardId);
  const result = store().matrices.get(card.displayMatrixId)!;
  return unitSignature(result.columns().map((column) => column.annotation));
}

/** Set one formula row's expression and name, then let the backend answer. */
async function setExpression(cardId: number, index: number, name: string, expression: string) {
  store().setFormula(cardId, index, name, expression);
  await settle();
}

/** Create a data card, then a formula card reading it; every upload is settled. */
async function addFormulaCard(
  sourceAnnotations: string[] = ['pressure_kpa', 'flow_lpm'],
): Promise<{ source: MatrixCardModel; card: FunctionCardModel }> {
  const sourceId = store().addMatrixCard([{ name: 'in.csv', matrix: matrix(sourceAnnotations) }]);
  await settle();
  const source = store().cards.find((entry) => entry.id === sourceId) as MatrixCardModel;
  const cardId = store().addFormulaCard(source.id);
  expect(cardId).not.toBeNull();
  await settle();
  return { source, card: liveCard(cardId!) };
}

// ── 1. derivation on pull ─────────────────────────────────────────────────────────

describe('the derivation is written when a result is pulled', () => {
  it('a preserving expression inherits the source column unit (表头无名也算)', async () => {
    // The backend names the result column `Col1`, which names no unit at all.
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');

    const signature = resultSignature(card.id);
    expect(store().inheritedUnits[signature]).toEqual({ 0: 'kPa' });
    // …and it is NOT in the user's memory.
    expect(store().unitConfirmations[signature]).toBeUndefined();
  });

  it('a non-preserving expression inherits nothing', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'SQRT(pressure_kpa)');
    expect(store().inheritedUnits[resultSignature(card.id)]).toBeUndefined();
  });

  it('a two-column expression inherits nothing', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * flow_lpm');
    expect(store().inheritedUnits[resultSignature(card.id)]).toBeUndefined();
  });

  it('per-column: two rows derive independently', async () => {
    backend!.setResult(
      [
        [2, 4, 6],
        [1, 2, 3],
        [9, 9, 9],
      ],
      ['Pos.1 A', 'Pos.2 B', 'Pos.3 C'],
    );
    const { card } = await addFormulaCard();
    // Row 0 preserves, row 1 does not (COUNT is dimensionless), row 2 is a literal.
    store().setFormula(card.id, 0, 'A', 'pressure_kpa * 2');
    store().setFormula(card.id, 1, 'B', 'COUNT(pressure_kpa)');
    store().setFormula(card.id, 2, 'C', '7');
    await settle();

    expect(store().inheritedUnits[resultSignature(card.id)]).toEqual({ 0: 'kPa' });
  });
});

// ── 2. recomputation ──────────────────────────────────────────────────────────────

describe('the derivation re-derives', () => {
  it('changing the expression re-derives on the next pull', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    expect(store().inheritedUnits[resultSignature(card.id)]).toEqual({ 0: 'kPa' });

    // Same shape, different source column: the derivation follows the source.
    await setExpression(card.id, 0, 'Col1', 'flow_lpm / 2');
    expect(store().inheritedUnits[resultSignature(card.id)]).toEqual({ 0: 'L/min' });

    // No longer preserving: the entry goes away instead of going stale.
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * flow_lpm');
    expect(store().inheritedUnits[resultSignature(card.id)]).toBeUndefined();
  });

  it('a user assertion in the source table flows into the derived unit', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const sourceId = store().addMatrixCard([{ name: 'in.csv', matrix: matrix(['wind_ms']) }]);
    await settle();
    const cardId = store().addFormulaCard(sourceId);
    await settle();
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    await setExpression(cardId!, 0, 'Col1', 'wind_ms * 2');
    // `ms` is ambiguous, so nothing can be inherited yet.
    expect(store().inheritedUnits[resultSignature(cardId!)]).toBeUndefined();

    // The user answers the ambiguous source column; the next pull inherits the answer.
    const sourceCard = store()
      .cards.find((entry) => entry.id === sourceId) as MatrixCardModel;
    const sourceMatrixId = sourceCard.sources[0].matrixId;
    store().setColumnUnit(sourceMatrixId, 0, 'm/s');
    await settle();
    // A definition change is what triggers the pull (`recomputeFormula` coalesces to nothing
    // when the pushed parameters are unchanged — that is the existing behaviour, not ours).
    await setExpression(cardId!, 0, 'Col1', 'wind_ms * 3');
    expect(store().inheritedUnits[resultSignature(cardId!)]).toEqual({ 0: 'm/s' });
  });
});

// ── 3. precedence through the store context ───────────────────────────────────────

describe('resolution precedence through unitResolutionContext', () => {
  it('inherited beats the global pre-confirmation', async () => {
    setGlobalSettings({ unitPreconfirm: { col1: 'bar' } });
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');

    const result = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const view = columnUnitResolutions(
      result.columns().map((column) => column.annotation),
      store().unitConfirmations,
      unitResolutionContext(store()),
    );
    expect(view.resolutions[0].unit).toBe('kPa');
  });

  it('a user assertion beats inherited', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    expect(store().inheritedUnits[resultSignature(card.id)]).toEqual({ 0: 'kPa' });

    store().setFormulaUnit(card.id, 0, 'mbar');
    await settle();

    const result = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const view = columnUnitResolutions(
      result.columns().map((column) => column.annotation),
      store().unitConfirmations,
      unitResolutionContext(store()),
    );
    expect(view.resolutions[0].unit).toBe('mbar');
    // The assertion is the user's answer and lives in its own memory; the derivation is
    // still there, but it no longer decides the unit.
    expect(store().unitConfirmations[resultSignature(card.id)]?.[0]).toBe('mbar');
  });

  it('the context carries the derivation and an empty one is the same as absent', () => {
    expect(unitResolutionContext({ unitConstants: {}, inheritedUnits: {} }).inherited).toEqual({});
    const derived = { '1:deadbeef': { 0: 'kPa' } };
    expect(unitResolutionContext({ unitConstants: {}, inheritedUnits: derived }).inherited).toBe(
      derived,
    );
  });
});

// ── 4. session scoping ────────────────────────────────────────────────────────────

describe('the derivation is session state', () => {
  it('is not written into a snapshot', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    expect(Object.keys(store().inheritedUnits).length).toBeGreaterThan(0);

    const snapshot = store().toSnapshot() as unknown as Record<string, unknown>;
    expect('inheritedUnits' in snapshot).toBe(false);
  });

  it('a reset clears it', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    expect(Object.keys(store().inheritedUnits).length).toBeGreaterThan(0);
    store().reset();
    await settle(2);
    expect(store().inheritedUnits).toEqual({});
  });

  it('a restore starts empty and re-derives from the restored state', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    const snapshot = store().toSnapshot();

    store().reset();
    await settle(2);
    expect(store().inheritedUnits).toEqual({});

    store().loadSnapshot(snapshot);
    // Restoring writes nothing derived: the derivation is a pull-time answer, and the pull
    // after the restore re-derives it from the restored tables.
    expect(store().inheritedUnits).toEqual({});
    expect(liveCard(card.id).params.formulas?.[0].expression).toBe('pressure_kpa * 2');
  });

  it('a dirty push clears the derivation (no table of that shape remains)', async () => {
    backend!.setResult([[2, 4, 6]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 2');
    expect(Object.keys(store().inheritedUnits).length).toBeGreaterThan(0);

    backend!.setPatchState('dirty');
    await setExpression(card.id, 0, 'Col1', 'pressure_kpa * 3');
    expect(store().inheritedUnits).toEqual({});
  });
});