/**
 * @vitest-environment jsdom
 *
 * The script card's two seams with the rest of the app — the ones no card-level test reaches:
 *
 *   1. The render dispatch in `CardCanvas`: a `builtin:python` function card must draw
 *      `<ScriptCard>` and an ordinary function card must keep drawing `<FormulaCard>`. Both
 *      are one `FunctionCardModel`, so a dispatch mistake is silent — the card simply shows
 *      the wrong body — which is exactly why it is asserted here against the real store.
 *   2. The「新建脚本卡…」entry: a sibling of the relation-enumeration item in the data card's
 *      column menu. The entry carries no logic of its own; what matters is the port it
 *      creates, the edge it registers and the display cache it leaves empty.
 *
 * The transport is mocked (as in the other DOM suites); everything below the components is
 * the real store, because the wiring under test *is* the component-to-store agreement.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { createTranslator } from '../src/ui/i18n.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  PYTHON_SIGNATURE,
  isScriptCard,
  type FunctionCardModel,
  type MatrixCardModel,
} from '../src/ui/types.ts';
import { CardCanvas } from '../src/ui/components/CardCanvas.tsx';

const client = vi.hoisted(() => ({
  hello: vi.fn(async () => ({ ok: true })),
  signatures: vi.fn(async () => []),
  registerMatrix: vi.fn(async (_name: string) => ({ ok: true, matrixId: 70, revision: 1 })),
  patchCells: vi.fn(async () => ({ ok: true })),
  deleteMatrix: vi.fn(async () => ({ ok: true })),
  createNode: vi.fn(async (_inputs: unknown, arg: unknown) => ({
    ok: true,
    nodeId: 11,
    resultMatrixId: 111,
    resultMatrixIds: [111],
    signatureId:
      typeof arg === 'string'
        ? 'builtin:expression-columns'
        : (arg as { signatureId: string }).signatureId,
    state: 'dirty',
  })),
  patchNode: vi.fn(async (nodeId: number) => ({ ok: true, nodeId, state: 'dirty' })),
  deleteNode: vi.fn(async () => ({ ok: true })),
  getNode: vi.fn(async () => null),
  computeNode: vi.fn(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [111],
  })),
  checkAccuracy: vi.fn(async () => ({})),
  checkScript: vi.fn(async (_script: string) => ({ ok: true, impure: [] as string[] })),
  listNodes: vi.fn(async () => []),
  nodeResult: vi.fn(async () => ({ ok: false })),
  events: vi.fn(async () => []),
  window: vi.fn(async () => ({
    ok: true,
    rows: 2,
    columns: 1,
    totalRows: 2,
    totalCols: 1,
    names: ['Pos.1'],
    data: [new Float64Array([10, 20])],
  })),
}));

vi.mock('../src/backend/client.ts', () => ({
  PROTOCOL_VERSION: 1,
  REQUIRED_CAPABILITIES: [],
  decodeMatrixFrame: () => ({ ok: false, code: 'badFrame' }),
  BackendClient: class {
    constructor() {
      Object.assign(this, client);
    }
  },
}));

// React 19 wants this set so act() works outside its test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** A data table: `rows` rows of one column labelled `value`. */
function table(rows: number, columns = 1): MatrixData {
  const data = new MatrixData();
  for (let column = 0; column < columns; column += 1) {
    data.appendColumn(`Pos.${column + 1}`, Array.from({ length: rows }, (_, index) => index + column));
  }
  data.setColumnAnnotation(0, 'value');
  return data;
}

async function mountCanvas(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <CardCanvas
          onNewTable={() => {}}
          onFilesDropped={() => {}}
          onFilesDroppedOnCard={() => {}}
          onPickReplaceFile={() => {}}
          onContextMenu={() => {}}
        />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

/** Add a data card and place it, the way the file loaders leave one. */
async function dataCard(entries: { name: string; matrix: MatrixData }[]): Promise<number> {
  const id = store().addMatrixCard(entries);
  store().setBounds(id, { x: 0, y: 0, width: 640, height: 420 });
  await flush();
  return id;
}

/** Open the column-header menu of the first data card and return its items. */
async function openColumnMenu(host: HTMLElement): Promise<HTMLButtonElement[]> {
  const header = host.querySelector<HTMLElement>('.card--matrix .vtable__colhead');
  if (!header) throw new Error('no column header — the data card did not render its table');
  await act(async () => {
    header.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 140 }),
    );
  });
  return [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
}

function menuItem(items: HTMLButtonElement[], text: string): HTMLButtonElement {
  const item = items.find((entry) => entry.textContent?.includes(text));
  if (!item) {
    throw new Error(`no menu item containing "${text}" (had: ${items.map((i) => i.textContent).join(' | ')})`);
  }
  return item;
}

function card<T>(id: number): T {
  const found = store().cards.find((entry) => entry.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found as T;
}

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  store().reset();
});

// ── 1. the render dispatch ────────────────────────────────────────────────────
describe('CardCanvas draws the script card for a python signature only', () => {
  it('renders ScriptCard for builtin:python and FormulaCard for an ordinary function card', async () => {
    const sourceId = await dataCard([{ name: 'a.csv', matrix: table(3) }]);
    const scriptId = store().addScriptCard([sourceId]) as number;
    await flush();
    const formulaId = store().addFormulaCard(sourceId) as number;
    await flush();

    const host = await mountCanvas();

    // The script card's own body — the run controls and the editor host exist nowhere else.
    const scriptCard = host.querySelector<HTMLElement>(`.card--script[data-card-id="${scriptId}"]`);
    expect(scriptCard).not.toBeNull();
    expect(scriptCard!.querySelector('.script-card')).not.toBeNull();
    expect(scriptCard!.querySelector('.script-card__run')).not.toBeNull();
    expect(scriptCard!.querySelector('[data-script-editor]')).not.toBeNull();
    // …and it did NOT fall through to the formula body (the same card model would allow it).
    expect(scriptCard!.querySelector('.formula-card')).toBeNull();

    // An ordinary function card keeps its own body: the dispatch narrowed nothing else.
    const formulaCard = host.querySelector<HTMLElement>(`.card--formula[data-card-id="${formulaId}"]`);
    expect(formulaCard).not.toBeNull();
    expect(formulaCard!.querySelector('.formula-card')).not.toBeNull();
    expect(formulaCard!.querySelector('.script-card')).toBeNull();
  });

  it('survives a store update: the dispatch follows the signature, not the card kind', async () => {
    // Both cards are `kind: 'formula'`; only the signature tells them apart. Changing the
    // signature on the fly must move the card from one body to the other — the same rule a
    // workspace loaded from disk relies on.
    const sourceId = await dataCard([{ name: 'a.csv', matrix: table(3) }]);
    const cardId = store().addFormulaCard(sourceId) as number;
    await flush();
    const host = await mountCanvas();
    expect(host.querySelector('.card--formula')).not.toBeNull();

    await act(async () => {
      useWorkspace.setState((state) => ({
        cards: state.cards.map((entry) =>
          entry.id === cardId && entry.kind === 'formula'
            ? { ...entry, signatureId: PYTHON_SIGNATURE }
            : entry,
        ),
      }));
    });
    await flush();

    const scriptCard = host.querySelector<HTMLElement>(`.card--script[data-card-id="${cardId}"]`);
    expect(scriptCard).not.toBeNull();
    expect(scriptCard!.querySelector('.script-card')).not.toBeNull();
  });
});

// ── 2. the entry ──────────────────────────────────────────────────────────────
describe('「新建脚本卡…」is the sibling of the relation-enum entry', () => {
  it('creates a card born bound to that table: port A, one edge, empty display cache', async () => {
    const sourceId = await dataCard([{ name: 'a.csv', matrix: table(4, 2) }]);
    const source = card<MatrixCardModel>(sourceId);
    const sourceMatrixId = source.sources[source.activeSource].matrixId;

    const host = await mountCanvas();
    const items = await openColumnMenu(host);
    const entry = menuItem(items, '新建脚本卡…');
    expect(entry.disabled).toBe(false);

    const before = store().cards.length;
    await act(async () => {
      entry.click();
    });
    await flush();

    expect(store().cards).toHaveLength(before + 1);
    const created = store().cards[store().cards.length - 1] as FunctionCardModel;
    expect(created.kind).toBe('formula');
    expect(created.signatureId).toBe(PYTHON_SIGNATURE);
    expect(isScriptCard(created)).toBe(true);
    // Selected, like every other creation entry on the card.
    expect(store().selectedId).toBe(created.id);

    // Birth binding: ONE matrix port into the clicked table, named `A`.
    expect(created.inputs).toHaveLength(1);
    expect(created.inputs[0].portId).toBe('in:0');
    expect(created.inputs[0].target).toEqual({
      type: 'matrix',
      cardId: sourceId,
      matrixId: sourceMatrixId,
    });
    const params = created.params as { portNames: string[]; outputs: string[]; script: string };
    expect(params.portNames).toEqual(['A']);
    expect(params.outputs).toEqual(['result']);
    // The template names the port it was born with, so the first run is one keystroke away.
    expect(params.script).toContain('result = A * 1.0');
    // `out:0` exists before the first run: declaration, not result.
    expect(created.outputs.map((output) => output.outputId)).toEqual(['out:0']);

    // The edge went through the ordinary graph — one edge, carrying the port id.
    expect(store().dependencies.getDependencies(created.id)).toEqual([sourceId]);
    expect(store().dependencies.getPorts(created.id, sourceId)).toEqual(['in:0']);
    expect(store().dependencies.hasDependents(sourceId)).toBe(true);

    // The display cache exists and is EMPTY: the browser runs nobody's code.
    expect(store().matrices.get(created.displayMatrixId)?.rowCount()).toBe(0);
  });

  it('needs no second column — the script binds the table, not a column pair', async () => {
    // The relation item is disabled below two columns; the script item must not inherit
    // that gate (its port is a matrix, and one column is a perfectly good table).
    await dataCard([{ name: 'a.csv', matrix: table(2, 1) }]);
    const host = await mountCanvas();
    const items = await openColumnMenu(host);

    expect(menuItem(items, '新建关系枚举卡…').disabled).toBe(true);
    expect(menuItem(items, '新建脚本卡…').disabled).toBe(false);
  });

  it('closes the menu and creates nothing else on the canvas', async () => {
    await dataCard([{ name: 'a.csv', matrix: table(3) }]);
    const host = await mountCanvas();
    const items = await openColumnMenu(host);
    await act(async () => {
      menuItem(items, '新建脚本卡…').click();
    });
    await flush();

    expect(document.querySelector('.context-menu')).toBeNull();
    // Exactly one new card, i.e. no stray relation-enum/formula card came along.
    expect(store().cards).toHaveLength(2);
    expect(store().cards.filter((entry) => entry.kind === 'formula')).toHaveLength(1);
  });
});

// ── 3. the label ──────────────────────────────────────────────────────────────
describe('menu.newScriptCard', () => {
  it('exists in both dictionaries (a missing key falls back to the key itself)', () => {
    const zh = createTranslator('zh');
    const en = createTranslator('en');

    expect(zh('menu.newScriptCard')).toBe('新建脚本卡…');
    expect(en('menu.newScriptCard')).toBe('New Script Card…');
    // The fallback path returns the key; neither locale may be relying on it.
    expect(zh('menu.newScriptCard')).not.toBe('menu.newScriptCard');
    expect(en('menu.newScriptCard')).not.toBe('menu.newScriptCard');
    // The sibling the entry mirrors is still there — the two live side by side.
    expect(zh('menu.newRelationEnum')).toBe('新建关系枚举卡…');
    expect(en('menu.newRelationEnum')).toBe('New Relation Enumeration Card…');
  });
});