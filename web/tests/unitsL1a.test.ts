/**
 * Units L1a at the STORE layer (docs/tasks/2026-11-19-units-l1.md).
 *
 * Three contracts, each of which a second entry point could break silently:
 *
 *   1. **Scope precedence** — `effectiveUnitPolicy()` is `workspace override ?? global`; the
 *      workspace value travels in the snapshot, the global one does not. Card-level overrides
 *      are deliberately absent from this slice.
 *   2. **Explicit output unit** — `params.formulas[i].unit` is re-asserted into the ordinary
 *      confirmation memory after a result is pulled, so `columnUnitResolutions` (and with it
 *      every chip, axis and convert card) reads the asserted unit with no new channel. Empty
 *      asserts nothing, and the value is never sent to the backend.
 *   3. **Drift hint** — a file switch that changes a same-name column's derived unit says so
 *      in a strict workspace and stays silent in `auto`/`free` or when nothing changed; a
 *      restore never merges another workspace's confirmations into this one.
 *
 * The backend is stubbed exactly like the other store suites: the store's own transport must
 * not reach the network, and every fire-and-forget call is allowed to settle. jsdom is needed
 * for the GLOBAL layer's `localStorage` (the only place the store touches it, indirectly).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { NO_UNIT, columnUnitResolutions, unitSignature } from '../src/core/units.ts';
import {
  getGlobalSettings,
  resetGlobalSettingsCache,
  setGlobalSettings,
} from '../src/ui/globalSettings.ts';
import { effectiveUnitPolicy, useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel, MatrixCardModel, WorkspaceSnapshot } from '../src/ui/types.ts';

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

interface Call {
  url: string;
  method: string;
  body?: string;
}

/**
 * Stub transport. The result frame is chosen per test (`resultNames` / `resultColumns`), so
 * the "explicit unit" suite can describe exactly the table the backend would return.
 */
function stubBackend() {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 500;
  const resultOf = new Map<number, number>();
  const frame: { names: string[]; columns: number[][] } = {
    names: ['Pos.1 Col1'],
    columns: [[1, 2, 3]],
  };
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
      // `done` makes the store pull the result, which is where the assertion happens.
      return json({ nodeId, resultMatrixId, resultMatrixIds: [resultMatrixId], state: 'done' });
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'PATCH') return json({ nodeId: Number(nodePath[1]), state: 'done' });
    if (nodePath && method === 'GET') {
      return json({ nodeId: Number(nodePath[1]), state: 'done', resultMatrixId: resultOf.get(Number(nodePath[1])) });
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
    calls,
    /** Describe the table the backend will hand back on the next window read. */
    setResult(columns: number[][], names: string[]) {
      frame.columns = columns;
      frame.names = names;
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
  backend.calls.length = 0;
});

afterEach(() => {
  backend?.restore();
  backend = null;
  localStorage.clear();
  resetGlobalSettingsCache();
});

// ── 1. effectiveUnitPolicy ──────────────────────────────────────────────────────────

describe('effectiveUnitPolicy', () => {
  it('inherits the global tier when the workspace has no override', () => {
    expect(effectiveUnitPolicy(store())).toBe('strict');
    setGlobalSettings({ unitPolicy: 'free' });
    expect(effectiveUnitPolicy(store())).toBe('free');
  });

  it('a workspace override beats the global tier', () => {
    setGlobalSettings({ unitPolicy: 'strict' });
    store().setUnitPolicyOverride('auto');
    expect(effectiveUnitPolicy(store())).toBe('auto');

    // …and the other direction too (a strict workspace in a free install).
    setGlobalSettings({ unitPolicy: 'free' });
    store().setUnitPolicyOverride('strict');
    expect(effectiveUnitPolicy(store())).toBe('strict');
  });

  it('clearing the override returns to inheritance', () => {
    setGlobalSettings({ unitPolicy: 'auto' });
    store().setUnitPolicyOverride('strict');
    expect(effectiveUnitPolicy(store())).toBe('strict');
    store().setUnitPolicyOverride(null);
    expect(store().unitPolicyOverride).toBeUndefined();
    expect(effectiveUnitPolicy(store())).toBe('auto');
  });

  it('the override is workspace state: it travels in the snapshot and not in the settings', () => {
    store().setUnitPolicyOverride('free');
    expect(store().toSnapshot().unitPolicyOverride).toBe('free');
    // The global layer is untouched by a workspace-level choice.
    expect(getGlobalSettings().unitPolicy).toBe('strict');
    expect(localStorage.getItem('datacardforge.settings.v1')).toBeNull();
  });

  it('a snapshot without the field restores as "inherit" (legacy-safe)', () => {
    store().setUnitPolicyOverride('free');
    const snapshot: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    };
    store().loadSnapshot(snapshot);
    expect(store().unitPolicyOverride).toBeUndefined();
    expect(effectiveUnitPolicy(store())).toBe('strict');
  });

  it('an unreadable override in a file is dropped instead of trusted', () => {
    const snapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitPolicyOverride: 'lenient',
    } as unknown as WorkspaceSnapshot;
    store().loadSnapshot(snapshot);
    expect(store().unitPolicyOverride).toBeUndefined();
  });

  it('the override survives a save/restore cycle', () => {
    store().setUnitPolicyOverride('auto');
    const snapshot = store().toSnapshot();
    store().reset();
    expect(store().unitPolicyOverride).toBeUndefined();
    store().loadSnapshot(snapshot);
    expect(store().unitPolicyOverride).toBe('auto');
    expect(effectiveUnitPolicy(store())).toBe('auto');
  });
});

// ── 2. explicit output unit ────────────────────────────────────────────────────────

/** Create a data card, then a formula card reading it; both uploads are settled. */
async function addFormulaCard(): Promise<{ source: MatrixCardModel; card: FunctionCardModel }> {
  const sourceId = store().addMatrixCard([{ name: 'in.csv', matrix: matrix(['time_s', 'force_n']) }]);
  await settle();
  const source = store().cards.find((card) => card.id === sourceId) as MatrixCardModel;
  const cardId = store().addFormulaCard(source.id);
  expect(cardId).not.toBeNull();
  await settle();
  const card = store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
  return { source, card };
}

function liveCard(cardId: number): FunctionCardModel {
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

/** The derived unit of every column of a card's display cache. */
function resultUnits(card: FunctionCardModel): string[] {
  const result = store().matrices.get(card.displayMatrixId)!;
  return columnUnitResolutions(
    result.columns().map((column) => column.annotation),
    store().unitConfirmations,
  ).resolutions.map((resolution) => (resolution.state === 'recognized' ? resolution.unit : ''));
}

describe('explicit output unit (params.formulas[].unit)', () => {
  it('is asserted into the confirmation memory once the result is pulled', async () => {
    backend!.setResult([[1, 2, 3]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    // The backend names the output column `Col1` — no unit is derivable from that.
    expect(resultUnits(card)).toEqual(['']);

    store().setFormulaUnit(card.id, 0, 'N');
    await settle();

    expect(liveCard(card.id).params.formulas?.[0].unit).toBe('N');
    // The assertion is visible through the ordinary resolver — no second channel.
    expect(resultUnits(liveCard(card.id))).toEqual(['N']);
    const result = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const view = columnUnitResolutions(
      result.columns().map((column) => column.annotation),
      store().unitConfirmations,
    );
    expect(store().unitConfirmations[view.signature]?.[0]).toBe('N');
  });

  it('an empty unit asserts nothing and leaves the derived unit alone', async () => {
    // The result column already carries its own unit in its header.
    backend!.setResult([[1, 2, 3]], ['Pos.1 force_kN']);
    const { card } = await addFormulaCard();
    await settle();
    expect(resultUnits(liveCard(card.id))).toEqual(['kN']);

    store().setFormulaUnit(card.id, 0, '');
    await settle();
    expect(liveCard(card.id).params.formulas?.[0].unit).toBeUndefined();
    expect(resultUnits(liveCard(card.id))).toEqual(['kN']);
  });

  it('refuses a unit the registry does not know', async () => {
    const { card } = await addFormulaCard();
    store().setFormulaUnit(card.id, 0, 'furlong');
    expect(liveCard(card.id).params.formulas?.[0].unit).toBeUndefined();
  });

  it('is re-asserted after a recompute whose column names change the signature', async () => {
    backend!.setResult([[1, 2, 3]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await settle();
    store().setFormulaUnit(card.id, 0, 'N');
    await settle();

    const before = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const oldSignature = unitSignature(before.columns().map((column) => column.annotation));
    expect(store().unitConfirmations[oldSignature]?.[0]).toBe('N');

    // The next run names the column differently — a rename is exactly what a recompute does
    // (the user renames the output), and it moves the signature.
    backend!.setResult([[4, 5, 6]], ['Pos.1 Force_total']);
    store().recomputeFormula(card.id);
    // The stub answers `dirty` on PATCH… make the `done` path run by re-pulling explicitly.
    await settle();
    store().loadFullResult(card.id);
    await settle();

    const after = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const newSignature = unitSignature(after.columns().map((column) => column.annotation));
    if (newSignature !== oldSignature) {
      // Under the NEW key the assertion must exist again, or the unit would silently vanish
      // from every downstream consumer after a rename.
      expect(store().unitConfirmations[newSignature]?.[0]).toBe('N');
    }
    expect(resultUnits(liveCard(card.id))).toEqual(['N']);
  });

  it('is never sent to the backend (it is a client-side assertion)', async () => {
    backend!.setResult([[1, 2, 3]], ['Pos.1 Col1']);
    const { card } = await addFormulaCard();
    await settle();
    backend!.calls.length = 0;

    store().setFormulaUnit(card.id, 0, 'N');
    await settle();
    // No node traffic at all: asserting a unit changes no number.
    expect(backend!.calls.filter((call) => call.url.includes('/nodes'))).toEqual([]);

    // …and a later definition push still strips the key from the wire.
    store().setFormula(card.id, 0, 'Col1', 'Pos.1 * 2');
    await settle();
    const pushes = backend!.calls.filter((call) => call.url.includes('/nodes'));
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes) {
      expect(push.body ?? '').not.toContain('"unit"');
    }
    // The card KEEPS the assertion (the editor only owns name + expression).
    expect(liveCard(card.id).params.formulas?.[0].unit).toBe('N');
  });

  it('survives an expression edit (setFormula does not withdraw the assertion)', async () => {
    const { card } = await addFormulaCard();
    await settle();
    store().setFormulaUnit(card.id, 0, 'N');
    store().setFormula(card.id, 0, 'Col1', 'Pos.1 + 1');
    await settle();
    expect(liveCard(card.id).params.formulas?.[0]).toEqual({
      name: 'Col1',
      expression: 'Pos.1 + 1',
      unit: 'N',
    });
  });

  it('re-asserts over a confirmation the card contradicts (the card is the newer intent)', async () => {
    backend!.setResult([[1, 2, 3]], ['Pos.1 signal_a']);
    const { card } = await addFormulaCard();
    await settle();
    store().setFormulaUnit(card.id, 0, 'A');
    await settle();
    const result = store().matrices.get(liveCard(card.id).displayMatrixId)!;
    const signature = unitSignature(result.columns().map((column) => column.annotation));
    expect(store().unitConfirmations[signature]?.[0]).toBe('A');

    // The user changes their mind on the card: the next pull writes the new assertion.
    store().setFormulaUnit(card.id, 0, 'mA');
    await settle();
    expect(store().unitConfirmations[signature]?.[0]).toBe('mA');
  });
});

// ── 3. drift hint on a file switch ─────────────────────────────────────────────────

/** A data card holding one file, its upload settled. */
async function addDataCard(annotations: string[], name = 'u.csv'): Promise<MatrixCardModel> {
  const id = store().addMatrixCard([{ name, matrix: matrix(annotations) }]);
  await settle();
  return store().cards.find((card) => card.id === id) as MatrixCardModel;
}

describe('drift hint on a file replacement (strict only)', () => {
  // The UI's「替换文件…」control always names the slot it replaces (`replaceCardSources(id,
  // entries, index)`), which is the only call that has an "old version of THIS table" to
  // compare against — so every case here passes the index, exactly like the control does.
  it('prompts in strict mode when a same-name column changes its unit', async () => {
    const card = await addDataCard(['pressure_kpa', 'time_s']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['pressure_bar', 'time_s']) }], 0);
    await settle();

    const toast = store().toast;
    expect(toast).not.toBeNull();
    expect(toast!.message).toContain('pressure_bar');
    expect(toast!.message).toContain('kPa');
    expect(toast!.message).toContain('bar');
  });

  it('is silent when the units did not change', async () => {
    const card = await addDataCard(['pressure_kpa', 'time_s']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['pressure_kpa', 'time_s']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });

  it('is silent when the workspace override is not strict', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().setUnitPolicyOverride('free');
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['pressure_bar']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });

  it('is silent when the GLOBAL tier is not strict and nothing overrides it', async () => {
    setGlobalSettings({ unitPolicy: 'auto' });
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['pressure_bar']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });

  it('a strict workspace override still prompts in a non-strict install', async () => {
    setGlobalSettings({ unitPolicy: 'free' });
    store().setUnitPolicyOverride('strict');
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['pressure_bar']) }], 0);
    await settle();
    expect(store().toast).not.toBeNull();
  });

  it('a rename is not reported (a different column, not a changed unit)', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['force_n']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });
});

describe('drift hint on opening a workspace', () => {
  /** A snapshot whose single card holds one file with these annotations. */
  function snapshotOf(cardId: number, annotations: string[]): WorkspaceSnapshot {
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [
        {
          id: cardId,
          kind: 'matrix',
          title: 'u.csv',
          z: 1,
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          createdAt: 0,
          inputs: [],
          sources: [{ name: 'u.csv', matrixId: 1 }],
          activeSource: 0,
          readOnly: true,
        },
      ],
      matrices: [
        {
          id: 1,
          name: 'u.csv',
          columns: annotations.map((annotation, index) => ({
            posName: `Pos.${index + 1}`,
            annotation,
            data: [1, 2, 3],
          })),
        },
      ],
      nextCardId: cardId + 1,
      nextMatrixId: 2,
    };
  }

  it('prompts in strict mode when a same-name table opens with different units', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    store().loadSnapshot(snapshotOf(card.id, ['pressure_bar']));
    await settle();
    expect(store().toast?.message).toContain('bar');
  });

  it('is silent when the workspace opens the same data again', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    store().loadSnapshot(snapshotOf(card.id, ['pressure_kpa']));
    await settle();
    expect(store().toast).toBeNull();
  });

  it('is silent when the OPENED file carries a free-tier override', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().clearToast();
    // The tier that applies to a restore is the RESTORED workspace's own (scope rule §1):
    // an override set on the workspace being replaced does not survive the restore, and the
    // file's own override is what the check must read.
    store().loadSnapshot({ ...snapshotOf(card.id, ['pressure_bar']), unitPolicyOverride: 'free' });
    await settle();
    expect(store().unitPolicyOverride).toBe('free');
    expect(store().toast).toBeNull();
  });

  it('is silent when the install is not strict and the opened file has no override', async () => {
    const card = await addDataCard(['pressure_kpa']);
    setGlobalSettings({ unitPolicy: 'auto' });
    store().clearToast();
    store().loadSnapshot(snapshotOf(card.id, ['pressure_bar']));
    await settle();
    expect(store().unitPolicyOverride).toBeUndefined();
    expect(store().toast).toBeNull();
  });
});

// ── 4. nesting isolation ───────────────────────────────────────────────────────────

describe('loadSnapshot does not merge external confirmations', () => {
  it('replaces the memory instead of merging the previous workspace into it', async () => {
    // The open workspace has an answer for its own headers.
    const card = await addDataCard(['pressure_kpa']);
    store().setColumnUnit(card.sources[0].matrixId, 0, NO_UNIT);
    const signature = unitSignature(['pressure_kpa']);
    expect(store().unitConfirmations[signature]).toEqual({ 0: NO_UNIT });

    // The restored file has DIFFERENT headers — nothing from the old workspace may reach it,
    // and the old signature must not survive either.
    const snapshot: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConfirmations: { [unitSignature(['force_n'])]: { 0: 'N' } },
    };
    store().loadSnapshot(snapshot);
    await settle();

    expect(store().unitConfirmations[signature]).toBeUndefined();
    expect(store().unitConfirmations[unitSignature(['force_n'])]).toEqual({ 0: 'N' });
  });

  it('a file without the block restores to EMPTY memory, never to the previous one', async () => {
    const card = await addDataCard(['pressure_kpa']);
    store().setColumnUnit(card.sources[0].matrixId, 0, NO_UNIT);
    expect(Object.keys(store().unitConfirmations)).toHaveLength(1);

    store().loadSnapshot({
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    });
    await settle();
    expect(store().unitConfirmations).toEqual({});
  });

  it('a hand-edited file cannot smuggle an unregistered unit across the boundary', async () => {
    store().loadSnapshot({
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConfirmations: { [unitSignature(['pressure_kpa'])]: { 0: 'furlong' } },
    });
    await settle();
    expect(store().unitConfirmations[unitSignature(['pressure_kpa'])]).toBeUndefined();
  });

  it('the workspace policy override does not leak across a restore either', async () => {
    store().setUnitPolicyOverride('free');
    store().loadSnapshot({
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    });
    await settle();
    // The restored workspace carries no override, so it inherits the GLOBAL tier — never the
    // previous workspace's.
    expect(effectiveUnitPolicy(store())).toBe(getGlobalSettings().unitPolicy);
  });
});