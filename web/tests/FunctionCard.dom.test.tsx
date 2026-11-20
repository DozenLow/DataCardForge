/**
 * @vitest-environment jsdom
 *
 * Function card, three-zone layout (README 函数卡 UI).
 *
 * These assertions lock the structure the function-card review settled on, because each
 * zone carries a decision rather than decoration:
 *   - the **input** zone names the explicit matrix the card reads (the thing that used to
 *     be implicit and silently changed when a table switched files);
 *   - the **formula** zone is the parameter bag (one row per expression);
 *   - the **output** zone lists the signature's declared outputs and the result grid;
 *   - an `upstreamError` is shown as *invalidated* (grey) rather than as this card's own
 *     definition error (red), and it still says something — never a silent blank.
 */
import { StrictMode, act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { portAnchor } from '../src/ui/cardMetrics.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import { FormulaCard, type ResolvedInput } from '../src/ui/components/FormulaCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(columns: number, rows = 4): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, Array.from({ length: rows }, (_, r) => r + c));
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

interface CardOptions {
  inputs?: ResolvedInput[];
  resultMatrix?: MatrixData;
  sourceColumnNames?: string[];
  onRenameOutputColumn?: (index: number, name: string) => void;
  onSetColumnContract?: (columns: number | null) => void;
  onOpenChart?: (columnIndex: number, type: string) => number | null;
  onOpenFunction?: () => void;
}

async function mount(card: FunctionCardModel, options: CardOptions = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <FormulaCard
          card={card}
          resultMatrix={options.resultMatrix}
          sourceColumnNames={options.sourceColumnNames ?? []}
          inputs={options.inputs ?? []}
          onRenameOutputColumn={options.onRenameOutputColumn ?? (() => {})}
          onSetColumnContract={options.onSetColumnContract ?? (() => {})}
          onOpenChart={options.onOpenChart ?? (() => null)}
          onOpenFunction={options.onOpenFunction ?? (() => {})}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

/** Create a real function card through the store (offline: no node is registered). */
function makeCard(overrides: Partial<FunctionCardModel> = {}): FunctionCardModel {
  const matrixCardId = store().addMatrixCard([{ name: 'b.csv', matrix: matrix(3) }]);
  const cardId = store().addFormulaCard(matrixCardId);
  expect(cardId).not.toBeNull();
  const card = store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
  return { ...card, ...overrides };
}

beforeEach(() => {
  store().reset();
  // jsdom's navigator.language is en-US, so pin the locale the assertions read.
  store().setLocale('zh');
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

/**
 * The menu a submenu is NOT: `Popup` appends the second-level list after its parent, so the
 * last `.context-menu--list` in the document is the one a submenu opened.
 */
function lastMenu(): HTMLElement {
  const menus = [...document.querySelectorAll<HTMLElement>('.context-menu--list')];
  return menus[menus.length - 1];
}

/**
 * Open the "绘制图表" submenu of the header menu on screen and return it.
 *
 * The nine chart types live one level down since they all produce the same kind of output;
 * level one is reserved for gestures that create *different* things.
 */
async function openChartSubmenu(): Promise<HTMLElement> {
  const sub = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
    (button) => button.textContent?.includes('绘制图表'),
  );
  expect(sub).toBeDefined();
  await act(async () => {
    sub!.click();
  });
  return lastMenu();
}

/** Dispatch a right-click on one element, the gesture that opens these menus. */
async function rightClick(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 160 }),
    );
  });
}

describe('function card zones', () => {
  it('renders the three zones', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    expect(host.querySelector('.formula-card__inputs')).not.toBeNull();
    expect(host.querySelector('.formula-card__formulas')).not.toBeNull();
    expect(host.querySelector('.formula-card__outputs')).not.toBeNull();
    // The zone titles are real labels, not placeholder text.
    expect(host.querySelector('.formula-card__inputs')?.textContent).toContain('输入');
    expect(host.querySelector('.formula-card__formulas')?.textContent).toContain('计算公式');
    expect(host.querySelector('.formula-card__outputs')?.textContent).toContain('输出');
  });

  it('lays the card out in three columns with the result grid in the middle', async () => {
    const host = await mount(makeCard(), {
      resultMatrix: matrix(3),
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    const zones = host.querySelector('.formula-card__zones')!;
    // The side panels carry their card class next to the shared `side-panel` ones.
    const names = ['formula-card__inputs', 'formula-card__main', 'formula-card__outputs'];
    const columns = [...zones.children]
      .map((child) => names.find((name) => child.classList.contains(name)))
      .filter((name): name is string => name !== undefined);
    expect(columns).toEqual([
      'formula-card__inputs',
      'formula-card__main',
      'formula-card__outputs',
    ]);
    // Expressions above the result grid, both in the middle column.
    const main = host.querySelector('.formula-card__main')!;
    expect([...main.children].map((child) => child.className.split(' ')[0])).toEqual([
      'formula-card__formulas',
      'formula-card__result',
    ]);
    expect(host.querySelector('.formula-card__result .formula-card__grid')).not.toBeNull();
  });

  it('folds the inputs into a rail that keeps the port registered', async () => {
    const host = await mount(makeCard({ inputsPanelOpen: false }), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    const rail = host.querySelector<HTMLElement>('.formula-card__inputs[data-open="false"]');
    expect(rail).not.toBeNull();
    const chip = rail!.querySelector<HTMLElement>('.rail-port');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('src');

    // The folded chip is the endpoint, exactly like the script card's rail.
    const root = host.querySelector<HTMLElement>('.card--formula')!;
    const stub = (element: HTMLElement, r: { left: number; top: number; width: number; height: number }) => {
      element.getBoundingClientRect = () =>
        ({
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          right: r.left + r.width,
          bottom: r.top + r.height,
          x: r.left,
          y: r.top,
          toJSON: () => ({}),
        }) as DOMRect;
    };
    stub(root, { left: 100, top: 100, width: 760, height: 520 });
    stub(chip!, { left: 104, top: 200, width: 26, height: 60 });
    expect(portAnchor(Number(root.getAttribute('data-card-id')), 'src')).toEqual({
      x: 104,
      y: 230,
      side: 'left',
    });
  });

  it('names the explicit matrix an input reads, with its shape', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    const port = host.querySelector('.formula-card__port')!;
    expect(port.textContent).toContain('src');
    expect(port.textContent).toContain('b.csv');
    expect(port.textContent).toContain('4×3');
    // Matrix mode is stated, never inferred from colour.
    expect(port.querySelector('.formula-card__mode--matrix')?.textContent).toBe('矩阵');
  });

  it('shows a dangling reference as broken instead of silently reading nothing', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: '#99', rows: 0, cols: 0, missing: true },
      ],
    });
    const port = host.querySelector('.formula-card__port')!;
    expect(port.textContent).toContain('引用的矩阵已不存在');
    expect(port.querySelector('.formula-card__port-src--missing')).not.toBeNull();
  });

  it('explains the empty input zone instead of drawing an empty rail', async () => {
    const host = await mount(makeCard({ inputs: [] }), { inputs: [] });
    expect(host.querySelector('.formula-card__zone-empty')?.textContent).toContain('未连接数据源');
  });

  it('lists one formula row per expression (the parameter bag)', async () => {
    const card = makeCard({
      params: {
        formulas: [
          { name: 'double', expression: 'A * 2' },
          { name: 'sum', expression: 'A + B' },
        ],
      },
    });
    const host = await mount(card);
    const rows = host.querySelectorAll('.formula-card__row');
    expect(rows).toHaveLength(2);
    const names = [...host.querySelectorAll<HTMLInputElement>('.formula-card__name')].map(
      (input) => input.value,
    );
    expect(names).toEqual(['double', 'sum']);
    const exprs = [...host.querySelectorAll<HTMLInputElement>('.formula-card__expr')].map(
      (input) => input.value,
    );
    expect(exprs).toEqual(['A * 2', 'A + B']);
  });

  it('lists the declared outputs and the result shape', async () => {
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 5),
    });
    const output = host.querySelector('.formula-card__output-item')!;
    expect(output.textContent).toContain('结果');
    expect(output.textContent).toContain('2 列 × 5 行');
    expect(host.querySelector('.formula-card__output-shape')?.textContent).toContain('2 列 × 5 行');
  });

  it('renders a structured error through i18n, never a bare code', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'unknownColumn', params: { name: 'ZZ' } } }),
    );
    const alert = host.querySelector('.formula-card__error')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('未知列名');
    // The four-state light is red only for this card's OWN failure.
    expect(host.querySelector('.node-light--error')).not.toBeNull();
  });

  it('presents an upstream failure as invalidated (grey), not as its own error', async () => {
    const host = await mount(
      makeCard({
        node: { nodeId: 4, state: 'error', code: 'upstreamError', params: { name: 'n1' } },
      }),
    );
    // Grey/invalidated light instead of red…
    expect(host.querySelector('.node-light--stale')).not.toBeNull();
    expect(host.querySelector('.node-light--error')).toBeNull();
    // …and the reason is stated in words.
    expect(host.querySelector('.formula-card__stale')?.textContent).toContain('上游卡片失败');
  });

  it('falls back to a visible sentence + raw code for an unknown code', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'someBrandNewCode' } }),
    );
    const alert = host.querySelector('.formula-card__error')!;
    expect(alert.textContent).toContain('公式无法计算');
    expect(alert.textContent).toContain('someBrandNewCode');
  });
});

describe('output rename + column contract', () => {
  it('opens the rename editor from the output header and shows the lock hint bar', async () => {
    const host = await mount(makeCard());
    const toggle = host.querySelector<HTMLButtonElement>('.formula-card__rename')!;
    expect(toggle.textContent).toBe('重命名列');
    await act(async () => {
      toggle.click();
    });
    const inputs = host.querySelectorAll('.formula-card__rename-input');
    expect(inputs).toHaveLength(1);
    // The bottom bar states that naming locks the width — the promise is visible.
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('命名输出列后即锁定');
  });

  it('commits a rename on blur (the first commit creates the contract)', async () => {
    let renamed: { index: number; name: string } | null = null;
    const card = makeCard();
    const host = await mount(card, {
      onRenameOutputColumn: (index, name) => {
        renamed = { index, name };
      },
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.formula-card__rename')!.click();
    });
    const input = host.querySelector<HTMLInputElement>('.formula-card__rename-input')!;
    await act(async () => {
      input.focus();
      // React's onChange listens for `input`; the commit happens on blur (focusout).
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'temperature');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
    expect(renamed).toEqual({ index: 0, name: 'temperature' });
  });

  it('states the locked width once a contract exists', async () => {
    const host = await mount(
      makeCard({
        params: {
          formulas: [{ name: 'a', expression: 'A * 2' }],
          columnContract: { outputId: 'result', columns: 1 },
        },
      }),
    );
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar.textContent).toContain('已锁定 1 列');
    expect(bar.textContent).toContain('中断数据流');
  });

  it('turns the hint bar into a stop notice on a contract violation, with both ways out', async () => {
    const c = makeCard({
      params: {
        formulas: [
          { name: 'a', expression: 'A * 2' },
          { name: 'b', expression: 'A + 1' },
        ],
        columnContract: { outputId: 'result', columns: 1 },
      },
      node: {
        nodeId: 9,
        state: 'error',
        code: 'columnContractViolation',
        params: { expected: 1, actual: 2 },
      },
    });
    let extended: number | null | undefined;
    const host = await mount(c, {
      onSetColumnContract: (columns) => {
        extended = columns;
      },
    });
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar.className).toContain('hintbar--violation');
    expect(bar.textContent).toContain('列数契约被破坏');
    expect(bar.textContent).toContain('锁定 1 列');
    expect(bar.textContent).toContain('实际 2 列');
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      '扩展契约到 2 列',
      '解除锁定',
    ]);
    await act(async () => {
      buttons[0].click();
    });
    expect(extended).toBe(2);
  });
});

describe('charting from the output table', () => {
  it('offers the chart picker on a result column header', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead');
    expect(header).not.toBeNull();
    await rightClick(header!);

    const menu = document.querySelector('.context-menu--list');
    expect(menu).not.toBeNull();
    // Level one: one entry that opens the chart types, plus the other creation gesture.
    // The nine chart types are not spread across level one — they all produce a chart.
    expect(menu!.textContent).toContain('绘制图表');
    expect(menu!.textContent).not.toContain('折线图');

    const submenu = await openChartSubmenu();
    expect(submenu).not.toBe(menu);
    // Every declared chart type is offered, exactly like a data card's column header.
    expect(submenu.textContent).toContain('折线图');
    expect(submenu.textContent).toContain('相关性热力图');
  });

  it('creates the chart through onOpenChart with the clicked column', async () => {
    const calls: Array<{ column: number; type: string }> = [];
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 4),
      onOpenChart: (column, type) => {
        calls.push({ column, type });
        return 42;
      },
    });
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead');
    await rightClick(header!);
    // Through the submenu: 绘制图表 → 折线图. `items[0]` used to be the line chart itself.
    const submenu = await openChartSubmenu();
    const line = [...submenu.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
      (item) => item.textContent?.trim() === '折线图',
    );
    expect(line).toBeDefined();
    await act(async () => {
      line!.click();
    });
    expect(calls).toEqual([{ column: 0, type: 'line' }]);
  });
});

describe('chaining from the output menu', () => {
  it('offers "new function card" in the result header menu', async () => {
    let chained = 0;
    const host = await mount(makeCard(), {
      resultMatrix: matrix(1, 4),
      onOpenFunction: () => {
        chained += 1;
      },
    });
    await act(async () => {
      host
        .querySelector('.card--formula .vtable__colhead')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
    const chainedItem = items.find((item) => item.textContent?.includes('新建公式卡'));
    expect(chainedItem).toBeDefined();
    await act(async () => {
      chainedItem!.click();
    });
    expect(chained).toBe(1);
  });
});

describe('a signature without expressions', () => {
  const regressionCard = (): FunctionCardModel => ({
    ...makeCard(),
    signatureId: 'builtin:linear-regression',
    params: {},
    outputs: [{ outputId: 'fit', resultMatrixId: 7 }],
    inputs: [
      {
        portId: 'x',
        target: { type: 'cell', cardId: 1, matrixId: 10, column: 0 },
      },
      {
        portId: 'y',
        target: { type: 'cell', cardId: 1, matrixId: 10, column: 1 },
      },
    ],
  });

  it('shows both ports and states that the signature has no parameters', async () => {
    const host = await mount(regressionCard(), {
      inputs: [
        { portId: 'x', mode: 'cell', label: 'X', rows: 4, cols: 1, missing: false },
        { portId: 'y', mode: 'cell', label: 'Y', rows: 4, cols: 1, missing: false },
      ],
      resultMatrix: matrix(5, 1),
    });
    const ports = [...host.querySelectorAll('.formula-card__port-id')].map((p) => p.textContent);
    expect(ports).toEqual(['x', 'y']);
    // No formula editor, and it says what it computes instead of showing an empty box.
    expect(host.querySelectorAll('.formula-card__formula-row')).toHaveLength(0);
    expect(host.textContent).toContain('计算说明');
    expect(host.textContent).toContain('一元线性拟合');
    // The parameter zone is still there — it just carries a statement, not an editor.
    expect(host.querySelector('.formula-card__formulas')).not.toBeNull();
  });

  it('hides the rename entry (a signature-owned output names its own columns)', async () => {
    const host = await mount(regressionCard(), {
      inputs: [{ portId: 'x', mode: 'cell', label: 'X', rows: 4, cols: 1, missing: false }],
      resultMatrix: matrix(5, 1),
    });
    expect(host.querySelector('.formula-card__rename')).toBeNull();
  });
});

describe('an empty result zone says why it is empty', () => {
  it('says the card is not bound instead of claiming there is no expression', async () => {
    const recompute = vi.fn();
    const original = store().recomputeFormula;
    await act(async () => {
      useWorkspace.setState({ recomputeFormula: recompute });
    });
    try {
      const host = await mount(makeCard());
      const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
      expect(empty.textContent).toContain('尚未绑定后端计算节点');
      // The old copy blamed a missing expression even though one was already there.
      expect(empty.textContent).not.toContain('输入表达式');
      const button = empty.querySelector<HTMLButtonElement>('button')!;
      await act(async () => {
        button.click();
      });
      expect(recompute).toHaveBeenCalled();
    } finally {
      await act(async () => {
        useWorkspace.setState({ recomputeFormula: original });
      });
    }
  });

  it('does not offer a retry when the node computed an empty table', async () => {
    const host = await mount(makeCard({ node: { nodeId: 7, state: 'done' } }), {
      resultMatrix: new MatrixData(),
    });
    const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
    expect(empty.textContent).toContain('暂无结果');
    expect(empty.querySelector('button')).toBeNull();
  });

  it('points at the message above when the node failed', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'unknownColumn', params: { name: 'ZZ' } } }),
    );
    const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
    expect(empty.textContent).toContain('计算失败');
    expect(host.querySelector('.formula-card__error')).not.toBeNull();
  });
});

describe('the result-column menu explains a single-column table', () => {
  // The rule and the greyed-out types live in the "绘制图表" submenu now, so this helper
  // walks all the way in: right-click the header → 绘制图表 → the chart list.
  const openMenu = async (host: HTMLElement) => {
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead')!;
    await rightClick(header);
    return openChartSubmenu();
  };
  const item = (menu: HTMLElement, label: string) =>
    [...menu.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
      (button) => button.textContent?.trim() === label,
    )!;

  it('greys out the pair-based types and states the rule', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(1, 4) });
    const menu = await openMenu(host);
    expect(item(menu, '散点图').disabled).toBe(true);
    expect(item(menu, '回归图').disabled).toBe(true);
    expect(item(menu, '相关性热力图').disabled).toBe(true);
    expect(item(menu, '折线图').disabled).toBe(false);
    expect(menu.querySelector('.context-menu__hint')?.textContent).toContain('只剩 1 列');
  });

  it('surfaces a refused chart creation instead of closing silently', async () => {
    // onOpenChart returns null when the store refuses (e.g. the type needs more trailing
    // columns than the table has). The menu used to just close, which read as a dead click.
    store().clearToast();
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 4),
      onOpenChart: () => null,
    });
    const menu = await openMenu(host);
    const line = [...menu.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
      (button) => button.textContent?.trim() === '折线图',
    )!;
    await act(async () => {
      line.click();
    });
    const toast = store().toast;
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('折线图');
    expect(document.querySelector('.context-menu--list')).toBeNull();
  });

  it('drops the hint once two columns are available', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const menu = await openMenu(host);
    expect(menu.querySelector('.context-menu__hint')).toBeNull();
    expect(item(menu, '散点图').disabled).toBe(false);
  });

  it('closes instead of throwing when a recompute shrinks the result under it', async () => {
    const card = makeCard();
    let shrink: (next: MatrixData) => void = () => {};
    function Harness() {
      const [result, update] = useState<MatrixData>(matrix(1, 4));
      shrink = update;
      return (
        <FormulaCard
          card={card}
          resultMatrix={result}
          sourceColumnNames={[]}
          inputs={[]}
          onRenameOutputColumn={() => {}}
          onSetColumnContract={() => {}}
          onOpenChart={() => 42}
          onOpenFunction={() => {}}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      );
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    const header = host.querySelector<HTMLElement>('.vtable__colhead')!;
    await act(async () => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 160 }));
    });
    expect(document.querySelector('.context-menu--list')).not.toBeNull();
    await act(async () => {
      shrink(new MatrixData());
    });
    expect(document.querySelector('.context-menu--list')).toBeNull();
  });
});

describe('a header right-click stays inside the card', () => {
  it('does not reach the surrounding canvas surface', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const spy = vi.fn();
    document.addEventListener('contextmenu', spy);
    try {
      await act(async () => {
        host
          .querySelector('.vtable__colhead')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('contextmenu', spy);
    }
  });
});

/**
 * 结果预览（2026-10-29 决策）：默认只同步前 100 行，表格下方说明「显示前 N / 共 M 行」，
 * 并提供显式动作拉全量。这两点是"慢"的修复本身，不是装饰——165 000 行的结果默认拉全表时
 * 是 34 次往返，用户看到的是几秒钟的白屏。
 */
describe('result preview', () => {
  const previewCard = () =>
    makeCard({ result: { totalRows: 165_000, shownRows: 100, complete: false, truncated: false } });

  it('says how much of the result is shown and offers the full table', async () => {
    const host = await mount(previewCard(), { resultMatrix: matrix(1, 100) });
    const strip = host.querySelector('.formula-card__result-more');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('显示前 100 行');
    expect(strip!.textContent).toContain('165000');
    expect(strip!.querySelector('.formula-card__show-more')!.textContent).toBe('显示更多');
  });

  it('reports the stored height, not the cache height, in the output shape', async () => {
    const host = await mount(previewCard(), { resultMatrix: matrix(1, 100) });
    // 1 column × 165 000 rows — the cache only holds 100 of them.
    expect(host.querySelector('.formula-card__output-shape')!.textContent).toContain('165000');
  });

  it('drops the preview strip once the whole table is cached', async () => {
    const card = makeCard({
      result: { totalRows: 100, shownRows: 100, complete: true, truncated: false },
    });
    const host = await mount(card, { resultMatrix: matrix(1, 100) });
    expect(host.querySelector('.formula-card__result-more')).toBeNull();
  });
});

/**
 * The relation-enumeration card is the one signature that is NOT expression-shaped. Its
 * "parameter area" is an explanation, its row axis names the relationship, and its inputs
 * are re-bindable from the card — three things the generic formula card never had to show.
 */
describe('relation-enumeration card', () => {
  function relationSetup() {
    const source = new MatrixData();
    source.appendColumn('Pos.1', [1, 2, 3, 4]);
    source.appendColumn('Pos.2', [2, 4, 6, 8]);
    source.appendColumn('Pos.3', [0, 0, 0, 0]);
    source.setColumnAnnotation(0, '滑油压力_MPa');
    source.setColumnAnnotation(1, '推力_kN');
    source.setColumnAnnotation(2, '温度_C');
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: source }]);
    const cardId = store().addRelationEnumCard(matrixCardId, 0)!;
    const card = store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;

    // The backend's result: one row, five columns whose annotations are the stable slugs.
    const result = new MatrixData();
    const names = ['slope', 'intercept', 'r', 'r2', 'n'];
    const values = [[-3.5], [45.6], [-0.01], [0.0001], [4]];
    names.forEach((name, index) => {
      result.appendColumn(`Pos.${index + 1}`, values[index]);
      result.setColumnAnnotation(index, name);
    });

    const columns = ['滑油压力_MPa', '推力_kN', '温度_C'];
    const inputs: ResolvedInput[] = [
      {
        portId: 'x',
        mode: 'cell',
        label: 'a.csv · 滑油压力_MPa',
        column: 0,
        columns,
        rows: 4,
        cols: 3,
        missing: false,
      },
      {
        portId: 'y',
        mode: 'cell',
        label: 'a.csv · 推力_kN',
        column: 1,
        columns,
        rows: 4,
        cols: 3,
        missing: false,
      },
    ];
    return { card, inputs, result };
  }

  it('explains what it computes instead of showing an empty expression editor', async () => {
    const { card, inputs } = relationSetup();
    const host = await mount(card, { inputs });
    const zone = host.querySelector('.formula-card__formulas')!;
    expect(zone.textContent).toContain('计算说明');
    expect(zone.textContent).toContain('一元线性拟合');
    expect(zone.textContent).toContain('决定系数 R²');
    // No expression input and no "add formula column": the signature has no expressions,
    // and a control that edits nothing is worse than no control.
    expect(zone.querySelectorAll('input').length).toBe(0);
    expect(zone.querySelector('.formula-card__add')).toBeNull();
  });

  it('names the relationship on the row axis and the statistics on the column axis', async () => {
    const { card, inputs, result } = relationSetup();
    const host = await mount(card, { inputs, resultMatrix: result });
    const headers = [...host.querySelectorAll('.vtable__colhead-label')].map(
      (element) => element.textContent,
    );
    expect(headers).toEqual(['斜率', '截距', '相关系数 r', '决定系数 R²', '样本数 n']);
    expect(host.querySelector('.vtable__rowhead')!.textContent).toBe('滑油压力_MPa：推力_kN');
  });

  it('offers a column picker on every cell port', async () => {
    const { card, inputs } = relationSetup();
    const host = await mount(card, { inputs });
    const selects = [...host.querySelectorAll<HTMLSelectElement>('.formula-card__port-column')];
    expect(selects.length).toBe(2);
    expect([...selects[0].options].map((option) => option.textContent)).toEqual([
      '滑油压力_MPa',
      '推力_kN',
      '温度_C',
    ]);
    expect(selects[0].value).toBe('0');
    expect(selects[1].value).toBe('1');
  });
});

// ── the available-column chips live inside the `src` matrix frame (2026-11-19) ───────────
//
// `sourceColumnNames` describes the matrix one port reads, so the chips belonged to that
// port's frame, not to the column as a whole. A card without a matrix port has no frame to
// nest them into and keeps them below the list — that is the relation card, and it must not
// change.

describe('available-column chips', () => {
  const matrixPort = (portId = 'src'): ResolvedInput => ({
    portId,
    mode: 'matrix',
    label: 'b.csv',
    matrixId: 7,
    rows: 5,
    cols: 3,
    missing: false,
  });

  it('renders the chips inside the matrix port box, after the shape', async () => {
    const card = makeCard();
    const host = await mount(card, {
      inputs: [matrixPort()],
      sourceColumnNames: ['时间_秒', 'Pos.2', '推力_kN'],
    });

    const port = host.querySelector('.formula-card__port')!;
    expect(port.classList.contains('formula-card__port--with-cols')).toBe(true);
    const cols = port.querySelector('.formula-card__cols');
    expect(cols).not.toBeNull();
    // Part of the frame: the port is the chip block's ancestor, and the block follows the
    // shape readout rather than floating beside it.
    expect(port.contains(cols!)).toBe(true);
    expect(port.querySelector('.formula-card__port-shape')!.nextElementSibling).toBe(cols);

    const chips = [...port.querySelectorAll('.formula-card__col-chip')];
    expect(chips.map((chip) => chip.querySelector('.formula-card__col-chip-pos')!.textContent))
      .toEqual(['Pos.1', 'Pos.2', 'Pos.3']);
    // A header-less column prints its position once, not twice.
    expect(chips[1].querySelector('.formula-card__col-chip-name')).toBeNull();

    // No sibling copy below the list any more.
    expect(host.querySelectorAll('.formula-card__cols')).toHaveLength(1);
  });

  it('keeps the chips below the list when the card has only cell ports', async () => {
    const card = makeCard();
    const host = await mount(card, {
      inputs: [
        { portId: 'x', mode: 'cell', label: 'a', matrixId: 7, column: 0, columns: ['a', 'b'], rows: 5, cols: 2, missing: false },
        { portId: 'y', mode: 'cell', label: 'b', matrixId: 7, column: 1, columns: ['a', 'b'], rows: 5, cols: 2, missing: false },
      ],
      sourceColumnNames: ['a', 'b'],
    });

    const ports = [...host.querySelectorAll('.formula-card__port')];
    expect(ports).toHaveLength(2);
    for (const port of ports) expect(port.querySelector('.formula-card__cols')).toBeNull();

    const list = host.querySelector('.formula-card__port-list')!;
    const cols = host.querySelector('.formula-card__cols')!;
    expect(cols).not.toBeNull();
    expect(list.contains(cols)).toBe(false);
    expect(list.nextElementSibling).toBe(cols);
  });
});
