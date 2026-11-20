/**
 * Units L2b at the STORE layer — the tier travels to the backend as a NODE PARAMETER.
 *
 * The event path of L2b is one direction only (the backend reports what it converted); what
 * this suite pins is the other one, and the one a refactor can quietly drop:
 *
 *   1. Every push of a `builtin:expression-columns` node carries `params.unitPolicy` with the
 *      EFFECTIVE tier — the workspace override when there is one, the global default
 *      otherwise — read live at push time rather than copied onto the card.
 *   2. The tier never travels on a signature whose numbers it cannot move, and it is not
 *      stored in the card's own parameters (one source of truth).
 *   3. The backend's `unitConversions` report is captured by the node mirror, dropped with
 *      the numbers it describes, and never persisted in a save file — the same lifetime the
 *      L1b warnings already have.
 *
 * The backend is stubbed like every other store suite: the transport must never reach the
 * network, and every fire-and-forget call is allowed to settle.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { resetGlobalSettingsCache, setGlobalSettings } from '../src/ui/globalSettings.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel, WorkspaceSnapshot } from '../src/ui/types.ts';

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

function stubBackend() {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 900;
  const state: { unitConversions?: unknown; warnings?: unknown } = {};
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
      return json({
        nodeId,
        resultMatrixId,
        resultMatrixIds: [resultMatrixId],
        state: 'done',
        ...(state.warnings !== undefined ? { warnings: state.warnings } : {}),
        ...(state.unitConversions !== undefined
          ? { unitConversions: state.unitConversions }
          : {}),
      });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'PATCH') {
      return json({
        nodeId: Number(nodePath[1]),
        state: 'done',
        ...(state.unitConversions !== undefined
          ? { unitConversions: state.unitConversions }
          : {}),
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
    setUnitConversions(value: unknown) {
      state.unitConversions = value;
    },
    setWarnings(value: unknown) {
      state.warnings = value;
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

/** The `params` object of the last node push the transport saw. */
function lastNodeParams(): Record<string, unknown> | undefined {
  const pushes = (backend?.calls ?? []).filter(
    (call) => call.url.endsWith('/api/nodes') && call.method === 'POST' && call.body,
  );
  const last = pushes[pushes.length - 1];
  if (!last?.body) return undefined;
  return (JSON.parse(last.body) as { params?: Record<string, unknown> }).params;
}

async function addFormulaCard(): Promise<FunctionCardModel> {
  const sourceId = store().addMatrixCard([
    { name: 'in.csv', matrix: matrix(['pressure_kpa', 'height_cm']) },
  ]);
  await settle();
  const cardId = store().addFormulaCard(sourceId);
  expect(cardId).not.toBeNull();
  await settle();
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

describe('unitPolicy travels as a node parameter', () => {
  it('pushes the EFFECTIVE tier (global strict by default)', async () => {
    await addFormulaCard();
    expect(lastNodeParams()?.unitPolicy).toBe('strict');
  });

  it('follows a workspace override over the global tier', async () => {
    setGlobalSettings({ unitPolicy: 'strict' });
    store().setUnitPolicyOverride('auto');
    await addFormulaCard();
    expect(lastNodeParams()?.unitPolicy).toBe('auto');
  });

  it('follows the global tier when the workspace has no override', async () => {
    setGlobalSettings({ unitPolicy: 'free' });
    await addFormulaCard();
    expect(lastNodeParams()?.unitPolicy).toBe('free');
  });

  it('re-pushes the tier when the setting changes', async () => {
    await addFormulaCard();
    const before = backend!.calls.length;
    store().setUnitPolicyOverride('auto');
    await settle();
    // The workspace PATCHes its own settings; the formula node must be re-declared too, or
    // the numbers would keep being computed under the previous tier.
    const repushed = backend!.calls
      .slice(before)
      .filter((call) => /\/api\/nodes\/\d+$/.test(call.url) && call.method === 'PATCH');
    const params = repushed
      .map((call) => (JSON.parse(call.body ?? '{}') as { params?: Record<string, unknown> }).params)
      .filter((entry) => entry !== undefined);
    expect(params.some((entry) => entry!.unitPolicy === 'auto')).toBe(true);
  });

  it('is not copied into the card parameters (the setting stays the single truth)', async () => {
    setGlobalSettings({ unitPolicy: 'auto' });
    const card = await addFormulaCard();
    expect(card.params.unitPolicy).toBeUndefined();
  });
});

describe('unitConversions mirror the node result', () => {
  const CONVERSION = { formula: 0, pair: 0, factor: 0.01, from: 'cm', to: 'km' };

  it('is captured beside the warnings and dropped with the numbers', async () => {
    backend!.setUnitConversions([CONVERSION]);
    backend!.setWarnings([
      { code: 'unitMismatch', left: 'Pos.1 pressure_kpa', right: 'Pos.2 height_cm', op: '+' },
    ]);
    const card = await addFormulaCard();
    const mirror = (
      store().cards.find((entry) => entry.id === card.id) as FunctionCardModel
    ).node;
    expect(mirror?.unitConversions).toEqual([CONVERSION]);
    expect(mirror?.warnings).toHaveLength(1);
  });

  it('drops a malformed entry instead of inventing one', async () => {
    backend!.setUnitConversions([CONVERSION, { from: 'cm' }, null, 'nope']);
    const card = await addFormulaCard();
    const mirror = (
      store().cards.find((entry) => entry.id === card.id) as FunctionCardModel
    ).node;
    expect(mirror?.unitConversions).toEqual([CONVERSION]);
  });

  it('is absent when the backend reports none', async () => {
    const card = await addFormulaCard();
    const mirror = (
      store().cards.find((entry) => entry.id === card.id) as FunctionCardModel
    ).node;
    expect(mirror?.unitConversions).toBeUndefined();
  });

  it('never reaches a save file', async () => {
    backend!.setUnitConversions([CONVERSION]);
    const card = await addFormulaCard();
    const snapshot = store().toSnapshot() as WorkspaceSnapshot;
    const saved = snapshot.cards.find((entry) => entry.id === card.id) as
      | { node?: { unitConversions?: unknown; warnings?: unknown } }
      | undefined;
    expect(saved?.node?.unitConversions).toBeUndefined();
    expect(saved?.node?.warnings).toBeUndefined();
  });
});