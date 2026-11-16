/**
 * @vitest-environment jsdom
 *
 * The script card's OUTPUT ROWS as a way OUT of the card.
 *
 * Every declared output is an ordinary matrix the store can already build from —
 * `addChartCard(…, outputId)`, `addFormulaCard(sourceCardId, matrixId)` and
 * `addScriptCard([{ cardId, outputId }])` all existed before this menu did. What was missing
 * was the entry point: an output row could be renamed, sized, previewed and deleted, and
 * still had no way to become a downstream card.
 *
 * The component is mounted against the REAL store (only the transport is mocked), because
 * the claim under test is the agreement between the two: the row names an `out:N`, the menu
 * hands that id to a creation verb, and the verb is what decides which matrix the dependent
 * reads. A test that stubbed the store would only prove the component can call a function.
 *
 * What these tests guard:
 *   - one entry per declared output, ordinal 0 included — opened by RIGHT-CLICKING the row
 *     (the header gesture: a data card builds from a column header, and an output row is
 *     this card's header). The left-click 「建卡」 button it replaced contradicted that rule;
 *   - the nine chart types sit one level down, behind「绘制图表」;
 *   - a card that has not run yet says so, and its chart group is disabled as one;
 *   - a chart built from `out:1` plots `out:1`'s numbers, not ordinal 0's;
 *   - the two other creation entries bind the same slot, with the same birth binding;
 *   - the shared dictionary (not the local zh table) is what the menu speaks.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHART_TYPE_ORDER, chartTypeDef } from '../src/charts/chartTypes.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { createTranslator } from '../src/ui/i18n.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  isScriptCard,
  type ChartCardModel,
  type FunctionCardModel,
} from '../src/ui/types.ts';
import { ScriptCard } from '../src/ui/components/ScriptCard.tsx';

/**
 * The one transport instance the store creates at import time.
 *
 * `served` rides along in the same hoisted object: the mock factory runs before the imports
 * are evaluated, so the only state it can see is what `vi.hoisted` built.
 */
const client = vi.hoisted(() => {
  /** Rows behind each server result matrix — `out:0` and the named output differ on purpose. */
  const served = new Map<number, number[]>();
  return {
    served,
    hello: vi.fn(async () => ({ ok: true })),
    signatures: vi.fn(async () => []),
    registerMatrix: vi.fn(async (_name: string) => ({ ok: true, matrixId: 70, revision: 1 })),
    patchCells: vi.fn(async () => ({ ok: true })),
    deleteMatrix: vi.fn(async () => ({ ok: true })),
    createNode: vi.fn(),
    patchNode: vi.fn(),
    deleteNode: vi.fn(async () => ({ ok: true })),
    getNode: vi.fn(async () => null),
    computeNode: vi.fn(),
    checkAccuracy: vi.fn(async () => ({})),
    checkScript: vi.fn(async (_script: string) => ({ ok: true, impure: [] as string[] })),
    listNodes: vi.fn(async () => []),
    nodeResult: vi.fn(async () => ({ ok: false })),
    events: vi.fn(async () => []),
    /** A DCM2 window: paged by `offset`/`limit`, so a preview read is visibly a preview. */
    window: vi.fn(async (matrixId: number, offset: number, limit: number) => {
      const all = served.get(matrixId);
      if (!all) return { ok: false, code: 'notFound' };
      const slice = all.slice(offset, offset + limit);
      return {
        ok: true,
        rows: slice.length,
        columns: 1,
        totalRows: all.length,
        totalCols: 1,
        names: ['Pos.1'],
        data: [slice],
      };
    }),
  };
});

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const zh = createTranslator('zh');
const en = createTranslator('en');
const roots: ReturnType<typeof createRoot>[] = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** A data table: `rows` rows of one column annotated `value`. */
function table(rows: number): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', Array.from({ length: rows }, (_, index) => index + 1));
  data.setColumnAnnotation(0, 'value');
  return data;
}

/** The store holds the authority; the mounted card follows it, like CardCanvas does. */
function Harness({ cardId }: { cardId: number }) {
  const card = useWorkspace((state) => state.cards.find((entry) => entry.id === cardId));
  if (!card || !isScriptCard(card)) return null;
  return (
    <ScriptCard
      card={card}
      active
      closeBlocked={false}
      onActivate={() => {}}
      onClose={() => {}}
      onCloseBlocked={() => {}}
    />
  );
}

async function mount(cardId: number): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness cardId={cardId} />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

/** The menu portals into `document.body` (a transformed card would clip it), so it is read
 *  from the document rather than from the mounted host. */
function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
}

function menuItem(text: string): HTMLButtonElement {
  const found = menuItems().find((entry) => entry.textContent?.includes(text));
  if (!found) {
    throw new Error(
      `no menu item "${text}" (had: ${menuItems()
        .map((entry) => entry.textContent)
        .join(' | ')})`,
    );
  }
  return found;
}

/** Right-click one output row — the gesture that opens the build menu. */
async function openBuildMenu(host: HTMLElement, ordinal: number): Promise<HTMLButtonElement[]> {
  const row = host.querySelectorAll<HTMLElement>('.script-card__row--output')[ordinal];
  if (!row) throw new Error(`output row ${ordinal} is missing`);
  await rightClick(row);
  return menuItems();
}

/**
 * Open the build menu, then walk into「绘制图表」and return the nine chart entries.
 *
 * Only the submenu's own items are returned: level one is still on screen (a submenu is a
 * second list, not a replacement), and mixing the two would make "9 chart types" untestable.
 */
async function openChartMenu(host: HTMLElement, ordinal: number): Promise<HTMLButtonElement[]> {
  const level = await openBuildMenu(host, ordinal);
  const sub = level.find((item) => item.textContent?.includes(zh('table.contextChartMenu')));
  if (!sub) {
    throw new Error(`no chart submenu (had: ${level.map((item) => item.textContent).join(' | ')})`);
  }
  await click(sub);
  const menus = [...document.querySelectorAll<HTMLElement>('.context-menu')];
  return [...menus[menus.length - 1].querySelectorAll<HTMLButtonElement>('.context-menu__item')];
}

/** Right-click one element (it bubbles to the output row it lives in). */
async function rightClick(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 320,
        clientY: 240,
      }),
    );
  });
  await flush();
}

/** Escape dismisses every open menu, at both levels. */
async function dismiss(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  await flush();
}

async function click(item: HTMLButtonElement): Promise<void> {
  await act(async () => {
    item.click();
  });
  await flush();
}

/** Server matrix ids the mocked backend answers for: `out:0` and the named output. */
const PRIMARY_MATRIX = 111;
const EXTRA_MATRIX = 222;

let cardId = 0;
let nextNodeId = 11;

function scriptCard(): FunctionCardModel {
  const card = store().cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) throw new Error(`card ${cardId} is not a script card`);
  return card;
}

/** Local slot of `out:1` — the matrix every assertion below is about. */
function extraSlot(): number {
  const slot = scriptCard().outputs[1]?.localMatrixId;
  if (typeof slot !== 'number') throw new Error('out:1 has no local slot');
  return slot;
}

/**
 * One clean run whose named output carries DIFFERENT numbers than ordinal 0.
 *
 * That difference is the whole test: a regression that hands the chart the display slot
 * shows up as the wrong values instead of as an empty chart, which could be blamed on timing.
 */
async function runWithData(): Promise<void> {
  client.served.set(PRIMARY_MATRIX, [1, 2, 3]);
  client.served.set(EXTRA_MATRIX, [10, 20, 30]);
  client.computeNode.mockImplementationOnce(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [PRIMARY_MATRIX],
    extraOutputs: [{ name: 'b', matrixId: EXTRA_MATRIX, rows: 3, cols: 1 }],
  }));
  store().runScriptCard(cardId);
  // A run awaits compute and then one window read per declared output.
  await flush();
  await flush();
  await flush();
  expect(store().scriptRuns[cardId]?.status).toBe('done');
}

beforeEach(async () => {
  store().reset();
  store().setLocale('zh');
  client.served.clear();
  nextNodeId = 11;

  client.createNode.mockReset().mockImplementation(async (_inputs, arg: unknown) => {
    const nodeId = nextNodeId++;
    return {
      ok: true,
      nodeId,
      resultMatrixId: 100 + nodeId,
      resultMatrixIds: [100 + nodeId],
      signatureId:
        typeof arg === 'string'
          ? 'builtin:expression-columns'
          : (arg as { signatureId: string }).signatureId,
      // The backend is explicit: creation is dirty/notRequested, nothing ran.
      state: 'dirty',
      reason: 'notRequested',
    };
  });
  client.patchNode.mockReset().mockImplementation(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'dirty',
  }));
  client.computeNode.mockReset().mockImplementation(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [100 + nodeId],
  }));

  const sourceId = store().addMatrixCard([{ name: 'a.csv', matrix: table(3) }]);
  await flush();
  cardId = store().addScriptCard([sourceId]) as number;
  await flush();
  // The second output allocates its own local slot — the thing every case below builds from.
  expect(store().addScriptOutput(cardId)).toBe('out:1');
  await flush();
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

describe('the build entry', () => {
  it('opens on every declared output row, ordinal 0 included', async () => {
    const host = await mount(cardId);
    // No button any more: the entry point is the row's own right-click.
    expect(host.querySelector('.script-card__build')).toBeNull();

    for (const [ordinal, outputId] of [
      [0, 'out:0'],
      [1, 'out:1'],
    ] as const) {
      await openBuildMenu(host, ordinal);
      const title = document.querySelector('.context-menu__title')?.textContent ?? '';
      expect(title).toContain(outputId);
      await dismiss();
      expect(document.querySelector('.context-menu')).toBeNull();
    }
  });

  it('leaves the name field its own right-click', async () => {
    // The row is a text box and a couple of buttons; a right-click in the box is the
    // browser's paste gesture, not a request to build a card.
    const host = await mount(cardId);
    const input = host.querySelector<HTMLInputElement>('.script-card__row--output input');
    expect(input).not.toBeNull();
    await rightClick(input!);
    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('says the output has no data yet, and disables the chart group as one', async () => {
    const host = await mount(cardId);
    const level = await openBuildMenu(host, 1);

    // The title names both the label and the stable id — the id is what a dependent stores.
    const title = document.querySelector('.context-menu__title')?.textContent ?? '';
    expect(title).toContain('result2');
    expect(title).toContain('out:1');
    expect(title).toContain('从这里建卡');

    expect(document.querySelector('.context-menu__hint')?.textContent).toBe(
      '该输出还没有数据，先运行一次',
    );

    // Level one is three entries: the chart submenu, then the two card types.
    expect(level).toHaveLength(3);
    // The two creation entries are NOT gated by data: a formula card reads a declaration.
    expect(level[1].disabled).toBe(false);
    expect(level[2].disabled).toBe(false);

    // …while every chart type is disabled by the zero-column rule, seen through the submenu.
    const charts = await openChartMenu(host, 1);
    expect(charts).toHaveLength(CHART_TYPE_ORDER.length);
    expect(charts.every((item) => item.disabled)).toBe(true);
  });
});

describe('building from a named output', () => {
  it('draws a chart from out:1, selects it and closes the menu', async () => {
    await runWithData();
    const slot = extraSlot();
    const host = await mount(cardId);
    const items = await openChartMenu(host, 1);

    // The card has run, so the "no data yet" hint is gone…
    expect(document.querySelector('.context-menu__hint')).toBeNull();
    // …and the one-column types are live, while a pair type explains what it is missing.
    const line = items.find((entry) => entry.textContent === zh(chartTypeDef('line').labelKey));
    const scatter = items.find(
      (entry) => entry.textContent === zh(chartTypeDef('scatter').labelKey),
    );
    expect(line?.disabled).toBe(false);
    expect(scatter?.disabled).toBe(true);
    expect(scatter?.title).toContain('需要');

    await click(line!);

    const charts = store().cards.filter((entry) => entry.kind === 'chart');
    expect(charts).toHaveLength(1);
    const chart = charts[0] as ChartCardModel;
    // The chart reads the slot `out:1` names — not the display cache of ordinal 0.
    expect(chart.config.sources[0].matrixId).toBe(slot);
    expect(chart.config.sources[0].raw).toEqual([10, 20, 30]);
    // The store selects what it creates; the component does not repeat that call.
    expect(store().selectedId).toBe(chart.id);
    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('chains a formula card onto out:1', async () => {
    await runWithData();
    const slot = extraSlot();
    const host = await mount(cardId);
    await openBuildMenu(host, 1);

    await click(menuItem(zh('menu.newFormula')));

    const created = store().cards.filter(
      (entry) => entry.id !== cardId && entry.kind === 'formula',
    ) as FunctionCardModel[];
    expect(created).toHaveLength(1);
    expect(created[0].inputs[0].target).toEqual({
      type: 'matrix',
      cardId,
      matrixId: slot,
    });
    expect(store().selectedId).toBe(created[0].id);
    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('binds a new script card to out:1 with one port named A', async () => {
    await runWithData();
    const slot = extraSlot();
    const host = await mount(cardId);
    await openBuildMenu(host, 1);

    await click(menuItem(zh('menu.newScriptCard')));

    const created = store().cards.find((entry) => entry.id !== cardId && isScriptCard(entry));
    expect(created).toBeDefined();
    const chained = created as FunctionCardModel;
    expect(chained.inputs).toHaveLength(1);
    expect(chained.inputs[0].portId).toBe('in:0');
    expect(chained.inputs[0].target.matrixId).toBe(slot);
    // Birth binding, the same rule the data card's column menu uses.
    expect((chained.params as { portNames: string[] }).portNames).toEqual(['A']);
    expect(document.querySelector('.context-menu')).toBeNull();
  });
});

describe('the dictionary', () => {
  it('speaks the shared i18n keys, not the card’s local zh table', async () => {
    const host = await mount(cardId);
    // Switching the workspace locale re-renders the mounted card: the menu is translated,
    // not baked at mount time.
    await act(async () => {
      store().setLocale('en');
    });
    await flush();

    const level = await openBuildMenu(host, 1);
    // The submenu entry is a shared key, with the chevron the primitive appends.
    expect(level[0].textContent).toContain(en('table.contextChartMenu'));
    expect(menuItem(en('menu.newFormula')).textContent).toBe('New Formula Card…');
    expect(menuItem(en('menu.newScriptCard')).textContent).toBe('New Script Card…');

    // The chart labels come from the dictionary too — one level down.
    await click(level[0]);
    expect(menuItem(en(chartTypeDef('line').labelKey)).textContent).toBe('Line');
  });
});