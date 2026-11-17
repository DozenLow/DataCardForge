/**
 * @vitest-environment jsdom
 *
 * "添加到图表 ▸" — the explicit way to add a second source to an existing chart, now that
 * the column dock only lists the cards a chart already reads.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { ChartCardModel } from '../src/ui/types.ts';
import { AddToChartItems } from '../src/ui/components/AddToChartItems.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];

function matrix(annotation: string): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', [1, 2, 3]);
  data.setColumnAnnotation(0, annotation);
  return data;
}

async function mount(matrixId: number, columnIndex: number): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <AddToChartItems matrixId={matrixId} columnIndex={columnIndex} />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  store().reset();
});

describe('add a column to an existing chart', () => {
  it('lists the charts and attaches the column to the one clicked', async () => {
    const first = store().addMatrixCard([{ name: 'a.csv', matrix: matrix('one') }]);
    const chartId = store().addChartCard(first, 0)!;
    const second = store().addMatrixCard([{ name: 'b.csv', matrix: matrix('two') }]);
    const secondMatrixId = (
      store().cards.find((card) => card.id === second) as { sources: { matrixId: number }[] }
    ).sources[0].matrixId;

    const host = await mount(secondMatrixId, 0);
    // The submenu mounts its items only once opened (hover, or a click on the entry).
    const entry = host.querySelector<HTMLButtonElement>('.context-menu__item--sub')!;
    expect(entry.textContent).toContain('添加到已有图表');
    await act(async () => entry.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')].filter(
      (item) => !item.classList.contains('context-menu__item--sub'),
    );
    expect(items.length).toBe(1);

    await act(async () => items[0].click());
    const chart = store().cards.find((card) => card.id === chartId) as ChartCardModel;
    expect(chart.config.sources.some((source) => source.matrixId === secondMatrixId)).toBe(true);
    expect(chart.inputs.some((input) => input.target.cardId === second)).toBe(true);
  });

  it('renders nothing when the workspace has no chart to add to', async () => {
    const only = store().addMatrixCard([{ name: 'a.csv', matrix: matrix('one') }]);
    const matrixId = (
      store().cards.find((card) => card.id === only) as { sources: { matrixId: number }[] }
    ).sources[0].matrixId;
    const host = await mount(matrixId, 0);
    expect(host.textContent).toBe('');
  });
});
