/**
 * Units L1b at the STORE layer (docs/tasks/2026-11-19-units-l1.md §B2).
 *
 * Three contracts that a second entry point could break silently:
 *
 *   1. **Node warnings are captured, session-scoped, and dropped with the numbers.** The
 *      backend publishes `warnings` next to the result it just computed and clears them the
 *      moment the result goes (dirty / error / cancel). The mirror keeps exactly that rule:
 *      nothing is persisted, and "no warnings" is the absence of the field, not an empty array.
 *   2. **Manual constants are workspace data.** `unitConstants` travels in the snapshot,
 *      replaces (never merges) on load, survives a reset as empty, and refuses a definition
 *      that would make the resolver act on nothing.
 *   3. **The resolution context agrees everywhere.** The store's `unitResolutionContext`
 *      combines the workspace's constants with the global pre-confirmations — the same pair
 *      the chips, the axis, the convert card and the drift hint pass.
 *
 * The backend is stubbed like the other store suites: the transport must never reach the
 * network, and every fire-and-forget call is allowed to settle. jsdom supplies `localStorage`
 * for the GLOBAL layer.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { columnUnitResolutions } from '../src/core/units.ts';
import {
  resetGlobalSettingsCache,
  setGlobalSettings,
} from '../src/ui/globalSettings.ts';
import {
  effectiveUnitPolicy,
  unitResolutionContext,
  useWorkspace,
} from '../src/ui/workspaceStore.ts';
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
 * Stub transport. `warnings` is what `POST /nodes` answers with — the create DTO is the
 * shortest path to a card carrying advice, and a test can hand it anything (including a
 * malformed entry) to pin the sanitiser.
 */
function stubBackend() {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 900;
  const resultOf = new Map<number, number>();
  const state: { warnings?: unknown } = {};
  let patchState = 'done';
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
        state: 'done',
        ...(state.warnings !== undefined ? { warnings: state.warnings } : {}),
      });
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'PATCH') {
      return json({ nodeId: Number(nodePath[1]), state: patchState });
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
        arrayBuffer: async () => encodeFrame([[1, 2, 3]], ['Pos.1 Col1']),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return {
    calls,
    setWarnings(warnings: unknown) {
      state.warnings = warnings;
    },
    setPatchState(next: string) {
      patchState = next;
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

async function addFormulaCard(): Promise<FunctionCardModel> {
  const sourceId = store().addMatrixCard([{ name: 'in.csv', matrix: matrix(['time_s', 'force_n']) }]);
  await settle();
  const cardId = store().addFormulaCard(sourceId);
  expect(cardId).not.toBeNull();
  await settle();
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

function liveCard(cardId: number): FunctionCardModel {
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

const MISMATCH = {
  code: 'unitMismatch',
  left: 'Pos.1 pressure_kpa',
  right: 'Pos.2 height_cm',
  op: '+',
  formula: 0,
};

// ── 1. node warnings ───────────────────────────────────────────────────────────────

describe('node warnings (units L1b / B1)', () => {
  it('are captured from the create answer, with the formula index kept', async () => {
    backend!.setWarnings([MISMATCH]);
    const card = await addFormulaCard();
    expect(liveCard(card.id).node?.warnings).toEqual([MISMATCH]);
  });

  it('are absent (not an empty array) when the backend has nothing to say', async () => {
    const card = await addFormulaCard();
    expect(liveCard(card.id).node?.warnings).toBeUndefined();
    expect('warnings' in (liveCard(card.id).node ?? {})).toBe(false);
  });

  it('a malformed entry is dropped and the rest survive', async () => {
    backend!.setWarnings([
      { code: 'unitMismatch' }, // no labels: cannot become a sentence
      { left: 'a', right: 'b', op: '+' }, // no code
      { code: '', left: 'a', right: 'b', op: '+' }, // empty code
      'not an object',
      MISMATCH,
    ]);
    const card = await addFormulaCard();
    expect(liveCard(card.id).node?.warnings).toEqual([MISMATCH]);
  });

  it('an unknown code survives (the server said something, so the card can too)', async () => {
    const unknown = { code: 'unitMissing', left: 'Pos.1 a', right: 'Pos.2 b', op: '+' };
    backend!.setWarnings([unknown]);
    const card = await addFormulaCard();
    expect(liveCard(card.id).node?.warnings).toEqual([unknown]);
  });

  it('are dropped when a push says the node went dirty (the numbers are gone)', async () => {
    backend!.setWarnings([MISMATCH]);
    const card = await addFormulaCard();
    const nodeId = liveCard(card.id).node!.nodeId;
    expect(liveCard(card.id).node?.warnings).toHaveLength(1);

    store().applyNodeEvent({ seq: 9001, nodeId, state: 'dirty', reason: 'upstreamChanged' });
    expect(liveCard(card.id).node?.state).toBe('dirty');
    expect(liveCard(card.id).node?.warnings).toBeUndefined();
  });

  it('are dropped when the node errors', async () => {
    backend!.setWarnings([MISMATCH]);
    const card = await addFormulaCard();
    const nodeId = liveCard(card.id).node!.nodeId;

    store().applyNodeEvent({ seq: 9002, nodeId, state: 'error', code: 'badExpression', params: {} });
    expect(liveCard(card.id).node?.state).toBe('error');
    expect(liveCard(card.id).node?.warnings).toBeUndefined();
  });

  it('ride a pushed done event', async () => {
    const card = await addFormulaCard();
    const nodeId = liveCard(card.id).node!.nodeId;
    const pushed = { code: 'unitMismatch', left: 'Pos.1 load_kn', right: 'Pos.2 time_min', op: 'IF' };
    store().applyNodeEvent({ seq: 9003, nodeId, state: 'done', warnings: [pushed] });
    await settle();
    expect(liveCard(card.id).node?.warnings).toEqual([pushed]);
  });

  it('are never persisted: the snapshot carries no advice', async () => {
    backend!.setWarnings([MISMATCH]);
    const card = await addFormulaCard();
    const saved = JSON.stringify(store().toSnapshot());
    expect(saved).not.toContain('unitMismatch');
    expect(saved).not.toContain('"warnings"');
    // …and a restored card starts with none, because its numbers come from a new pull.
    store().loadSnapshot(store().toSnapshot());
    expect(liveCard(card.id).node).toBeNull();
  });

  it('a definition push answered dirty clears them', async () => {
    backend!.setWarnings([MISMATCH]);
    const card = await addFormulaCard();
    expect(liveCard(card.id).node?.warnings).toHaveLength(1);

    backend!.setPatchState('dirty');
    store().setFormula(card.id, 0, 'Col1', 'Pos.1 + 1');
    await settle();
    expect(liveCard(card.id).node?.state).toBe('dirty');
    expect(liveCard(card.id).node?.warnings).toBeUndefined();
  });
});

// ── 2. manual constants (workspace layer) ─────────────────────────────────────────

describe('manual unit constants (units L1b §B2)', () => {
  it('start empty and can be added and removed', () => {
    expect(store().unitConstants).toEqual({});
    expect(store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 })).toBe(true);
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });

    store().removeUnitConstant('g');
    expect(store().unitConstants).toEqual({});
    // Removing an absent token is a no-op, not an error.
    store().removeUnitConstant('g');
    expect(store().unitConstants).toEqual({});
  });

  it('trims the token and the dimension (the resolver looks both up verbatim)', () => {
    expect(store().addUnitConstant('  g ', { dimension: ' acceleration ', factor: 9.80665 })).toBe(true);
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });
  });

  it('refuses a definition that would make the resolver act on nothing', () => {
    const cases: Array<[string, { dimension: string; factor: number }]> = [
      ['', { dimension: 'acceleration', factor: 9.8 }],
      ['   ', { dimension: 'acceleration', factor: 9.8 }],
      ['g', { dimension: '', factor: 9.8 }],
      ['g', { dimension: 'acceleration', factor: 0 }],
      ['g', { dimension: 'acceleration', factor: -9.8 }],
      ['g', { dimension: 'acceleration', factor: Number.NaN }],
    ];
    for (const [token, constant] of cases) {
      expect(store().addUnitConstant(token, constant)).toBe(false);
    }
    expect(store().unitConstants).toEqual({});
  });

  it('a redefinition replaces the previous value (one reading per token)', () => {
    store().addUnitConstant('g', { dimension: 'mass', factor: 1e-3 });
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });
  });

  it('travels in the snapshot and survives a save/restore cycle', () => {
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    const snapshot = store().toSnapshot();
    expect(snapshot.unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });

    store().reset();
    expect(store().unitConstants).toEqual({});
    store().loadSnapshot(snapshot);
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });
  });

  it('a legacy snapshot without the block restores to no constants', () => {
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    const legacy: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    };
    localStorage.clear();
    store().loadSnapshot(legacy);
    // The previous workspace's definitions must not survive into a file that never had any.
    expect(store().unitConstants).toEqual({});
  });

  it('a hand-edited definition is dropped, not repaired', () => {
    const snapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConstants: {
        g: { dimension: 'acceleration', factor: 9.80665 },
        bad1: { dimension: '', factor: 1 },
        bad2: { dimension: 'mass', factor: 0 },
        bad3: { dimension: 'mass', factor: 'one' },
        bad4: 'not an object',
        '  ': { dimension: 'mass', factor: 1 },
      },
    } as unknown as WorkspaceSnapshot;
    store().loadSnapshot(snapshot);
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });
  });

  it('NESTING: a restore replaces the layer and never merges it into the parent', () => {
    // The host workspace holds its own definition…
    store().addUnitConstant('N', { dimension: 'force', factor: 1 });
    const child: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConstants: { g: { dimension: 'acceleration', factor: 9.80665 } },
    };
    store().loadSnapshot(child);
    // …and loading the embedded workspace shows ITS answers only (no `N` inherited, the
    // host's key was not merged in).
    expect(store().unitConstants).toEqual({ g: { dimension: 'acceleration', factor: 9.80665 } });

    // Going back is another boundary: the child's `g` does not leak into the host either.
    const host: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConstants: { N: { dimension: 'force', factor: 1 } },
    };
    store().loadSnapshot(host);
    expect(store().unitConstants).toEqual({ N: { dimension: 'force', factor: 1 } });
  });

  it('a reset clears them (an empty workspace has no project conventions)', () => {
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    store().reset();
    expect(store().unitConstants).toEqual({});
  });
});

// ── 3. the shared resolution context ──────────────────────────────────────────────

describe('unitResolutionContext', () => {
  it('combines the workspace constants with the global pre-confirmations', () => {
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    setGlobalSettings({ unitPreconfirm: { ms: 'ms' } });
    expect(unitResolutionContext(store())).toEqual({
      constants: { g: { dimension: 'acceleration', factor: 9.80665 } },
      preconfirm: { ms: 'ms' },
    });
  });

  it('reads the pre-confirmations live (editing the dialog applies without a reload)', () => {
    expect(unitResolutionContext(store()).preconfirm).toEqual({});
    setGlobalSettings({ unitPreconfirm: { g: 'g' } });
    expect(unitResolutionContext(store()).preconfirm).toEqual({ g: 'g' });
  });

  it('resolves a header through the workspace before the global layer', () => {
    const columns = ['force_g'];
    setGlobalSettings({ unitPreconfirm: { g: 'g' } });
    const before = columnUnitResolutions(columns, store().unitConfirmations, unitResolutionContext(store()));
    expect(before.resolutions[0].dimension).toBe('mass');

    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    const after = columnUnitResolutions(columns, store().unitConfirmations, unitResolutionContext(store()));
    expect(after.resolutions[0].dimension).toBe('acceleration');
  });
});

// ── 4. the drift hint uses the same chain ─────────────────────────────────────────

describe('drift hint follows the resolution chain', () => {
  /** The store's own toast wording is already covered by unitsL1a; here only the tier gate. */
  async function addDataCard(annotations: string[], name = 'u.csv'): Promise<MatrixCardModel> {
    const id = store().addMatrixCard([{ name, matrix: matrix(annotations) }]);
    await settle();
    return store().cards.find((card) => card.id === id) as MatrixCardModel;
  }

  it('a constant that only re-reads one dimension keeps the strict drift silent', async () => {
    // `g` starts ambiguous on both sides; defining it does not change a column's unit, and a
    // file swap that keeps the headers identical must not produce a hint.
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    const card = await addDataCard(['force_g', 'time_s']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['force_g', 'time_s']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });

  it('a constant makes a formerly contested column comparable (no false drift)', async () => {
    const card = await addDataCard(['force_g']);
    store().addUnitConstant('g', { dimension: 'acceleration', factor: 9.80665 });
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['force_g']) }], 0);
    await settle();
    // Same header, same definition: the "resolved unit" is the same on both sides.
    expect(store().toast).toBeNull();
  });

  it('the global pre-confirmation is part of the comparison too', async () => {
    setGlobalSettings({ unitPreconfirm: { g: 'g' } });
    const card = await addDataCard(['force_g']);
    store().clearToast();
    store().replaceCardSources(card.id, [{ name: 'u.csv', matrix: matrix(['force_g']) }], 0);
    await settle();
    expect(store().toast).toBeNull();
  });

  it('effectiveUnitPolicy still reads the workspace override over the global tier', () => {
    setGlobalSettings({ unitPolicy: 'free' });
    expect(effectiveUnitPolicy(store())).toBe('free');
    store().setUnitPolicyOverride('strict');
    expect(effectiveUnitPolicy(store())).toBe('strict');
  });
});