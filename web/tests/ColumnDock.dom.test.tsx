/**
 * @vitest-environment jsdom
 *
 * Column dock — the collapsible column picker on the left of a chart card.
 *
 * The dock is exercised against the real store: it lists every matrix the workspace
 * publishes (a data card's active file, each output of a function card), checks what the
 * chart already plots, and writes choices back through addChartSource / removeChartSource
 * (which also manage the card-level dependency).
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { translatorFor } from '../src/ui/i18n.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { ChartCardModel, FunctionCardModel } from '../src/ui/types.ts';
import { ColumnDock } from '../src/ui/components/ColumnDock.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(columns: number): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4, 5]);
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

async function mount(
  card: ChartCardModel,
  open: boolean,
  onToggle: (next: boolean) => void = () => {},
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <ColumnDock card={card} open={open} onToggle={onToggle} />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

function chartOf(id: number): ChartCardModel {
  return store().cards.find((card) => card.id === id) as ChartCardModel;
}

/** A table whose columns are distinguishable by their annotation, so groups cannot blur. */
function annotatedMatrix(annotations: string[]): MatrixData {
  const mat = new MatrixData();
  annotations.forEach((annotation, index) => {
    mat.appendColumn(`Pos.${index + 1}`, [1, 2, 3, 4, 5]);
    mat.setColumnAnnotation(index, annotation);
  });
  return mat;
}

/** The dock group whose title contains `needle` — group names are not unique by design. */
function groupByTitle(host: HTMLElement, needle: string): HTMLElement {
  const groups = [...host.querySelectorAll<HTMLElement>('.chart-card__dock-group')];
  const match = groups.find((group) =>
    (group.querySelector('.chart-card__dock-group-title')?.textContent ?? '').includes(needle),
  );
  expect(match, `no dock group titled like "${needle}"`).toBeDefined();
  return match!;
}

function boxesIn(group: HTMLElement): HTMLInputElement[] {
  return [
    ...group.querySelectorAll<HTMLInputElement>('.chart-card__dock-item input[type="checkbox"]'),
  ];
}

function labelsIn(group: HTMLElement): (string | null)[] {
  return [...group.querySelectorAll('.chart-card__dock-item-label')].map(
    (label) => label.textContent,
  );
}

/** A 4-column table plus a line chart attached to its first column. */
function setupScene(): { matrixId: number; chartId: number } {
  const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix(4) }]);
  const chartId = store().addChartCard(matrixCardId, 0)!;
  const matrixId = (store().cards.find((c) => c.id === matrixCardId) as {
    sources: { matrixId: number }[];
  }).sources[0].matrixId;
  return { matrixId, chartId };
}

beforeEach(() => {
  store().reset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('collapsed rail', () => {
  it('shows only a vertical toggle and asks to open when clicked', async () => {
    const { chartId } = setupScene();
    const onToggle = vi.fn();
    const host = await mount(chartOf(chartId), false, onToggle);

    const toggle = host.querySelector<HTMLButtonElement>('.chart-card__dock-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.chart-card__dock--open')).toBeNull();

    await act(async () => {
      toggle!.click();
    });
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe('expanded picker', () => {
  it('lists every column of the active file, grouped by file name', async () => {
    const { chartId } = setupScene();
    const host = await mount(chartOf(chartId), true);

    expect(host.querySelector('.chart-card__dock--open')).not.toBeNull();
    expect(host.querySelector('.chart-card__dock-list')).not.toBeNull();
    expect(host.querySelector('.chart-card__dock-group-title')!.textContent).toBe('a.csv');

    const items = host.querySelectorAll('.chart-card__dock-item');
    expect(items).toHaveLength(4);
    const labels = [...items].map((item) => item.querySelector('.chart-card__dock-item-label')!.textContent);
    expect(labels).toEqual(['Pos.1 sensor 0', 'Pos.2 sensor 1', 'Pos.3 sensor 2', 'Pos.4 sensor 3']);

    // The chart's existing column is checked and carries its 1-based order badge.
    const first = items[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(first.checked).toBe(true);
    expect(items[0].querySelector('.chart-card__dock-badge')!.textContent).toBe('1');
  });

  it('checks and unchecks a column through the store', async () => {
    const { chartId } = setupScene();
    let host = await mount(chartOf(chartId), true);

    let boxes = host.querySelectorAll<HTMLInputElement>('.chart-card__dock-item input[type="checkbox"]');
    await act(async () => {
      boxes[1].click();
    });
    expect(chartOf(chartId).config.sources).toHaveLength(2);

    // The parent re-renders with the fresh card; remounting stands in for that.
    host = await mount(chartOf(chartId), true);
    boxes = host.querySelectorAll<HTMLInputElement>('.chart-card__dock-item input[type="checkbox"]');
    expect(boxes[1].checked).toBe(true);

    await act(async () => {
      boxes[1].click();
    });
    expect(chartOf(chartId).config.sources).toHaveLength(1);
  });

  it('refuses to uncheck the last plotted column (the chart floor)', async () => {
    const { chartId } = setupScene();
    const host = await mount(chartOf(chartId), true);

    const first = host.querySelectorAll<HTMLInputElement>(
      '.chart-card__dock-item input[type="checkbox"]',
    )[0];
    expect(first.checked).toBe(true);
    expect(first.disabled).toBe(true);
    expect(first.title).toMatch(/at least 1|至少需要 1/);
  });

  it('marks the X-axis column with an X badge', async () => {
    const { matrixId, chartId } = setupScene();
    store().setChartConfig(chartId, {
      xAxisSource: { matrixId, columnIndex: 1, label: 'Pos.2 sensor 1', raw: [1, 2, 3, 4, 5] },
    });

    const host = await mount(chartOf(chartId), true);
    const badges = [...host.querySelectorAll('.chart-card__dock-badge')].map(
      (badge) => badge.textContent,
    );
    expect(badges).toContain('X');

    const items = host.querySelectorAll('.chart-card__dock-item');
    const secondBadges = [...items[1].querySelectorAll('.chart-card__dock-badge')].map(
      (badge) => badge.textContent,
    );
    expect(secondBadges).toContain('X');
  });

  it('shows the pairing hint for paired chart types only', async () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix(4) }]);
    const lineChart = store().addChartCard(matrixCardId, 0)!;
    const scatterChart = store().addChartCard(matrixCardId, 0, 'scatter')!;

    let host = await mount(chartOf(lineChart), true);
    expect(host.querySelector('.chart-card__dock-order')).toBeNull();

    host = await mount(chartOf(scatterChart), true);
    expect(host.querySelector('.chart-card__dock-order')).not.toBeNull();
  });

  it('shows the empty state when no table is open', async () => {
    const { chartId } = setupScene();
    const detached = chartOf(chartId);
    store().reset();

    // A chart that still plots a column is no longer "empty": its column now shows up in
    // the unlisted-source group (see the fallback case below), which is the whole point of
    // that group. The empty state is what a chart with nothing to list gets, so the
    // detached card is mounted plotting nothing.
    const plottingNothing: ChartCardModel = {
      ...detached,
      config: { ...detached.config, sources: [] },
    };

    const host = await mount(plottingNothing, true);
    expect(host.querySelector('.chart-card__dock-empty')).not.toBeNull();
    expect(host.querySelectorAll('.chart-card__dock-item')).toHaveLength(0);
  });

  it('keeps a data card group titled by its file name with Pos.N annotation labels', async () => {
    const { chartId } = setupScene();
    const host = await mount(chartOf(chartId), true);

    const titles = [...host.querySelectorAll('.chart-card__dock-group-title')].map(
      (title) => title.textContent,
    );
    // The bare file name: a data file needs no owner or output decoration to be identified.
    expect(titles).toEqual(['a.csv']);

    const first = host.querySelectorAll<HTMLElement>('.chart-card__dock-group')[0];
    expect(labelsIn(first)).toEqual([
      'Pos.1 sensor 0',
      'Pos.2 sensor 1',
      'Pos.3 sensor 2',
      'Pos.4 sensor 3',
    ]);
  });
});

describe('function-card outputs', () => {
  /**
   * A script card publishing two tables, the second one bound to a line chart.
   *
   * `out:0` and `out:1` are fed with different tables on purpose: a dock that listed the
   * wrong slot would still show two columns, so the assertion has to be about WHICH slot
   * (and which labels) the group came from.
   */
  function scriptScene(): {
    scriptCardId: number;
    chartId: number;
    out0Slot: number;
    out1Slot: number;
    declaredName: string;
  } {
    const sourceCardId = store().addMatrixCard([
      { name: 'a.csv', matrix: annotatedMatrix(['read a', 'read b', 'read c']) },
    ]);
    const scriptCardId = store().addScriptCard([sourceCardId]) as number;
    expect(scriptCardId).not.toBeNull();
    // Declaring the second output allocates the slot a chart can be built from.
    expect(store().addScriptOutput(scriptCardId)).toBe('out:1');

    const script = store().cards.find((card) => card.id === scriptCardId) as FunctionCardModel;
    expect(script.outputs.map((output) => output.outputId)).toEqual(['out:0', 'out:1']);
    const out0Slot = script.displayMatrixId;
    const out1Slot = script.outputs[1].localMatrixId;
    expect(out1Slot).toBeTypeOf('number');

    // Both slots hold a table; only a fed slot has columns to offer.
    const matrices = new Map(store().matrices);
    matrices.set(out0Slot, annotatedMatrix(['first a', 'first b']));
    matrices.set(out1Slot!, annotatedMatrix(['second a', 'second b']));
    useWorkspace.setState({ matrices });

    const chartId = store().addChartCard(scriptCardId, 0, 'line', 'out:1') as number;
    expect(chartId).not.toBeNull();
    expect(chartOf(chartId).config.sources).toHaveLength(1);
    expect(chartOf(chartId).config.sources[0].matrixId).toBe(out1Slot);

    return {
      scriptCardId,
      chartId,
      out0Slot,
      out1Slot: out1Slot!,
      declaredName: (script.params.outputs as string[])[1],
    };
  }

  it('offers the output a chart is bound to as a selectable group', async () => {
    const { scriptCardId, chartId, out0Slot, out1Slot, declaredName } = scriptScene();
    const t = translatorFor(store().locale);

    let host = await mount(chartOf(chartId), true);
    let group = groupByTitle(host, declaredName);

    // Titled by the card that declares the output plus the declared name — the identity a
    // reader can act on (`out:1` is the chart's binding, the name is what the user chose).
    expect(group.querySelector('.chart-card__dock-group-title')!.textContent).toBe(
      `${t('chart.columnDockOwner', { n: scriptCardId })} · ${declaredName}`,
    );
    expect(labelsIn(group)).toEqual(['Pos.1 second a', 'Pos.2 second b']);

    let boxes = boxesIn(group);
    // The plotted column is checked — the bug was that it could not even be listed.
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(false);

    await act(async () => {
      boxes[1].click();
    });
    let chart = chartOf(chartId);
    expect(chart.config.sources).toHaveLength(2);
    expect(chart.config.sources[1].matrixId).toBe(out1Slot);
    expect(chart.config.sources[1].columnIndex).toBe(1);
    // Never the sibling output: the group addresses `out:1`'s slot and nothing else.
    expect(chart.config.sources[1].matrixId).not.toBe(out0Slot);

    // Off the floor now (2 > 1), so the original column can be cancelled in its turn; the
    // remount stands in for the parent re-rendering with the fresh card.
    host = await mount(chartOf(chartId), true);
    group = groupByTitle(host, declaredName);
    boxes = boxesIn(group);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(false);

    await act(async () => {
      boxes[0].click();
    });
    chart = chartOf(chartId);
    expect(chart.config.sources).toHaveLength(1);
    expect(chart.config.sources[0].matrixId).toBe(out1Slot);
    expect(chart.config.sources[0].columnIndex).toBe(1);
    // The edge still runs chart → script card: the chart's dependency did not move.
    expect(store().dependencies.getDependents(scriptCardId)).toContain(chartId);
    expect(chart.inputs.map((input) => input.target.cardId)).toEqual([scriptCardId]);
  });
});

describe('unlisted sources', () => {
  it('lists a plotted source no card publishes, so it stays cancellable', async () => {
    const { matrixId, chartId } = setupScene();
    // Two columns, so the floor of a line chart does not pin the one under test.
    store().addChartSource(chartId, matrixId, 1);
    const chart = chartOf(chartId);
    expect(chart.config.sources).toHaveLength(2);
    // A source whose matrix no card owns any more: its source card was closed, or its slot
    // was never fed. The chart still plots the values it recorded.
    const orphan = { ...chart.config.sources[1], matrixId: 999, label: 'Pos.9 ghost' };
    store().setChartConfig(chartId, { sources: [chart.config.sources[0], orphan] });

    const t = translatorFor(store().locale);
    let host = await mount(chartOf(chartId), true);
    let group = groupByTitle(host, t('chart.columnDockUnlisted'));
    expect(group.querySelector('.chart-card__dock-group-title')!.textContent).toBe(
      t('chart.columnDockUnlisted'),
    );
    // The label is the one recorded when the column was attached — there is no matrix left
    // to read a column name from.
    expect(labelsIn(group)).toEqual(['Pos.9 ghost']);

    const boxes = boxesIn(group);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(false);

    await act(async () => {
      boxes[0].click();
    });
    expect(chartOf(chartId).config.sources).toHaveLength(1);

    host = await mount(chartOf(chartId), true);
    const titles = [...host.querySelectorAll('.chart-card__dock-group-title')].map(
      (title) => title.textContent,
    );
    // Nothing unlisted is plotted any more, so the group goes with it.
    expect(titles).not.toContain(t('chart.columnDockUnlisted'));
  });
});

// ── the dock lists only the cards the chart reads (2026-11-17) ────────────────────────────
//
// Reported: one chart listed every card's output matrix, so it could draw any table in the
// workspace — including the very table a script card consumes. A chart's dataflow edges are
// its contract; the dock is a presentation choice within them, and a NEW source is added by
// an explicit gesture (`添加到图表`) instead of by ambient availability.

describe('dock scope', () => {
  function twoTables(): { chartId: number; secondMatrixId: number } {
    const first = store().addMatrixCard([{ name: 'a.csv', matrix: annotatedMatrix(['one']) }]);
    const chartId = store().addChartCard(first, 0)!;
    const second = store().addMatrixCard([{ name: 'b.csv', matrix: annotatedMatrix(['two']) }]);
    const secondMatrixId = (
      store().cards.find((card) => card.id === second) as {
        sources: { matrixId: number }[];
      }
    ).sources[0].matrixId;
    return { chartId, secondMatrixId };
  }

  it('does not list a second table the chart has no edge to', async () => {
    const { chartId } = twoTables();
    const host = await mount(chartOf(chartId), true);
    const titles = [...host.querySelectorAll('.chart-card__dock-group-title')].map(
      (node) => node.textContent,
    );
    expect(titles.some((title) => title?.includes('a.csv'))).toBe(true);
    expect(titles.some((title) => title?.includes('b.csv'))).toBe(false);
  });

  it('lists it once the column was attached explicitly (the edge exists)', async () => {
    const { chartId, secondMatrixId } = twoTables();
    store().addChartSource(chartId, secondMatrixId, 0);
    const host = await mount(chartOf(chartId), true);
    const titles = [...host.querySelectorAll('.chart-card__dock-group-title')].map(
      (node) => node.textContent,
    );
    expect(titles.some((title) => title?.includes('b.csv'))).toBe(true);
    // …and the store derived the edge to that card, so the contract holds for it too.
    const chart = chartOf(chartId);
    expect(chart.config.sources.some((source) => source.matrixId === secondMatrixId)).toBe(true);
    expect(new Set(chart.inputs.map((input) => input.target.cardId)).size).toBe(2);
  });
});
