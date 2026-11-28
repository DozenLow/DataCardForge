/**
 * Chart-card data-cache round trip through a REAL save file:
 * serializeWorkspace → File → readWorkspace → loadSnapshot.
 *
 * A chart card caches the plotted numbers (`config.sources[].raw`), the categorical
 * dictionary (`categories`), and the explicit X / grouping columns (`xAxisSource` /
 * `factorSource`) inside its config. After a restore nothing re-pulls those caches from
 * the matrices (only function cards re-register), so the file is the sole carrier of the
 * chart's data — the same non-finite encoding rules the matrix columns get must hold here.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSeries } from '../src/charts/chartModel.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { readWorkspace, serializeWorkspace } from '../src/ui/fileActions.ts';
import { isChartCard, type ChartCardModel, type MatrixCardModel } from '../src/ui/types.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';

const store = useWorkspace.getState;
const registerMatrixWithBackend = store().registerMatrixWithBackend;

async function reopen(text = serializeWorkspace(store().toSnapshot())) {
  const file = new File([text], 'workspace.json', { type: 'application/json' });
  const { snapshot, hash } = await readWorkspace(file);
  expect(hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  store().reset();
  store().loadSnapshot(snapshot);
}

/** One table: a non-finite Y column, an X column with a gap, and a coded factor column. */
function seedChart() {
  const table = new MatrixData();
  table.appendColumn('Pos.1', [NaN, Infinity, -Infinity, 0, 1.5]);
  table.setColumnAnnotation(0, 'signal');
  table.appendColumn('Pos.2', [10, NaN, 30, 40, 50]);
  table.setColumnAnnotation(1, 'time');
  table.appendColumn('Pos.3', [0, 1, 0, 1, NaN]);
  table.setColumnCategories(2, ['对照', '处理']);
  const matrixCardId = store().addMatrixCard([{ name: '数据.csv', matrix: table }]);
  const matrixCard = store().cards.find((card) => card.id === matrixCardId) as MatrixCardModel;
  const matrixId = matrixCard.sources[0].matrixId;
  const chartId = store().addChartCard(matrixCardId, 0, 'line')!;
  const column = (index: number) => store().matrices.get(matrixId)!.column(index);
  store().setChartConfig(chartId, {
    xAxisSource: {
      matrixId,
      columnIndex: 1,
      label: column(1).annotation || column(1).posName,
      raw: column(1).data.slice(),
      categories: column(1).categories?.slice(),
    },
    factorSource: {
      matrixId,
      columnIndex: 2,
      label: column(2).annotation || column(2).posName,
      raw: column(2).data.slice(),
      categories: column(2).categories?.slice(),
    },
    factorMapping: { color: true, shape: false, facet: false, heatmapStrip: false },
  });
  return { matrixCardId, matrixId, chartId };
}

function reopenedChart(): ChartCardModel {
  const card = store().cards.find(isChartCard);
  expect(card).toBeDefined();
  return card!;
}

describe('chart card data cache survives a real save file', () => {
  beforeEach(() => {
    store().reset();
    useWorkspace.setState({ registerMatrixWithBackend: vi.fn().mockResolvedValue(null) });
  });

  afterEach(() => {
    store().reset();
    useWorkspace.setState({ registerMatrixWithBackend });
  });

  it('preserves non-finite samples in the cached source values', async () => {
    seedChart();
    await reopen();
    expect(reopenedChart().config.sources[0].raw).toEqual([NaN, Infinity, -Infinity, 0, 1.5]);
  });

  it('preserves the categorical dictionary at its original codes', async () => {
    const { matrixId, chartId } = seedChart();
    store().addChartSource(chartId, matrixId, 2);
    await reopen();
    const source = reopenedChart().config.sources.find((entry) => entry.columnIndex === 2)!;
    expect(source.raw).toEqual([0, 1, 0, 1, NaN]);
    expect(source.categories).toEqual(['对照', '处理']);
  });

  it('preserves the explicit X axis source, values and port', async () => {
    const { matrixId } = seedChart();
    const before = reopenedChart().config.xAxisSource!;
    await reopen();
    const chart = reopenedChart();
    expect(chart.config.xAxisSource).toEqual(before);
    expect(chart.config.xAxisSource!.raw).toEqual([10, NaN, 30, 40, 50]);
    expect(chart.inputs.map((input) => input.portId)).toContain('x');
    expect(chart.config.xAxisSource!.matrixId).toBe(matrixId);
  });

  it('preserves the grouping source, its dictionary and port', async () => {
    seedChart();
    const before = reopenedChart().config.factorSource!;
    await reopen();
    const chart = reopenedChart();
    expect(chart.config.factorSource).toEqual(before);
    expect(chart.config.factorSource!.categories).toEqual(['对照', '处理']);
    expect(chart.config.factorSource!.raw).toEqual([0, 1, 0, 1, NaN]);
    expect(chart.inputs.map((input) => input.portId)).toContain('factor');
  });

  it('reads null cells in a legacy file’s chart cache as missing, never 0', async () => {
    seedChart();
    // Plain JSON.stringify is what an older build wrote: every non-finite became null.
    await reopen(JSON.stringify(store().toSnapshot()));
    const chart = reopenedChart();
    expect(chart.config.sources[0].raw[0]).toBeNaN();
    expect(chart.config.xAxisSource!.raw[1]).toBeNaN();
    expect(chart.config.factorSource!.raw[4]).toBeNaN();
  });

  it('restored series resolve gaps as NaN instead of a silent row-index fallback', async () => {
    seedChart();
    await reopen();
    const series = resolveSeries(reopenedChart().config);
    // A null X would hit the renderer's `raw[row] ?? row + 1` fallback and plot a
    // plausible-looking row number; the restored cache must carry the gap itself.
    expect(series[0].points[1].x).toBeNaN();
    expect(series[0].points[0].y).toBeNaN();
    expect(series[0].points[1].y).toBe(Infinity);
    expect(series[0].points[2].y).toBe(-Infinity);
  });
});
