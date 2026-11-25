/**
 * Chart builders.
 *
 * These assert the *shape* of what each chart type produces — series kinds, axis kinds,
 * computed statistics — rather than pixels. That is the part that silently breaks when
 * a data model changes, and it is testable without a DOM.
 */
import { describe, expect, it } from 'vitest';

import type { EChartsOption } from 'echarts';

import {
  buildOption,
  buildSeries,
  CHART_DISPLAY_POINT_LIMIT,
  computeBounds,
  type BuildContext,
} from '../src/charts/chartOptions.ts';
import {
  defaultChartConfig,
  resolveSeries,
  isDrawable,
  nonPositiveAxisCounts,
} from '../src/charts/chartModel.ts';
import type { ChartSource } from '../src/charts/chartModel.ts';
import { pngToPdf } from '../src/charts/pdf.ts';
import { CHART_TYPES, minimumColumns, type ChartTypeId } from '../src/charts/chartTypes.ts';
import { DEFAULT_SMOOTHING } from '../src/core/Smoothing.ts';
import {
  errorBarValues,
  fiveNumberSummary,
  histogram,
  kernelDensity,
  mean,
} from '../src/core/stats.ts';

function source(label: string, raw: number[], columnIndex = 0, matrixId = 1): ChartSource {
  return { matrixId, columnIndex, label, raw };
}

const strings: BuildContext['strings'] = {
  rowIndex: 'No.',
  value: 'Value',
  count: 'Count',
  density: 'Density',
  binCentre: 'Bin centre',
  correlation: 'r',
  quartiles: 'IQR',
  mean: 'Mean ± SD',
  outliers: 'outliers',
  secondAxis: '2nd',
  drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
};

function context(type: ChartTypeId, sources: ChartSource[], patch: Partial<BuildContext['config']> = {}): BuildContext {
  return {
    config: { ...defaultChartConfig(type, sources), ...patch },
    smoothing: { ...DEFAULT_SMOOTHING },
    strings,
  };
}

/** A well-behaved sample: 0..99 with a single bump, plus a constant series. */
const ramp = Array.from({ length: 100 }, (_, i) => i);
const wave = ramp.map((value) => Math.sin(value / 8) * 10 + 50);
const noisy = [1, 5, 2, 8, 3, 9, 4, 7, 6, 10];

describe('chart type registry', () => {
  it('declares every type with a distinct id and consistent flags', () => {
    const ids = Object.keys(CHART_TYPES) as ChartTypeId[];
    expect(ids.length).toBeGreaterThanOrEqual(9);
    for (const id of ids) {
      const def = CHART_TYPES[id];
      expect(def.id).toBe(id);
      expect(def.defaultColumnCount).toBeGreaterThanOrEqual(1);
      expect(def.vectorSafe).toBe(true);
    }
  });

  it('requires two columns for the types that pair or cross columns', () => {
    expect(minimumColumns('scatter')).toBe(2);
    expect(minimumColumns('regression')).toBe(2);
    expect(minimumColumns('heatmap')).toBe(2);
    expect(minimumColumns('line')).toBe(1);
    expect(minimumColumns('boxplot')).toBe(1);
  });
});

describe('resolveSeries', () => {
  it('pairs consecutive columns for scatter', () => {
    const config = defaultChartConfig('scatter', [source('X', [1, 2]), source('Y', [3, 4])]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].points).toEqual([
      { x: 1, y: 3 },
      { x: 2, y: 4 },
    ]);
  });

  it('truncates a pair to the shorter column', () => {
    const config = defaultChartConfig('scatter', [source('X', [1, 2, 3]), source('Y', [9])]);
    expect(resolveSeries(config)[0].points).toEqual([{ x: 1, y: 9 }]);
  });

  it('produces one series per column for line', () => {
    const config = defaultChartConfig('line', [source('A', [1, 2]), source('B', [3, 4])]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(2);
    // Row-indexed: x starts at 1, matching `No.N`.
    expect(resolved[0].points[0]).toEqual({ x: 1, y: 1 });
  });

  it('keeps an odd trailing column visible instead of dropping it', () => {
    const config = defaultChartConfig('scatter', [
      source('X', [1, 2]),
      source('Y', [3, 4]),
      source('Z', [5, 6]),
    ]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(2);
    expect(resolved[1].label).toContain('Z');
  });
});

describe('isDrawable', () => {
  it('is false without enough columns for the type', () => {
    expect(isDrawable(defaultChartConfig('line', []))).toBe(false);
    expect(isDrawable(defaultChartConfig('scatter', [source('X', [1])]))).toBe(false);
  });

  it('is true once the type has what it needs', () => {
    expect(isDrawable(defaultChartConfig('line', [source('A', [1])]))).toBe(true);
    expect(
      isDrawable(defaultChartConfig('scatter', [source('X', [1]), source('Y', [2])])),
    ).toBe(true);
  });
});

describe('line / bar series', () => {
  it('plots row index against value and downsamples', () => {
    const series = buildSeries(context('line', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect((series[0] as { sampling?: string }).sampling).toBeUndefined();
    const data = (series[0] as { data: Array<[number, number]> }).data;
    expect(data[0]).toEqual([1, 0]);
    expect(data[99]).toEqual([100, 99]);
  });

  it('stacks bars when the layout is set', () => {
    const series = buildSeries(
      context('bar', [source('A', [1, 2]), source('B', [3, 4])], { layout: 'stacked' }),
    );
    expect(series.every((entry) => (entry as { stack?: string }).stack === 'total')).toBe(true);
  });

  it('leaves bars unstacked by default', () => {
    const series = buildSeries(context('bar', [source('A', [1, 2]), source('B', [3, 4])]));
    expect((series[0] as { stack?: string }).stack).toBeUndefined();
  });

  it('routes every second series to the second axis when enabled', () => {
    const series = buildSeries(
      context('line', [source('A', [1, 2]), source('B', [3, 4])], { secondAxis: true }),
    );
    expect((series[0] as { yAxisIndex?: number }).yAxisIndex).toBe(0);
    expect((series[1] as { yAxisIndex?: number }).yAxisIndex).toBe(1);
  });

  it('applies the card smoothing before plotting', () => {
    const smoothed = buildSeries(
      context('line', [source('A', [1, 2, 3, 4, 5])], {}, ),
    );
    expect(smoothed).toHaveLength(1);
    // Default smoothing is a window of 1 => the raw values pass through.
    expect((smoothed[0] as { data: Array<[number, number]> }).data.map((d) => d[1])).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const averaged = buildSeries({
      config: {
        ...defaultChartConfig('line', [source('A', [1, 2, 3, 4, 5])]),
      },
      smoothing: { mode: 'movingAverage', window: 3, alpha: 0.5, degree: 2 },
      strings,
    });
    expect((averaged[0] as { data: Array<[number, number]> }).data.map((d) => d[1])).toEqual([
      1.5, 2, 3, 4, 4.5,
    ]);
  });
});

describe('histogram', () => {
  it('bins the column and keeps every sample', () => {
    const series = buildSeries(context('histogram', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('bar');
    const data = (series[0] as { data: Array<[number, number]> }).data;
    // `binCount: 0` means "choose automatically" (Sturges' rule over 100 samples).
    const expected = histogram(ramp);
    expect(data).toHaveLength(expected.bins.length);
    const total = data.reduce((sum, [, count]) => sum + count, 0);
    expect(total).toBe(ramp.length);
  });

  it('honours an explicit bin count', () => {
    const series = buildSeries(context('histogram', [source('A', ramp)], { binCount: 7 }));
    expect((series[0] as { data: unknown[] }).data).toHaveLength(7);
  });

  it('uses only the first column', () => {
    const series = buildSeries(context('histogram', [source('A', ramp), source('B', ramp)]));
    expect(series).toHaveLength(1);
  });
});

describe('boxplot', () => {
  it('emits the five-number summary per column', () => {
    const series = buildSeries(context('boxplot', [source('A', ramp), source('B', noisy)]));
    const box = series.find((entry) => entry.type === 'boxplot') as {
      data: number[][];
    };
    const expectedA = fiveNumberSummary(ramp);
    expect(box.data[0]).toEqual([
      expectedA.min,
      expectedA.q1,
      expectedA.median,
      expectedA.q3,
      expectedA.max,
    ]);
    expect(box.data).toHaveLength(2);
  });

  it('adds an outlier series only when there are outliers', () => {
    const clean = buildSeries(context('boxplot', [source('A', ramp)]));
    expect(clean.some((entry) => entry.type === 'scatter')).toBe(false);

    const withOutlier = buildSeries(
      context('boxplot', [source('A', [...ramp, 100000])]),
    );
    const scatter = withOutlier.find((entry) => entry.type === 'scatter') as {
      data: Array<[number, number]>;
    };
    expect(scatter).toBeDefined();
    expect(scatter.data.some(([, value]) => value === 100000)).toBe(true);
  });
});

describe('violin', () => {
  it('is a custom series with a working renderItem', () => {
    const series = buildSeries(context('violin', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('custom');
    expect(typeof (series[0] as { renderItem?: unknown }).renderItem).toBe('function');
  });

  it('renderItem emits a polygon plus three quartile rules', () => {
    const built = buildSeries(context('violin', [source('A', noisy)]));
    const renderItem = (built[0] as unknown as {
      renderItem: (
        params: unknown,
        api: {
          value: (dim: number) => number;
          coord: (pair: [number, number]) => [number, number];
        },
      ) => { type: string; children: Array<{ type: string; shape: { points?: unknown[] } }> } | undefined;
    }).renderItem;

    // `coord` must return a tuple, not a widened number[].
    const api = {
      value: (_dim: number) => 0,
      coord: (pair: [number, number]): [number, number] => [
        100 + pair[0] * 200,
        400 - pair[1] * 4,
      ],
    };
    const result = renderItem({}, api);
    expect(result).toBeDefined();
    expect(result!.type).toBe('group');

    const polygon = result!.children.find((child) => child.type === 'polygon');
    expect(polygon).toBeDefined();
    // The outline is a closed KDE curve: both mirrored halves.
    expect((polygon!.shape.points ?? []).length).toBeGreaterThan(100);
    const rules = result!.children.filter((child) => child.type === 'line');
    expect(rules).toHaveLength(3); // q1, q3, median
  });
});

describe('errorBar', () => {
  it('draws a custom series plus a scatter for the tooltip', () => {
    const series = buildSeries(context('errorBar', [source('A', noisy), source('B', ramp)]));
    expect(series.map((entry) => entry.type)).toEqual(['scatter', 'custom']);
  });

  it('renderItem emits a stem and two caps', () => {
    const built = buildSeries(context('errorBar', [source('A', noisy)]));
    const custom = built.find((entry) => entry.type === 'custom') as unknown as {
      renderItem: (params: unknown, api: {
        value: (dim: number) => number;
        coord: (pair: [number, number]) => [number, number];
      }) => { children: Array<{ type: string }> } | undefined;
    };
    const api = {
      value: (_dim: number) => 0,
      coord: (pair: [number, number]): [number, number] => [100, 200 - pair[1]],
    };
    const result = custom.renderItem({}, api);
    expect(result).toBeDefined();
    expect(result!.children.filter((child) => child.type === 'line')).toHaveLength(3);
    expect(result!.children.filter((child) => child.type === 'circle')).toHaveLength(1);
  });

  it('guards against a NaN mean (empty column)', () => {
    const built = buildSeries(context('errorBar', [source('A', [])]));
    const custom = built.find((entry) => entry.type === 'custom') as unknown as {
      renderItem: (params: unknown, api: {
        value: (dim: number) => number;
        coord: (pair: [number, number]) => [number, number];
      }) => unknown;
    };
    expect(
      custom.renderItem({}, { value: () => 0, coord: (): [number, number] => [0, 0] }),
    ).toBeUndefined();
  });
});

describe('heatmap', () => {
  it('builds a square correlation matrix with a unit diagonal', () => {
    const series = buildSeries(
      context('heatmap', [source('A', ramp), source('B', wave), source('C', noisy)]),
    );
    const data = (series[0] as { data: Array<[number, number, number]> }).data;
    expect(data).toHaveLength(9);
    const diagonal = data.filter(([x, y]) => x === y);
    expect(diagonal.every(([, , value]) => value === 1)).toBe(true);
  });

  it('keeps an undefined correlation as NaN so it is not drawn as "no correlation"', () => {
    // A constant column has no variance, so its correlation is *undefined* — not 0.
    // Coercing NaN to 0 used to paint it with the neutral colour of the diverging scale,
    // i.e. it claimed "uncorrelated" where the data cannot say anything at all.
    const series = buildSeries(
      context('heatmap', [source('A', [1, 1, 1]), source('B', [1, 2, 3])]),
    );
    const data = (series[0] as { data: Array<[number, number, number]> }).data;
    expect(data).toHaveLength(4);
    // The diagonal is defined; the two cross terms must stay NaN.
    expect(data.filter(([x, y]) => x === y).every(([, , v]) => v === 1)).toBe(true);
    expect(data.filter(([x, y]) => x !== y).every(([, , v]) => Number.isNaN(v))).toBe(true);
  });

  it('labels an undefined correlation with an em dash, not 0.00', () => {
    const series = buildSeries(
      context('heatmap', [source('A', [1, 1, 1]), source('B', [1, 2, 3])]),
    );
    const label = (
      series[0] as { label: { formatter: (params: { value: unknown }) => string } }
    ).label;
    expect(label.formatter({ value: [0, 1, NaN] })).toBe('—');
    expect(label.formatter({ value: [0, 0, 1] })).toBe('1.00');
  });
});

describe('buildOption axis selection', () => {
  it('gives per-series types a category x axis', () => {
    for (const type of ['boxplot', 'violin', 'errorBar'] as ChartTypeId[]) {
      const option = buildOption(context(type, [source('A', noisy), source('B', ramp)]));
      const xAxis = option.xAxis as { type: string; data: string[] };
      expect(xAxis.type).toBe('category');
      expect(xAxis.data).toEqual(['A', 'B']);
    }
  });

  it('gives row-indexed types a value x axis', () => {
    for (const type of ['line', 'bar', 'histogram'] as ChartTypeId[]) {
      const option = buildOption(context(type, [source('A', ramp)]));
      expect((option.xAxis as { type: string }).type).toBe('value');
    }
  });

  it('switches to a log value axis when requested', () => {
    const option = buildOption(context('line', [source('A', ramp)], { logScale: true }));
    expect((option.yAxis as { type: string }).type).toBe('log');
  });

  it('keeps bars linear even with the log toggle on', () => {
    // A zero-height bar has no position on a log axis.
    const option = buildOption(context('bar', [source('A', ramp)], { logScale: true }));
    expect((option.yAxis as { type: string }).type).toBe('value');
  });

  it('creates a second y axis only when enabled', () => {
    const single = buildOption(context('line', [source('A', ramp)]));
    expect(Array.isArray(single.yAxis)).toBe(false);

    const dual = buildOption(
      context('line', [source('A', ramp), source('B', ramp)], { secondAxis: true }),
    );
    expect(Array.isArray(dual.yAxis)).toBe(true);
    expect((dual.yAxis as unknown[]).length).toBe(2);
  });

  it('adds a diverging visual map for the heatmap', () => {
    const option = buildOption(
      context('heatmap', [source('A', ramp), source('B', wave)]),
    );
    const visualMap = option.visualMap as Array<{ min: number; max: number }>;
    expect(visualMap[0].min).toBe(-1);
    expect(visualMap[0].max).toBe(1);
    // A correlation heatmap must never offer axis zoom over a categorical grid.
    expect(option.dataZoom).toEqual([]);
  });

  it('keeps the fit-line name out of the legend', () => {
    const option = buildOption(
      context('regression', [source('X', ramp), source('Y', wave)]),
    );
    const legend = option.legend as { data?: string[] };
    const names = legend.data ?? [];
    expect(names.some((name) => name.includes('fit y='))).toBe(false);
    // …but the scatter series itself is still in the legend.
    expect(names).toContain('X → Y');
  });

  it('puts the shared unit on the value axis, and only when it is given', () => {
    // units v1: the caller derives the unit at render time and hands it over only when every
    // plotted column resolves to the SAME recognized unit (see ChartCard). The builder's job
    // is just to state it — "Value (kPa)".
    const plain = buildOption(context('line', [source('A', ramp)])).yAxis as { name?: string };
    expect(plain.name).toBe('Value');

    const withUnit = buildOption({
      ...context('line', [source('A', ramp)]),
      yAxisUnit: 'kPa',
    }).yAxis as { name?: string };
    expect(withUnit.name).toBe('Value (kPa)');

    // Every row-indexed / per-series type that plots values uses the same title.
    for (const type of ['bar', 'boxplot', 'violin', 'errorBar', 'scatter'] as ChartTypeId[]) {
      const option = buildOption({
        ...context(type, [source('A', noisy), source('B', ramp)]),
        yAxisUnit: 'kPa',
      });
      expect((option.yAxis as { name?: string }).name, `y axis for ${type}`).toBe('Value (kPa)');
    }
  });

  it('leaves the histogram y axis (a count) and the heatmap (no value axis) unit-free', () => {
    // A histogram's y axis counts occurrences, so appending the column's unit would label a
    // frequency as a pressure.
    const histogram = buildOption({
      ...context('histogram', [source('A', ramp)]),
      yAxisUnit: 'kPa',
    }).yAxis as { name?: string };
    expect(histogram.name).toBe('Count');

    // The heatmap's y axis is a category axis over column names; there is no value axis to
    // annotate, and its colour scale is a correlation coefficient, not a measurement.
    const heatmap = buildOption({
      ...context('heatmap', [source('A', ramp), source('B', wave)]),
      yAxisUnit: 'kPa',
    }).yAxis as { name?: string; type?: string };
    // A category axis with no title at all — nothing to append a unit to.
    expect(heatmap.name).toBeUndefined();
    expect(heatmap.type).toBe('category');
  });

  it('caps the number of scatter symbols so exported SVGs stay practical', () => {
    const big = Array.from({ length: 40_000 }, (_, i) => Math.sin(i / 50) + i / 100_000);
    const other = Array.from({ length: 40_000 }, (_, i) => Math.cos(i / 50));
    const series = buildSeries(context('regression', [source('X', big), source('Y', other)]));
    const scatter = series.find((entry) => entry.type === 'scatter') as {
      data: unknown[];
    };
    expect(scatter.data.length).toBeLessThanOrEqual(CHART_DISPLAY_POINT_LIMIT);
    // The thinning keeps the first and last samples and preserves the data envelope.
    expect(scatter.data.length).toBeGreaterThan(1_000);
  });

  it('keeps an isolated single-point spike when a large line is thinned', () => {
    const values = Array.from({ length: 40_000 }, () => 0);
    values[23_457] = 10_000;
    const series = buildSeries(context('line', [source('A', values)]));
    const data = (series[0] as { data: Array<[number, number]> }).data;

    expect(data.length).toBeLessThanOrEqual(CHART_DISPLAY_POINT_LIMIT);
    expect(data).toContainEqual([23_458, 10_000]);
  });

  it('fits a thinned regression over every source pair', () => {
    const x = Array.from({ length: 40_000 }, (_, i) => i);
    const y = x.map((value) => 2 * value + 3);
    const series = buildSeries(context('regression', [source('X', x), source('Y', y, 1)]));
    const fit = series.find((entry) => entry.type === 'line') as { name: string };

    expect(fit.name).toContain('n=40000');
    expect(fit.name).toContain('y=2.000x+3.000');
  });

  it('labels downsampled plots with drawn and total point counts', () => {
    const values = Array.from({ length: 40_000 }, (_, i) => i);
    const option = buildOption(context('line', [source('A', values)]));
    const graphic = option.graphic as Array<{
      elements: Array<{ style: { text: string } }>;
    }>;

    expect(graphic[0].elements[0].style.text).toBe(
      `Drawn ${CHART_DISPLAY_POINT_LIMIT} / total 40000`,
    );
  });

  it('supports log-log axes with 2..9 minor tick positions', () => {
    const option = buildOption(
      context(
        'scatter',
        [source('X', [1, 10, 100]), source('Y', [2, 20, 200], 1)],
        { xLogScale: true, logScale: true },
      ),
    );
    const xAxis = option.xAxis as { type?: string; minorTick?: { show?: boolean; splitNumber?: number } };
    const yAxis = option.yAxis as { type?: string; minorTick?: { show?: boolean; splitNumber?: number } };

    expect(xAxis.type).toBe('log');
    expect(yAxis.type).toBe('log');
    expect(xAxis.minorTick).toMatchObject({ show: true, splitNumber: 9 });
    expect(yAxis.minorTick).toMatchObject({ show: true, splitNumber: 9 });
  });

  it('counts non-positive values per enabled log axis', () => {
    const config = {
      ...defaultChartConfig('scatter', [
        source('X', [0, 1, -2]),
        source('Y', [-1, 2, 3], 1),
      ]),
      xLogScale: true,
      logScale: true,
    };

    expect(nonPositiveAxisCounts(config)).toEqual({ x: 2, y: 1 });
  });

  it('produces a usable option for every declared chart type', () => {
    const ids = Object.keys(CHART_TYPES) as ChartTypeId[];
    for (const id of ids) {
      const option = buildOption(
        context(id, [source('A', ramp), source('B', wave), source('C', noisy)]),
      ) as EChartsOption;
      expect(option.series, `series for ${id}`).toBeDefined();
      expect((option.series as unknown[]).length, `series count for ${id}`).toBeGreaterThan(0);
      expect((option.series as unknown[]).length, `series count for ${id}`).toBeLessThan(12);
    }
  });
});

describe('computeBounds', () => {
  it('spans the value range for a violin (width carries density, not y)', () => {
    const ctx = context('violin', [source('A', ramp), source('B', noisy)]);
    const bounds = computeBounds(ctx);
    // The ribbon is drawn along the value axis, so the range covers the samples.
    expect(bounds.yMin).toBeLessThan(0);
    expect(bounds.yMax).toBeGreaterThan(99);
    // …and it must NOT be pinned to the density peak (a fraction, far below 99).
    const peak = Math.max(
      ...kernelDensity(ramp, 96).map((point) => point.y),
      ...kernelDensity(noisy, 96).map((point) => point.y),
    );
    expect(bounds.yMax).toBeGreaterThan(peak * 10);
  });

  it('covers the whiskers for error bars', () => {
    const ctx = context('errorBar', [source('A', noisy)], { errorKind: 'sd' });
    const bounds = computeBounds(ctx);
    const values = noisy.filter(Number.isFinite);
    const centre = mean(values);
    const spread = errorBarValues(values, 'sd');
    expect(bounds.yMin).toBeLessThan(centre - spread);
    expect(bounds.yMax).toBeGreaterThan(centre + spread);
  });

  it('spans the full data extent for a box plot', () => {
    const bounds = computeBounds(context('boxplot', [source('A', noisy)]));
    expect(bounds.yMin).toBeLessThan(1);
    expect(bounds.yMax).toBeGreaterThan(10);
  });

  it('states no bounds for the types ECharts can scale itself', () => {
    for (const type of ['line', 'bar', 'histogram', 'scatter', 'heatmap'] as ChartTypeId[]) {
      expect(computeBounds(context(type, [source('A', ramp)]))).toEqual({});
    }
  });

  it('drives the plotted axis range in the built option', () => {
    const option = buildOption(context('violin', [source('A', ramp)]));
    const yAxis = option.yAxis as { min?: number; max?: number; scale?: boolean; name?: string };
    expect(yAxis.min).toBeLessThan(0);
    expect(yAxis.max).toBeGreaterThan(99);
    // The y axis carries values, not density: the width encodes density.
    expect(yAxis.name).toBe('Value');
    // With a stated range, `scale` must be off or ECharts could still tighten the axis.
    expect(yAxis.scale).toBe(false);

    const lineAxis = buildOption(context('line', [source('A', ramp)])).yAxis as {
      scale?: boolean;
      min?: number;
    };
    expect(lineAxis.scale).toBe(true);
    expect(lineAxis.min).toBeUndefined();
  });

  it('does not impose a log axis minimum (log has no zero)', () => {
    const option = buildOption(
      context('errorBar', [source('A', noisy)], { logScale: true }),
    );
    const yAxis = option.yAxis as { type: string; min?: number };
    expect(yAxis.type).toBe('log');
    expect(yAxis.min).toBeUndefined();
  });
});

// ── PDF export: the PNG colour type must survive the raster → PDF split (#14) ────────────
//
// decodePng admits 8-bit truecolour (type 2, RGB) AND truecolour+alpha (type 6, RGBA), but
// pngToPdf used to unfilter/split every PNG with a hard-coded 4-channel stride — a type-2
// PNG was read with the wrong stride and embedded scrambled. These cases build minimal PNGs
// byte by byte and assert the embedded samples match the input exactly.

/** CRC-32 as PNG chunk checksums use it (reflected polynomial 0xEDB88320). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length + type + data + CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; ++i) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib wrap/unwrap — the same formats pdf.ts's own deflate/inflate use. */
async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zlibInflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal non-interlaced 8-bit PNG: signature + IHDR + one filter-0 IDAT + IEND. */
async function makePng(
  width: number,
  height: number,
  colourType: 2 | 6,
  pixels: Uint8Array,
): Promise<Uint8Array> {
  const stride = width * (colourType === 2 ? 3 : 4);
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; ++y) {
    // The filter byte stays 0 (None); the row's samples follow it verbatim.
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colourType;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await zlibDeflate(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    png.set(part, cursor);
    cursor += part.length;
  }
  return png;
}

/** Latin-1 view of a PDF — one byte per char, so text offsets ARE byte offsets. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** The embedded image XObject of a colour space: its dictionary and inflated samples. */
async function pdfImage(
  pdf: Uint8Array,
  colorSpace: 'DeviceRGB' | 'DeviceGray',
): Promise<{ dict: string; samples: Uint8Array }> {
  const text = latin1(pdf);
  const marker = '<< /Type /XObject /Subtype /Image';
  let from = 0;
  for (;;) {
    const dictStart = text.indexOf(marker, from);
    expect(dictStart, `no /${colorSpace} image in the PDF`).toBeGreaterThan(-1);
    const dictEnd = text.indexOf('>>', dictStart);
    const dict = text.slice(dictStart, dictEnd + 2);
    if (dict.includes(`/ColorSpace /${colorSpace}`)) {
      const length = Number(/\/Length (\d+)/.exec(dict)![1]);
      const streamStart = text.indexOf('stream\n', dictEnd) + 'stream\n'.length;
      const samples = await zlibInflate(pdf.subarray(streamStart, streamStart + length));
      return { dict, samples };
    }
    from = dictEnd + 2;
  }
}

describe('pngToPdf', () => {
  it('embeds an 8-bit RGB PNG (colour type 2) without scrambling its channels', async () => {
    // 3×2 pixels, every sample distinct: a wrong stride shifts samples across rows and
    // channels, so byte-for-byte equality is the anti-scramble assertion.
    const pixels = Uint8Array.from({ length: 18 }, (_, i) => 10 + i * 7);
    const png = await makePng(3, 2, 2, pixels);
    const pdf = await pngToPdf(png, { pageWidth: 200, pageHeight: 150, margin: 10 });

    expect(latin1(pdf)).toContain('/MediaBox [0 0 200.00 150.00]');
    const image = await pdfImage(pdf, 'DeviceRGB');
    expect(image.dict).toContain('/Width 3 /Height 2');
    // RGB carries no alpha: no soft mask may be invented for it.
    expect(image.dict).not.toContain('/SMask');
    expect(image.samples).toEqual(pixels);
  });

  it('keeps RGBA (colour type 6) samples and transparency in an SMask', async () => {
    const pixels = Uint8Array.from([
      10, 20, 30, 255,
      40, 50, 60, 128,
      70, 80, 90, 255,
      100, 110, 120, 0,
    ]);
    const png = await makePng(2, 2, 6, pixels);
    const pdf = await pngToPdf(png);

    const image = await pdfImage(pdf, 'DeviceRGB');
    expect(image.dict).toContain('/Width 2 /Height 2');
    expect(image.dict).toContain('/SMask');
    expect(image.samples).toEqual(
      Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
    );

    const mask = await pdfImage(pdf, 'DeviceGray');
    expect(mask.dict).toContain('/Width 2 /Height 2');
    expect(mask.samples).toEqual(Uint8Array.from([255, 128, 255, 0]));
  });
});
