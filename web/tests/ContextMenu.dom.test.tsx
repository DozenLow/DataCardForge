/**
 * @vitest-environment jsdom
 *
 * The shared right-click menu primitives (`ContextMenu.tsx`).
 *
 * Why these tests exist: the same nine chart types used to be copied into three menus, so
 * the "how many columns remain?" rule, the greying and the toast were three independent
 * implementations that could disagree. They now come from one place, and this file is what
 * keeps that place honest:
 *   - a second-level menu really is a second menu (two popups, nested dismissal);
 *   - a click inside the submenu must NOT dismiss its parent first — a real browser
 *     dispatches `mousedown` before `click`, and dismissing the parent would tear the
 *     submenu out of the DOM before the click could land on it;
 *   - the chart list offers exactly `CHART_TYPE_ORDER`, gates each type on the columns it
 *     needs, and emits one toast that says whether the chart was built or why it was not.
 */
import { StrictMode, act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHART_TYPE_ORDER, chartTypeDef, minimumColumns } from '../src/charts/chartTypes.ts';
import { createTranslator } from '../src/ui/i18n.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  ChartTypeItems,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSub,
} from '../src/ui/components/ContextMenu.tsx';

/**
 * The one transport instance the store creates at import time.
 *
 * The store builds a `BackendClient` when it is imported, so the transport is replaced before
 * any test renders anything; `vi.hoisted` is the only scope the mock factory can see.
 */
const client = vi.hoisted(() => {
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
    window: vi.fn(async () => ({ ok: false, code: 'notFound' })),
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
const roots: ReturnType<typeof createRoot>[] = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Mount one element into its own host and return the host. */
async function mount(element: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<StrictMode>{element}</StrictMode>);
  });
  await flush();
  return host;
}

/** Every open menu, in document order; the submenu is the last one. */
const menus = () => [...document.querySelectorAll<HTMLElement>('.context-menu')];

const itemsIn = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLButtonElement>('.context-menu__item')];

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

/**
 * A menu shaped like the real ones: one submenu entry, then a plain entry.
 *
 * `onPick` records what the submenu's entries fire, and the parent stays mounted until
 * something dismisses it — which is the interaction being tested.
 */
function MenuHarness({ onPick }: { onPick: (label: string) => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <ContextMenu x={12} y={16} title="Pos.1" onDismiss={() => setOpen(false)}>
      <ContextMenuSub label="绘制图表">
        <ContextMenuItem onClick={() => onPick('line')}>折线图</ContextMenuItem>
        <ContextMenuItem onClick={() => onPick('bar')}>柱状图</ContextMenuItem>
      </ContextMenuSub>
      <div className="context-menu__separator" />
      <ContextMenuItem onClick={() => onPick('formula')}>新建公式卡…</ContextMenuItem>
    </ContextMenu>
  );
}

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  client.served.clear();
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

describe('ContextMenuSub', () => {
  it('labels its first-level entry and opens a second menu on click', async () => {
    const picked: string[] = [];
    await mount(<MenuHarness onPick={(label) => picked.push(label)} />);

    // The title names where the menu came from; the submenu entry is a leaf of level one.
    expect(document.querySelector('.context-menu__title')?.textContent).toBe('Pos.1');
    expect(menus()).toHaveLength(1);

    const toggle = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain('绘制图表');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await click(toggle);

    // Two menus on screen, and the entry now says it is open.
    expect(menus()).toHaveLength(2);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const submenu = menus()[1];
    const [line] = itemsIn(submenu);
    expect(line.textContent).toBe('折线图');

    await click(line);
    expect(picked).toEqual(['line']);
    // Picking a sub-entry fires its own action; closing the menu is the caller's job, so
    // the menu is still on screen here.
    expect(menus()).toHaveLength(2);

    // A second click on the entry collapses it again.
    await click(toggle);
    expect(menus()).toHaveLength(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on hover, and the click that follows confirms instead of collapsing', async () => {
    await mount(<MenuHarness onPick={() => {}} />);
    const toggle = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;

    // Hover is the cheap gesture: a submenu is a detail, not a destination.
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await flush();
    expect(menus()).toHaveLength(2);

    // Clicking the entry the pointer just revealed must not fold it away again; a click on
    // an already-open submenu is a confirmation, and the second click is the real toggle.
    await click(toggle);
    expect(menus()).toHaveLength(2);
    await click(toggle);
    expect(menus()).toHaveLength(1);
  });

  it('keeps the parent menu open when the pointer goes down inside the submenu', async () => {
    await mount(<MenuHarness onPick={() => {}} />);
    const toggle = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    await click(toggle);
    expect(menus()).toHaveLength(2);

    const [line] = itemsIn(menus()[1]);
    // A real browser sends `mousedown` before `click`. If it reached the parent's
    // outside-click listener, the whole menu (submenu included) would unmount first and the
    // click would land on a detached button — a menu that looks interactive and is not.
    await act(async () => {
      line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(menus()).toHaveLength(2);
    expect(itemsIn(menus()[1])[0].textContent).toBe('折线图');
  });
});

describe('ChartTypeItems', () => {
  const CHART_ITEM_SELECTOR = '.context-menu__item';

  const chartItems = () =>
    [...document.querySelectorAll<HTMLButtonElement>(CHART_ITEM_SELECTOR)];

  it('offers every type in order and gates each on the columns it needs', async () => {
    // One column left: the pair-based types (scatter / regression / heatmap) cannot draw.
    await mount(<ChartTypeItems remaining={1} columnLabel="Pos.1" onPick={() => 42} />);

    const items = chartItems();
    expect(items).toHaveLength(CHART_TYPE_ORDER.length);
    expect(items.map((item) => item.textContent)).toEqual(
      CHART_TYPE_ORDER.map((id) => zh(chartTypeDef(id).labelKey)),
    );

    for (const [index, id] of CHART_TYPE_ORDER.entries()) {
      const def = chartTypeDef(id);
      const enough = minimumColumns(id) <= 1;
      expect(items[index].disabled).toBe(!enough);
      if (enough) {
        expect(items[index].disabled).toBe(false);
        expect(items[index].title).toBe(zh(def.hintKey));
      } else {
        // The tooltip is the rule itself, not "disabled".
        expect(items[index].title).toContain('需要');
        expect(items[index].title).toContain(zh(def.labelKey));
      }
    }
  });

  it('builds the picked type and reports it with the column name', async () => {
    const picked: string[] = [];
    await mount(
      <ChartTypeItems
        remaining={2}
        columnLabel="Pos.1"
        onPick={(type) => {
          picked.push(type);
          return 99;
        }}
      />,
    );
    store().clearToast();

    const line = chartItems().find(
      (item) => item.textContent === zh(chartTypeDef('line').labelKey),
    )!;
    await click(line);

    expect(picked).toEqual(['line']);
    expect(store().toast?.kind).toBe('info');
    expect(store().toast?.message).toBe(zh('status.chartCreated', { name: 'Pos.1' }));
  });

  it('explains a refused creation with the width the type needed', async () => {
    // The store can still say no after the menu allowed the click (e.g. the slot a run just
    // produced is one round trip behind). The menu must not close on a dead click.
    await mount(<ChartTypeItems remaining={2} columnLabel="Pos.1" onPick={() => null} />);
    store().clearToast();

    const scatterDef = chartTypeDef('scatter');
    const scatter = chartItems().find(
      (item) => item.textContent === zh(scatterDef.labelKey),
    )!;
    expect(scatter.disabled).toBe(false);
    await click(scatter);

    expect(store().toast?.kind).toBe('error');
    expect(store().toast?.message).toBe(
      zh('status.needTrailingColumns', {
        type: zh(scatterDef.labelKey),
        n: minimumColumns('scatter'),
        have: 2,
      }),
    );
  });
});