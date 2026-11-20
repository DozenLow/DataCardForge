/**
 * @vitest-environment jsdom
 *
 * The source picker (M2) — the in-card surface that declares which table a script port reads.
 *
 * What this suite locks, and why each half is a real risk:
 *
 *   - OPENING: a port row's source label is the re-bind control and `+ 端口` is the add
 *     control. The add button used to call `addScriptPort`, which silently did nothing at
 *     all after M1 retired "clone the first source" — a button that looks live and has no
 *     effect is the failure this test exists to prevent.
 *   - WHAT IT LISTS: every publishable matrix in the workspace, grouped by source card,
 *     plus the three marked states (already bound / not computed / would cycle). The picker
 *     is a BINDING DECLARATION surface, so unlike the chart's column dock it may enumerate
 *     the whole workspace (decision 2026-11-20 §五) — asserting the enumeration is asserting
 *     that line.
 *   - REFUSALS: a cycle candidate is greyed AND the store is never called. The store would
 *     refuse it anyway, but "click → toast → nothing" is a worse surface than a row that
 *     cannot be clicked, so the component is checked to keep its hands off the store.
 *   - CANCEL: dismissing the popup declares nothing. No port, no name, no edge.
 *   - THE WRITES: add appends a port + the next free name + one edge; re-bind keeps `in:N`
 *     and the variable and moves only the source (`params` and the script byte-identical);
 *     remove is unconditional and leaves the "still referenced" count as a hint (ruling #3).
 *
 * The component is mounted against the REAL store and the picker's real popup (portalled
 * into `document.body`), because the rules under test are split between the two: the row
 * state comes from the store's `publishedMatrices` and dependency graph, and the write is
 * the store's own transactional action. Stubbing either side would test the fixture.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { portAnchor, resetMetrics } from '../src/ui/cardMetrics.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { isScriptCard, type FunctionCardModel } from '../src/ui/types.ts';
import { ScriptCard } from '../src/ui/components/ScriptCard.tsx';

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
  trustStatus: vi.fn(async () => ({
    ok: true,
    persistence: 'persistent',
    location: '/tmp/trust.json',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustDecidePersistence: vi.fn(async () => ({
    ok: true,
    persistence: 'persistent',
    location: '/tmp/trust.json',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustLookup: vi.fn(async () => ({
    ok: true,
    hash: '',
    known: false,
    envMatch: true,
    scripts: [],
    persistence: 'persistent',
  })),
  trustRecord: vi.fn(async () => true),
  trustRevoke: vi.fn(async () => true),
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];

// ── fixtures ────────────────────────────────────────────────────────────────────────

/** A one-column table, so a data card publishes something recognisable. */
function table(rows: number): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', Array.from({ length: rows }, (_, index) => index + 1));
  data.setColumnAnnotation(0, 'value');
  return data;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function dataCard(name: string): Promise<number> {
  const id = store().addMatrixCard([{ name, matrix: table(2) }]);
  await flush();
  return id;
}

async function scriptCardFrom(
  seeds: Array<number | { cardId: number; outputId?: string }>,
): Promise<number> {
  const id = store().addScriptCard(seeds);
  await flush();
  if (id === null) throw new Error('the script card was refused');
  return id;
}

/** The matrix a data card publishes (its active file). */
function activeMatrix(cardId: number): number {
  const card = store().cards.find((entry) => entry.id === cardId) as unknown as {
    sources: { matrixId: number }[];
    activeSource: number;
  };
  return card.sources[card.activeSource].matrixId;
}

function card(id: number): FunctionCardModel {
  const found = store().cards.find((entry) => entry.id === id);
  if (!found || !isScriptCard(found)) throw new Error(`card ${id} is not a script card`);
  return found;
}

// ── mounting ────────────────────────────────────────────────────────────────────────

function Harness({ cardId }: { cardId: number }) {
  const current = useWorkspace((state) => state.cards.find((entry) => entry.id === cardId));
  if (!current || !isScriptCard(current)) return null;
  return (
    <ScriptCard
      card={current}
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

// ── the picker (a portal, so it lives beside the host, not inside it) ───────────────

function picker(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-source-picker]');
}

function pickerRows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.source-picker__item')];
}

function rowForMatrix(matrixId: number): HTMLButtonElement {
  const row = pickerRows().find((entry) => Number(entry.dataset.matrixId) === matrixId);
  if (!row) throw new Error(`no picker row for matrix ${matrixId}`);
  return row;
}

function groupTitles(): string[] {
  return [...document.querySelectorAll('.source-picker__group-title')].map(
    (node) => node.textContent ?? '',
  );
}

function rowLabels(): string[] {
  return [...document.querySelectorAll('.source-picker__item-label')].map(
    (node) => node.textContent ?? '',
  );
}

/** Click a real control (the button in the card, not the portal). */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

/**
 * Dispatch a click WITHOUT the browser's disabled-element shortcut.
 *
 * A `<button disabled>` swallows `.click()`, which would make "the store is never called"
 * pass for the wrong reason. This proves the component's own guard instead.
 */
async function forceClick(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

function addPortButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    '.script-card__panel--inputs .script-card__add',
  );
  if (!button) throw new Error('the inputs panel has no add button');
  return button;
}

function sourceControl(host: HTMLElement, portId: string): HTMLButtonElement {
  const control = host.querySelector<HTMLButtonElement>(`[data-port-source="${portId}"]`);
  if (!control) throw new Error(`no source control for ${portId}`);
  return control;
}

// ── lifecycle ───────────────────────────────────────────────────────────────────────

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  store().reset();
  resetMetrics();
});

beforeEach(() => {
  store().reset();
  resetMetrics();
  store().setLocale('zh');
});

/** The common scene: one data card `a.csv` and a script card born from it (port `in:0` = A). */
async function baseScene(): Promise<{ a: number; aMatrix: number; cardId: number }> {
  const a = await dataCard('a.csv');
  const cardId = await scriptCardFrom([a]);
  return { a, aMatrix: activeMatrix(a), cardId };
}

describe('opening the picker', () => {
  it('opens from a port row source label, in re-bind mode for that port', async () => {
    const { cardId, aMatrix } = await baseScene();
    const host = await mount(cardId);

    const control = sourceControl(host, 'in:0');
    // The label still reads as the source line it replaced.
    expect(control.textContent).toContain('a.csv');
    expect(control.getAttribute('aria-label')).toContain('选择来源');

    await click(control);

    const body = picker();
    expect(body).not.toBeNull();
    expect(body!.dataset.mode).toBe('rebind');
    expect(body!.dataset.rebindPort).toBe('in:0');
    // The heading names the variable, so "which port am I re-binding" needs no guessing.
    expect(body!.querySelector('.source-picker__title')?.textContent).toContain('A');
    expect(rowForMatrix(aMatrix)).toBeDefined();
  });

  it('opens from + 端口 in add mode — and is NOT disabled on a card with 0 ports', async () => {
    const { cardId } = await baseScene();
    // A 0-port card is a legal declaration (M1): the first port can still be declared.
    expect(store().removeScriptInput(cardId, 'in:0')).toBe(true);
    await flush();
    const host = await mount(cardId);

    const add = addPortButton(host);
    expect(add.disabled).toBe(false);
    expect(host.querySelector('.script-card__panel-empty')?.textContent).toContain('没有输入端口');

    await click(add);

    const body = picker();
    expect(body).not.toBeNull();
    expect(body!.dataset.mode).toBe('add');
    // Add mode is not re-binding anything.
    expect(body!.dataset.rebindPort).toBeUndefined();
  });
});

describe('what it lists', () => {
  it('groups every publishable matrix by its source card', async () => {
    const { cardId } = await baseScene();
    const b = await dataCard('b.csv');
    // A second script card publishes an output slot: a function card contributes a group.
    const other = await scriptCardFrom([b]);
    const host = await mount(cardId);
    await click(addPortButton(host));

    const titles = groupTitles();
    // Four cards publish: the two data cards, the sibling function card — and this card
    // itself, whose own output is listed (greyed) rather than hidden.
    expect(titles).toHaveLength(4);
    expect(titles).toContain(`卡片 #${b}`);
    expect(titles).toContain(`卡片 #${other}`);
    expect(titles).toContain(`卡片 #${cardId}`);
    // Rows: the two files by name, the function card's output by its declared name.
    const labels = rowLabels();
    expect(labels).toContain('a.csv');
    expect(labels).toContain('b.csv');
    expect(labels).toContain('result');
    // The picker enumerates the WORKSPACE, not only what this card already reads
    // (b.csv and the sibling card's output have no edge to it) — that is the documented
    // difference from ColumnDock. The only greyed row is this card's own output.
    expect(pickerRows().filter((row) => row.dataset.refusal === undefined)).toHaveLength(3);
    expect(pickerRows().filter((row) => row.disabled)).toHaveLength(1);
  });

  it('marks a matrix another port already reads, and still lets it be picked', async () => {
    const { cardId, aMatrix } = await baseScene();
    // A second port on the SAME table: two variables over one file is allowed.
    expect(
      store().addScriptInput(cardId, {
        type: 'matrix',
        cardId: store().cards[0].id,
        matrixId: aMatrix,
      }),
    ).toBe('in:1');
    await flush();
    const host = await mount(cardId);
    await click(addPortButton(host));

    const row = rowForMatrix(aMatrix);
    expect(row.dataset.boundAs).toBe('A');
    expect(row.textContent).toContain('已绑定为 A');
    expect(row.disabled).toBe(false);
  });

  it('marks an output no run has computed, and still lets it be picked', async () => {
    const { cardId } = await baseScene();
    const b = await dataCard('b.csv');
    const other = await scriptCardFrom([b]);
    // A slot with no server-side matrix: what a card born offline (or restored from a
    // snapshot) looks like. `publishedMatrices` still publishes it, because a dependent can
    // already be pointing at it.
    act(() => {
      useWorkspace.setState((state) => ({
        cards: state.cards.map((entry) =>
          entry.id === other && isScriptCard(entry)
            ? {
                ...entry,
                outputs: entry.outputs.map((output) => ({ ...output, resultMatrixId: -1 })),
              }
            : entry,
        ),
      }));
    });
    const host = await mount(cardId);
    await click(addPortButton(host));

    const outputRow = pickerRows().find((row) => Number(row.dataset.ownerId) === other)!;
    expect(outputRow.dataset.uncomputed).toBe('true');
    expect(outputRow.textContent).toContain('尚未计算');
    expect(outputRow.disabled).toBe(false);
  });

  it('greys the card’s own output and never calls the store for it', async () => {
    const { cardId } = await baseScene();
    const host = await mount(cardId);
    await click(addPortButton(host));

    const own = pickerRows().find((row) => Number(row.dataset.ownerId) === cardId)!;
    expect(own.dataset.refusal).toBe('self');
    expect(own.disabled).toBe(true);
    expect(own.textContent).toContain('本卡自己的输出');

    const before = card(cardId);
    await forceClick(own);

    // Nothing was declared, and the popup is still open: the pick was never a pick.
    expect(card(cardId).inputs).toHaveLength(before.inputs.length);
    expect(card(cardId).params.portNames).toEqual(before.params.portNames);
    expect(picker()).not.toBeNull();
  });

  it('greys a downstream card (a would-be cycle) and never calls the store', async () => {
    const { cardId } = await baseScene();
    // Born from THIS card's output: it sits downstream, so reading it back would close a ring.
    const downstream = await scriptCardFrom([{ cardId, outputId: 'out:0' }]);
    expect(store().dependencies.findDownstreamPath(downstream, cardId)).not.toBeNull();

    const host = await mount(cardId);
    await click(addPortButton(host));

    const row = pickerRows().find((entry) => Number(entry.dataset.ownerId) === downstream)!;
    expect(row.dataset.refusal).toBe('downstream');
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain('会成环');

    const before = card(cardId);
    const edgesBefore = store().dependencies.edgeCount();
    await forceClick(row);

    expect(card(cardId).inputs).toHaveLength(before.inputs.length);
    expect(card(cardId).params.portNames).toEqual(before.params.portNames);
    expect(store().dependencies.edgeCount()).toBe(edgesBefore);
    expect(picker()).not.toBeNull();
  });

  it('says so in English when the locale is English', async () => {
    const { cardId } = await baseScene();
    store().setLocale('en');
    await flush();
    const host = await mount(cardId);

    await click(sourceControl(host, 'in:0'));

    expect(picker()!.querySelector('.source-picker__title')?.textContent).toBe('Re-bind port A');
    expect(sourceControl(host, 'in:0').getAttribute('aria-label')).toBe('Choose the source A');
    // The refusal reason is translated too — it is a sentence, not a symbol.
    expect(document.body.textContent).toContain('This card’s own output');
  });
});

describe('picking', () => {
  it('add appends one port, the next free name, and one edge', async () => {
    const { cardId } = await baseScene();
    const b = await dataCard('b.csv');
    const bMatrix = activeMatrix(b);
    const host = await mount(cardId);

    expect(card(cardId).params.portNames).toEqual(['A']);
    await click(addPortButton(host));
    await click(rowForMatrix(bMatrix));

    const after = card(cardId);
    expect(after.inputs.map((input) => input.portId)).toEqual(['in:0', 'in:1']);
    expect(after.inputs[1].target).toEqual({ type: 'matrix', cardId: b, matrixId: bMatrix });
    // A fresh letter, not a second name for numbers the card already has.
    expect(after.params.portNames).toEqual(['A', 'B']);
    // The edge travels with the port: one pair, one line, this port id on it.
    expect(store().dependencies.getPorts(cardId, b)).toEqual(['in:1']);
    expect(store().dependencies.getDependents(b)).toEqual([cardId]);
    // The script text is the user's: declaring a port does not touch it.
    expect(after.params.script).toBe(card(cardId).params.script);
    // A pick is also a dismissal.
    expect(picker()).toBeNull();
    // And the new row is on screen.
    expect(host.querySelector('[data-port-id="in:1"]')).not.toBeNull();
  });

  it('lets a 0-port card gain its first port through + 端口', async () => {
    const { cardId, a, aMatrix } = await baseScene();
    expect(store().removeScriptInput(cardId, 'in:0')).toBe(true);
    await flush();
    const host = await mount(cardId);
    expect(card(cardId).inputs).toHaveLength(0);

    await click(addPortButton(host));
    await click(rowForMatrix(aMatrix));

    const after = card(cardId);
    expect(after.inputs.map((input) => input.portId)).toEqual(['in:0']);
    expect(after.params.portNames).toEqual(['A']);
    expect(store().dependencies.getPorts(cardId, a)).toEqual(['in:0']);
  });

  it('re-bind keeps the port id and the name and moves only the source', async () => {
    const { cardId, a } = await baseScene();
    const b = await dataCard('b.csv');
    const bMatrix = activeMatrix(b);
    const host = await mount(cardId);
    const scriptBefore = card(cardId).params.script;

    await click(sourceControl(host, 'in:0'));
    await click(rowForMatrix(bMatrix));

    const after = card(cardId);
    // Identity is the port's; only its attachment moved (决策 §二).
    expect(after.inputs.map((input) => input.portId)).toEqual(['in:0']);
    expect(after.params.portNames).toEqual(['A']);
    expect(after.inputs[0].target).toEqual({ type: 'matrix', cardId: b, matrixId: bMatrix });
    // Byte-identical: a re-bind is a data change, never a declaration edit.
    expect(after.params.script).toBe(scriptBefore);
    // Old edge lost this port (and this port was its only one on `a`).
    expect(store().dependencies.getPorts(cardId, a)).toEqual([]);
    expect(store().dependencies.getDependents(a)).toEqual([]);
    // New edge gained it.
    expect(store().dependencies.getPorts(cardId, b)).toEqual(['in:0']);
    expect(picker()).toBeNull();
    // The row now names the new file.
    expect(sourceControl(host, 'in:0').textContent).toContain('b.csv');
  });

  it('leaves nothing behind when the popup is dismissed', async () => {
    const { cardId } = await baseScene();
    const b = await dataCard('b.csv');
    const host = await mount(cardId);
    const edgesBefore = store().dependencies.edgeCount();

    await click(addPortButton(host));
    expect(picker()).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await flush();

    expect(picker()).toBeNull();
    expect(card(cardId).inputs).toHaveLength(1);
    expect(card(cardId).params.portNames).toEqual(['A']);
    expect(store().dependencies.edgeCount()).toBe(edgesBefore);
    expect(store().cards.some((entry) => entry.id === b)).toBe(true);
  });
});

describe('removal and the name-reuse warning', () => {
  it('the ✕ hints how many references it leaves behind, then removes the port', async () => {
    const { cardId } = await baseScene();
    const host = await mount(cardId);

    // The birth template names A once (`result = A * 1.0`); the comment is not a reference.
    const hint = host.querySelector('.script-card__row .script-card__refs');
    expect(hint?.textContent).toBe('脚本里还有 1 处引用');

    const remove = host.querySelector<HTMLButtonElement>('[data-port-remove="in:0"]')!;
    expect(remove.disabled).toBe(false);
    expect(remove.title).toContain('脚本里还有 1 处引用');

    await click(remove);

    expect(card(cardId).inputs).toHaveLength(0);
    expect(card(cardId).params.portNames).toEqual([]);
    // Removed is removed: the row is gone, and the panel says the card has no ports.
    expect(host.querySelector('[data-port-id="in:0"]')).toBeNull();
    expect(host.querySelector('.script-card__panel-empty')?.textContent).toContain('没有输入端口');
    // The script is NOT rewritten — that is the point of the hint (ruling #3).
    expect(card(cardId).params.script).toContain('result = A * 1.0');
  });

  it('warns when the name the next add would take is still named by the script', async () => {
    const { cardId } = await baseScene();
    const b = await dataCard('b.csv');
    // The script names B while a port B exists…
    store().setScriptText(cardId, 'result = A + B\n');
    expect(
      store().addScriptInput(cardId, { type: 'matrix', cardId: b, matrixId: activeMatrix(b) }),
    ).toBe('in:1');
    await flush();
    // …then B is removed, freeing the NAME while the reference stays behind (M1 finding f).
    expect(store().removeScriptInput(cardId, 'in:1')).toBe(true);
    await flush();
    const host = await mount(cardId);

    await click(addPortButton(host));

    const warning = document.querySelector('.source-picker__warning');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain('B');
    expect(warning!.textContent).toContain('1');
    // A hint, never a block: the pick still lands, and the freed name is handed out again.
    await click(rowForMatrix(activeMatrix(b)));
    expect(card(cardId).params.portNames).toEqual(['A', 'B']);
  });
});

describe('wiring seams', () => {
  it('gives every port row a data-port-id and keeps its anchor registered', async () => {
    const { cardId } = await baseScene();
    const host = await mount(cardId);

    const head = host.querySelector<HTMLElement>('[data-port-id="in:0"]');
    expect(head).not.toBeNull();
    // The element the gesture hit-tests is the element the wire anchors on.
    expect(head!.className).toContain('script-card__row-head');
    expect(portAnchor(cardId, 'in:0')?.side).toBe('left');
  });
});