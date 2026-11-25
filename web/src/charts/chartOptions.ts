/**
 * ECharts option builders.
 *
 * One builder per chart family, all producing an `EChartsOption` for the **SVG**
 * renderer. Two families are drawn with ECharts' genuine `custom` series rather than a
 * canvas overlay, which is what keeps them vector-exportable:
 *
 *   - **violin**: a KDE density outline plus quartile rules. ECharts has no native
 *     violin type; drawing it from `polygon`/`line` shapes keeps it as real SVG paths.
 *   - **error bar**: capped mean ± spread bars. ECharts has no native error-bar series.
 *
 * Axis strategy per type (the part that is easy to get wrong):
 *
 *   type        | x axis                                  | y axis
 *   ------------|-----------------------------------------|------------------
 *   line/bar    | value (`No.N` row index)                | value (log optional)
 *   histogram   | value (bin centre)                      | value (count)
 *   scatter     | value                                   | value
 *   regression  | value                                   | value
 *   boxplot     | category (one slot per attached column) | value (log optional)
 *   violin      | category                                | value (density)
 *   errorBar    | category                                | value
 *   heatmap     | category × category (correlation)       | —
 */
import type {
  CustomSeriesOption,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
  SeriesOption,
} from 'echarts';

import {
  correlationMatrix,
  errorBarValues,
  fiveNumberSummary,
  histogram,
  kernelDensity,
  linearRegression,
  mean,
  outliers,
  stdDev,
} from '../core/stats.ts';
import { applySmoothing, type SmoothingOptions } from '../core/Smoothing.ts';
import type { ChartConfig, ChartSource } from './chartModel.ts';
import { chartConfigForPanel, resolveSeries } from './chartModel.ts';
import { lineColor } from './palette.ts';
import { chartTypeDef } from './chartTypes.ts';

/**
 * Cap on plotted points for line/scatter-based types.
 *
 * ECharts draws every scatter symbol as its own SVG path, so the cap bounds both the
 * render cost and the size of an exported vector file (10 000 points produced a ~1 MB
 * SVG; 5 000 keeps the cloud's shape while staying a practical figure to publish).
 */
export const CHART_DISPLAY_POINT_LIMIT = 5_000;
/** KDE curve resolution — smooth enough visually without bloating the SVG. */
const KDE_SAMPLES = 96;

/**
 * `Extract<SeriesOption, { type: 'custom' }>` resolves to `never` in ECharts 6 (the
 * discriminant is optional on the union members), which would silently widen every cast
 * to `any`. The package re-exports the real custom-series types, so those are used
 * directly and the `renderItem` signature stays checked.
 */
type RenderItemResult = CustomSeriesRenderItemReturn;

export interface BuildContext {
  config: ChartConfig;
  smoothing: SmoothingOptions;
  /**
   * Unit shared by every plotted y column, or absent.
   *
   * The caller derives it at render time (units v1: a unit is never stored on the data, see
   * decisions/2026-11-18-units-v1.md §三) and passes it ONLY when every drawn y source
   * resolves to the same `recognized` unit. An axis title is a claim about the numbers on
   * it, so a mixed or unconfirmed set must leave it out rather than say something false.
   */
  yAxisUnit?: string;
  /** Localised axis/tooltip labels, resolved by the caller (keeps this module i18n-free). */
  strings: {
    rowIndex: string;
    value: string;
    count: string;
    density: string;
    correlation: string;
    quartiles: string;
    /** Axis name for a histogram's value axis (bin centres), not the row index. */
    binCentre: string;
    /** Legend name for the mean/error series, e.g. `Mean ± SD`. */
    mean: string;
    outliers: string;
    secondAxis: string;
    drawnOfTotal: (drawn: number, total: number) => string;
  };
}

/** Values of a source with the card's smoothing applied. */
function smoothed(source: ChartSource, smoothing: SmoothingOptions): number[] {
  return applySmoothing(source.raw, smoothing);
}

/** Strip NaN/Infinity so ECharts does not plot artefacts. */
function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Series builders — exported so tests can assert each type's shape directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Explicit axis ranges for the types whose axis extent cannot be inferred from the
 * series data.
 *
 * ECharts infers a value axis from the numbers it is given, which is wrong for the
 * hand-rendered types: a violin plots *density* on y while its data values live on x,
 * so without an explicit range the density curve is scaled against the data extent.
 */
export interface AxisBounds {
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
}

export interface BuiltChart {
  series: SeriesOption[];
  bounds: AxisBounds;
}

/** Ids of the `dataZoom` components the option installs, in draw order. */
export const ZOOM_COMPONENT_IDS = ['zoom-x', 'zoom-y'] as const;

export function buildSeries(context: BuildContext): SeriesOption[] {
  let series: SeriesOption[];
  switch (context.config.type) {
    case 'line':
      series = lineSeries(context);
      break;
    case 'bar':
      series = barSeries(context);
      break;
    case 'scatter':
      series = scatterSeries(context);
      break;
    case 'regression':
      series = regressionSeries(context);
      break;
    case 'histogram':
      series = histogramSeries(context);
      break;
    case 'boxplot':
      series = boxplotSeries(context);
      break;
    case 'violin':
      series = violinSeries(context);
      break;
    case 'errorBar':
      series = errorBarSeries(context);
      break;
    case 'heatmap':
      series = heatmapSeries(context);
      break;
    default:
      series = [];
  }
  return [
    ...applyVectorAnnotations(series, context),
    ...smallSamplePointSeries(context),
  ];
}

// ── line / bar ─────────────────────────────────────────────────────────────

function yAxisIndexFor(config: ChartConfig, index: number): number {
  return config.secondAxis && index % 2 === 1 ? 1 : 0;
}

function lineSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const xData = config.xAxisSource?.raw;
  return config.sources.map((source, index) => {
    const values = smoothed(source, smoothing);
    const points = new Array<{ x: number; y: number }>(values.length);
    for (let i = 0; i < values.length; i++) {
      points[i] = { x: xData ? xData[i] ?? i + 1 : i + 1, y: values[i] };
    }
    return {
      name: source.label,
      type: 'line',
      data: thin(points),
      showSymbol: values.length <= 2,
      lineStyle: { width: 1.6, color: lineColor(index) },
      itemStyle: { color: lineColor(index) },
      emphasis: { focus: 'series' },
      animation: false,
      yAxisIndex: yAxisIndexFor(config, index),
    };
  });
}

function barSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const xData = config.xAxisSource?.raw;
  return config.sources.map((source, index) => {
    const values = smoothed(source, smoothing);
    const data: Array<[number, number]> = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      data[i] = [xData ? xData[i] ?? i + 1 : i + 1, values[i]];
    }
    return {
      name: source.label,
      type: 'bar',
      data,
      stack: config.layout === 'stacked' ? 'total' : undefined,
      large: true,
      largeThreshold: 4000,
      itemStyle: { color: lineColor(index) },
      emphasis: { focus: 'series' },
      animation: false,
      yAxisIndex: yAxisIndexFor(config, index),
    };
  });
}

// ── scatter / regression ───────────────────────────────────────────────────

function scatterSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const out: SeriesOption[] = [];

  resolveSeries(config).forEach((entry, index) => {
    const points = thin(entry.points);
    out.push({
      name: entry.label,
      type: 'scatter',
      data: points,
      symbolSize: 5,
      itemStyle: { color: lineColor(index), opacity: 0.75 },
      large: true,
      largeThreshold: 2000,
      animation: false,
    });
    if (config.showFitLine) {
      const fit = fitOverlay(entry.points, entry.label, index, config);
      if (fit) out.push(fit);
    }
  });

  return out;
}

function regressionSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const out: SeriesOption[] = [];

  resolveSeries(config).forEach((entry, index) => {
    out.push({
      name: entry.label,
      type: 'scatter',
      data: thin(entry.points),
      symbolSize: 5,
      itemStyle: { color: lineColor(index), opacity: 0.5 },
      large: true,
      largeThreshold: 2000,
      animation: false,
    });
    const fit = fitOverlay(entry.points, entry.label, index, config);
    if (fit) out.push(fit);
  });

  return out;
}

/** Deterministic min/max bucket thinning that never drops a finite y envelope point. */
function thin(points: ReadonlyArray<{ x: number; y: number }>): Array<[number, number]> {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length <= CHART_DISPLAY_POINT_LIMIT) {
    return clean.map((point) => [point.x, point.y] as [number, number]);
  }

  const selected = new Set<number>([0, clean.length - 1]);
  const interior = clean.length - 2;
  const bucketCount = Math.max(1, Math.floor((CHART_DISPLAY_POINT_LIMIT - 2) / 2));

  for (let bucket = 0; bucket < bucketCount; ++bucket) {
    const start = 1 + Math.floor((interior * bucket) / bucketCount);
    const end = Math.min(clean.length - 1, 1 + Math.floor((interior * (bucket + 1)) / bucketCount));
    if (start >= end) continue;

    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; ++index) {
      if (clean[index].y < clean[minIndex].y) minIndex = index;
      if (clean[index].y > clean[maxIndex].y) maxIndex = index;
    }
    selected.add(minIndex);
    selected.add(maxIndex);
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => [clean[index].x, clean[index].y] as [number, number]);
}

/**
 * OLS fit line over a scatter. The R²/slope annotation goes in the series name so it
 * appears in the tooltip, and the name is filtered out of the legend by `legendNames`.
 */
function fitOverlay(
  points: Array<{ x: number; y: number }>,
  label: string,
  index: number,
  config: ChartConfig,
): SeriesOption | null {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 2) return null;

  const fit = linearRegression(
    clean.map((point) => point.x),
    clean.map((point) => point.y),
  );
  if (!fit) return null;

  const xs = clean.map((point) => point.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const color = lineColor(index);

  const steps = 32;
  const data: Array<[number, number]> = [];
  for (let i = 0; i <= steps; ++i) {
    const x = xMin + ((xMax - xMin) * i) / steps;
    data.push([x, fit.intercept + fit.slope * x]);
  }

  const sign = fit.intercept >= 0 ? '+' : '−';
  const name =
    `${label} — fit y=${fit.slope.toPrecision(4)}x${sign}${Math.abs(fit.intercept).toPrecision(4)}, ` +
    `R²=${fit.r2.toFixed(4)}, n=${fit.n}`;

  void config;
  return {
    name,
    type: 'line',
    data,
    showSymbol: false,
    silent: true,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    z: 10,
    animation: false,
  };
}

// ── histogram ──────────────────────────────────────────────────────────────

function histogramSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const source = config.sources[0];
  if (!source) return [];

  const values = smoothed(source, smoothing);
  const result = histogram(values, config.binCount > 0 ? config.binCount : undefined);
  const data = result.bins.map((bin) => [bin.centre, bin.count] as [number, number]);

  return [
    {
      name: source.label,
      type: 'bar',
      data,
      barWidth: '92%',
      large: true,
      itemStyle: {
        color: lineColor(0),
        opacity: 0.85,
        // Hairline outline keeps adjacent bins separated when printed in greyscale.
        borderColor: 'rgba(0,0,0,0.28)',
        borderWidth: 0.6,
      },
      animation: false,
    },
  ];
}

// ── boxplot ────────────────────────────────────────────────────────────────

function boxplotSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  const summaries = config.sources.map((source) => fiveNumberSummary(smoothed(source, smoothing)));
  const boxData = summaries.map((summary) => [
    summary.min,
    summary.q1,
    summary.median,
    summary.q3,
    summary.max,
  ]);

  const series: SeriesOption[] = [
    {
      name: strings.quartiles,
      type: 'boxplot',
      data: boxData,
      boxWidth: ['22%', '58%'],
      itemStyle: {
        color: 'rgba(0, 114, 178, 0.18)',
        borderColor: lineColor(0),
        borderWidth: 1.6,
      },
      emphasis: { itemStyle: { borderWidth: 2.4 } },
      animation: false,
    },
  ];

  const outlierPoints: Array<[number, number]> = [];
  config.sources.forEach((source, index) => {
    for (const value of outliers(smoothed(source, smoothing))) {
      outlierPoints.push([index, value]);
    }
  });
  if (outlierPoints.length > 0 && outlierPoints.length <= CHART_DISPLAY_POINT_LIMIT) {
    series.push({
      name: strings.outliers,
      type: 'scatter',
      data: outlierPoints,
      symbolSize: 3.5,
      itemStyle: { color: 'rgba(213, 94, 0, 0.8)' },
      animation: false,
    });
  }

  return series;
}

// ── violin (custom series — no native ECharts type) ────────────────────────

interface ViolinShape {
  curve: Array<{ x: number; y: number }>;
  summary: ReturnType<typeof fiveNumberSummary>;
}

/** Half-width of a violin in pixels. A fixed width keeps violins readable side by side
 *  regardless of the density scale, which is how Matplotlib/Seaborn draw them. */
const VIOLIN_HALF_WIDTH_PX = 42;

function violinSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  // Pre-compute every curve: `renderItem` is called per item on each render, so it must
  // stay cheap and must not recompute the KDE.
  const shapes: ViolinShape[] = config.sources.map((source) => {
    const values = finite(smoothed(source, smoothing));
    return { curve: kernelDensity(values, KDE_SAMPLES), summary: fiveNumberSummary(values) };
  });

  const series: SeriesOption[] = [
    {
      name: strings.density,
      type: 'custom',
      // One data item per attached column; the value drives the tooltip.
      data: shapes.map((shape, index) => ({
        value: [index, shape.summary.median],
        itemStyle: { color: lineColor(index), borderColor: lineColor(index) },
      })),
      clip: false,
      animation: false,
      z: 2,
      renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
        const index = Number(api.value(0));
        const shape = shapes[index];
        if (!shape || shape.curve.length < 3) return undefined;

        const centreX = api.coord([index, shape.summary.median])[0];
        const halfWidth = VIOLIN_HALF_WIDTH_PX;
        void params;

        const peak = shape.curve.reduce((best, point) => Math.max(best, point.y), 0);
        const left: Array<[number, number]> = [];
        const right: Array<[number, number]> = [];
        for (const point of shape.curve) {
          const y = api.coord([index, point.x])[1];
          const w = peak > 0 ? (point.y / peak) * halfWidth : 0;
          left.push([centreX - w, y]);
          right.push([centreX + w, y]);
        }
        const outline = [...right, ...left.reverse()];

        const color = lineColor(index);
        const rule = (value: number, dashed: boolean) => ({
          type: 'line',
          shape: {
            x1: centreX - halfWidth,
            y1: api.coord([index, value])[1],
            x2: centreX + halfWidth,
            y2: api.coord([index, value])[1],
          },
          style: {
            stroke: color,
            lineWidth: dashed ? 1 : 1.8,
            lineDash: dashed ? [3, 3] : undefined,
          },
        });

        return {
          type: 'group',
          children: [
            {
              type: 'polygon',
              shape: { points: outline },
              style: { fill: withAlpha(color, 0.22), stroke: color, lineWidth: 1.4 },
            },
            rule(shape.summary.q1, true),
            rule(shape.summary.q3, true),
            rule(shape.summary.median, false),
          ],
        } as unknown as RenderItemResult;
      },
    },
  ];

  return series;
}

// ── error bar (custom series — no native ECharts type) ─────────────────────

interface ErrorStat {
  centre: number;
  spread: number;
  count: number;
}

function errorBarSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  const stats: ErrorStat[] = config.sources.map((source) => {
    const values = finite(smoothed(source, smoothing));
    return {
      centre: values.length > 0 ? mean(values) : NaN,
      spread: values.length > 0 ? errorBarValues(values, config.errorKind) : NaN,
      count: values.length,
    };
  });

  const capHalf = Math.max(4, config.capWidth * 40);

  const drawn: CustomSeriesOption = {
    // Deliberately unnamed: an unnamed series never gets its own legend entry, while the
    // labelled backing scatter owns the legend. This avoids a duplicate entry without
    // relying on a private flag ECharts would not understand.
    type: 'custom',
    data: stats.map((stat, index) => ({
      value: [index, stat.centre],
      itemStyle: { color: lineColor(index) },
    })),
    clip: false,
    animation: false,
    z: 3,
    renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
      const index = Number(api.value(0));
      const stat = stats[index];
      if (!stat || !Number.isFinite(stat.centre)) return undefined;

      const color = lineColor(index);
      const [cx, cy] = api.coord([index, stat.centre]);
      const yTop = api.coord([index, stat.centre + stat.spread])[1];
      const yBottom = api.coord([index, stat.centre - stat.spread])[1];

      const line = (x1: number, y1: number, x2: number, y2: number) => ({
        type: 'line',
        shape: { x1, y1, x2, y2 },
        style: { stroke: color, lineWidth: 1.6 },
      });

      return {
        type: 'group',
        children: [
          line(cx, yTop, cx, yBottom),
          line(cx - capHalf, yTop, cx + capHalf, yTop),
          line(cx - capHalf, yBottom, cx + capHalf, yBottom),
          {
            type: 'circle',
            shape: { cx, cy, r: 4 },
            style: { fill: color, stroke: '#ffffff', lineWidth: 1 },
          },
        ],
      } as unknown as RenderItemResult;
    },
  };

  // A plain scatter shares the tooltip/legend machinery, and gives the axis a real
  // series to scale against even when the error bars are zero-width.
  const backing: SeriesOption = {
    name: strings.mean,
    type: 'scatter',
    data: stats.map((stat, index) => [index, stat.centre] as [number, number]),
    symbolSize: 9,
    itemStyle: { color: (params: { dataIndex: number }) => lineColor(params.dataIndex) },
    animation: false,
  };

  return [backing, drawn];
}

// ── heatmap / correlation matrix ───────────────────────────────────────────

function heatmapSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;
  const series = config.sources.map((source) => smoothed(source, smoothing));
  const matrix = correlationMatrix(series);

  const data: Array<[number, number, number]> = [];
  for (let row = 0; row < matrix.length; ++row) {
    for (let col = 0; col < matrix[row].length; ++col) {
      // `pearson()` returns NaN where a correlation is *undefined* (a constant column has
      // no variance, so there is nothing to correlate). ECharts skips NaN cells, which
      // keeps the distinction visible; coercing to 0 used to paint it as "no correlation".
      data.push([col, row, matrix[row][col]]);
    }
  }

  return [
    {
      name: strings.correlation,
      type: 'heatmap',
      data,
      label: {
        show: matrix.length <= 8,
        formatter: (params: { value: unknown }) => {
          const value = params.value as [number, number, number];
          return Number.isFinite(value[2]) ? value[2].toFixed(2) : '—';
        },
        fontSize: 9,
      },
      itemStyle: { borderColor: 'rgba(255,255,255,0.6)', borderWidth: 0.6 },
      emphasis: { itemStyle: { borderColor: '#333333', borderWidth: 1 } },
      animation: false,
    },
  ];
}

function applyVectorAnnotations(
  base: SeriesOption[],
  context: BuildContext,
): SeriesOption[] {
  const { config } = context;
  const series = base.slice();

  if (config.pointLabels !== 'none') {
    for (const entry of series) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === 'string' && name.includes('fit y=')) continue;
      (entry as SeriesOption & { label: Record<string, unknown> }).label = {
        show: true,
        position: 'top',
        distance: 5,
        fontSize: 9,
        formatter: (params: { value?: unknown; seriesName?: unknown }) =>
          pointLabel(config.type, config.pointLabels, params),
      };
    }
  }

  const carrier = series[0] as
    | (SeriesOption & { markLine?: Record<string, unknown>; markArea?: Record<string, unknown> })
    | undefined;
  if (carrier && config.referenceLines.length > 0) {
    carrier.markLine = {
      silent: true,
      symbol: 'none',
      label: {
        show: true,
        position: 'insideEndTop',
        formatter: (params: { name?: unknown }) => String(params.name ?? ''),
        fontSize: 10,
      },
      lineStyle: { width: 1.4, type: 'dashed', color: '#a23b2a' },
      data: config.referenceLines.map((line) => ({
        name: line.label,
        [line.axis === 'x' ? 'xAxis' : 'yAxis']: line.value,
        lineStyle: { color: '#a23b2a' },
      })),
    };
  }
  if (carrier && config.acceptedRanges.length > 0) {
    carrier.markArea = {
      silent: true,
      label: {
        show: true,
        position: 'insideTop',
        formatter: (params: { name?: unknown }) => String(params.name ?? ''),
        color: '#365c49',
        fontSize: 10,
      },
      itemStyle: { color: 'rgba(78, 145, 105, 0.16)', borderColor: 'rgba(45, 105, 66, 0.45)' },
      data: config.acceptedRanges.flatMap((range) => {
        const key = range.axis === 'x' ? 'xAxis' : 'yAxis';
        return [
          [
            { [key]: range.lower, name: range.label },
            { [key]: range.upper },
          ],
        ];
      }),
    };
  }

  return [...series, ...limitOverlaySeries(context, series)];
}

function pointLabel(
  type: ChartConfig['type'],
  mode: ChartConfig['pointLabels'],
  params: { value?: unknown; seriesName?: unknown },
): string {
  if (mode === 'name') return String(params.seriesName ?? '');

  const value = params.value;
  if (!Array.isArray(value)) return typeof value === 'number' ? formatTooltipNumber(value) : '';
  const ordinate =
    type === 'boxplot' ? 2 : type === 'heatmap' ? value.length - 1 : Math.min(1, value.length - 1);
  const point = value[ordinate];
  return typeof point === 'number' ? formatTooltipNumber(point) : String(point ?? '');
}

interface LimitPoint {
  x: number;
  y: number;
  value: number;
  yAxisIndex: number;
}

function limitOverlaySeries(context: BuildContext, series: SeriesOption[]): SeriesOption[] {
  const limit = context.config.limitRange;
  if (!limit || (limit.lower === null && limit.upper === null)) return [];

  const points = limitPoints(context, series);
  const outside = points.filter((point) => {
    const value = limit.axis === 'x' ? point.x : limit.axis === 'y' ? point.y : point.value;
    if (!Number.isFinite(value)) return false;
    return (limit.lower !== null && value < limit.lower) ||
      (limit.upper !== null && value > limit.upper);
  });

  const byAxis = new Map<number, LimitPoint[]>();
  for (const point of outside) {
    const group = byAxis.get(point.yAxisIndex) ?? [];
    group.push(point);
    byAxis.set(point.yAxisIndex, group);
  }

  return [...byAxis].map(([yAxisIndex, group]) => ({
    type: 'scatter',
    data: group.map((point) => [point.x, point.y] as [number, number]),
    symbolSize: 7,
    symbol: 'circle',
    silent: true,
    itemStyle: { color: '#c83232', opacity: 0.92, borderColor: '#ffffff', borderWidth: 1 },
    label:
      context.config.pointLabels === 'none'
        ? { show: false }
        : {
            show: true,
            position: 'top',
            fontSize: 9,
            formatter: (params: { value?: unknown }) =>
              pointLabel(context.config.type, 'value', params),
          },
    yAxisIndex,
    z: 20,
    animation: false,
  }));
}

function limitPoints(context: BuildContext, series: SeriesOption[]): LimitPoint[] {
  const { config } = context;
  if (
    config.type === 'line' ||
    config.type === 'scatter' ||
    config.type === 'regression' ||
    config.type === 'bar'
  ) {
    return resolveSeries(config).flatMap((entry, index) =>
      entry.points
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point) => ({
          x: point.x,
          y: point.y,
          value: point.y,
          yAxisIndex: yAxisIndexFor(config, index),
        })),
    );
  }

  if (config.type === 'boxplot' || config.type === 'violin' || config.type === 'errorBar') {
    return config.sources.flatMap((source, index) =>
      finite(source.raw).map((value) => ({
        x: index,
        y: value,
        value,
        yAxisIndex: 0,
      })),
    );
  }

  const data = (series[0] as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 2) return [];
    const x = Number(item[0]);
    const y = Number(item[1]);
    const value = Number(item[item.length - 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(value)) return [];
    return [{ x, y, value, yAxisIndex: 0 }];
  });
}

const SMALL_SAMPLE_THRESHOLD = 15;
const RAW_POINT_JITTER = 0.34;

function smallSamplePointSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  if (config.rawPointMode === 'never') return [];
  if (
    config.type !== 'bar' &&
    config.type !== 'boxplot' &&
    config.type !== 'violin' &&
    config.type !== 'errorBar'
  ) {
    return [];
  }

  return config.sources.flatMap((source, sourceIndex) => {
    const values =
      config.type === 'bar'
        ? source.raw
            .map((value, row) => ({
              x: config.xAxisSource?.raw[row] ?? row + 1,
              y: value,
            }))
            .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        : finite(source.raw).map((value) => ({ x: sourceIndex, y: value }));
    if (
      values.length === 0 ||
      (config.rawPointMode === 'auto' && values.length >= SMALL_SAMPLE_THRESHOLD)
    ) {
      return [];
    }

    return [
      {
        name: source.label,
        type: 'scatter' as const,
        data: values.map((point, index) => {
          const jitter =
            (((index * 0.61803398875 + sourceIndex * 0.17320508076) % 1) - 0.5) *
            RAW_POINT_JITTER;
          return [point.x + jitter, point.y] as [number, number];
        }),
        symbolSize: 5,
        symbol: 'circle',
        itemStyle: {
          color: lineColor(sourceIndex),
          opacity: 0.68,
          borderColor: '#ffffff',
          borderWidth: 0.7,
        },
        label:
          config.pointLabels === 'none'
            ? { show: false }
            : {
                show: true,
                position: 'right',
                distance: 3,
                fontSize: 9,
                formatter: (params: { value?: unknown }) =>
                  pointLabel(config.type, config.pointLabels, {
                    ...params,
                    seriesName: source.label,
                  }),
              },
        z: 12,
        animation: false,
      },
    ];
  });
}

/**
 * Axis ranges that ECharts cannot infer.
 *
 * The hand-rendered types plot something other than the raw column values on y
 * (violin: density, errorBar: mean), so their extent has to be stated explicitly —
 * otherwise the curve is drawn against the wrong scale.
 */
export function computeBounds(context: BuildContext): AxisBounds {
  const { config, smoothing } = context;

  // Violin: the outline is drawn along the *value* axis (the KDE curve spans the sample
  // range, and the ribbon width encodes density — normalised to the peak in renderItem).
  // So the range is the data extent, exactly like a box plot, plus room for the
  // mirrored edge padding of the density estimate.
  if (config.type === 'violin') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      lo = Math.min(lo, Math.min(...values));
      hi = Math.max(hi, Math.max(...values));
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  // Error bar: the whiskers extend past the means, so pad the observed extent.
  if (config.type === 'errorBar') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      const centre = mean(values);
      const spread = errorBarValues(values, config.errorKind);
      if (!Number.isFinite(centre) || !Number.isFinite(spread)) continue;
      lo = Math.min(lo, centre - spread);
      hi = Math.max(hi, centre + spread);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  // Box plot: the whiskers span min..max, and outliers can escape that range.
  if (config.type === 'boxplot') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      lo = Math.min(lo, Math.min(...values));
      hi = Math.max(hi, Math.max(...values));
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.06;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  return {};
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared option scaffolding
// ═══════════════════════════════════════════════════════════════════════════

type AxisKind = 'value' | 'log' | 'category';

/** Which x-axis form each chart type needs. */
function xAxisKind(config: ChartConfig): AxisKind {
  switch (config.type) {
    case 'boxplot':
    case 'violin':
    case 'errorBar':
      return 'category';
    default:
      return 'value';
  }
}

export function buildOption(context: BuildContext): EChartsOption {
  const composition = context.config.composition;
  if (composition && composition.panels.length > 1) {
    return buildComposedOption(context);
  }
  return buildSingleOption(context);
}

function buildSingleOption(context: BuildContext): EChartsOption {
  const { config, strings } = context;
  const series = buildSeries(context);
  const categories = config.sources.map((source) => source.label);
  const isHeatmap = config.type === 'heatmap';
  // When an explicit X-axis source is set, the X axis is always a value axis regardless
  // of chart type — this enables time-series and arbitrary X plots.
  const hasExplicitX = config.xAxisSource !== null;
  const kind: AxisKind = isHeatmap ? 'category' : hasExplicitX ? 'value' : xAxisKind(config);

  const xAxis =
    kind === 'category'
      ? {
          type: 'category' as const,
          data: categories,
          name: config.type === 'histogram' ? '' : undefined,
          nameLocation: 'end' as const,
          axisLabel: {
            fontSize: 10,
            interval: 0,
            rotate: categories.length > 6 ? 30 : 0,
          },
          splitLine: { show: isHeatmap, lineStyle: { color: 'rgba(128,128,128,0.15)' } },
        }
      : {
          type: config.xLogScale ? ('log' as const) : ('value' as const),
          scale: true,
          // The x axis is only "the row index" for the types that really plot against it.
          // A histogram plots bin *centres* and a scatter/regression plots the first column
          // of each pair, so labelling those "No." was simply wrong.
          name: hasExplicitX
            ? config.xAxisSource!.label
            : config.type === 'histogram'
              ? strings.binCentre
              : config.type === 'scatter' || config.type === 'regression'
                ? config.sources[0]?.label
                : strings.rowIndex,
          nameLocation: 'end' as const,
          axisLabel: { fontSize: 10 },
          minorTick: config.xLogScale
            ? { show: true, splitNumber: 9, length: 4 }
            : { show: false },
          minorSplitLine: config.xLogScale
            ? { show: true, lineStyle: { color: 'rgba(128,128,128,0.08)' } }
            : { show: false },
          splitLine: { show: true, lineStyle: { color: 'rgba(128,128,128,0.18)' } },
        };

  /**
   * Unit suffix for the value axis — never for a histogram (it counts occurrences) and
   * never for a heatmap (its "value" is a correlation coefficient, not the column's unit).
   * The dual-axis case is left alone too: two axes can carry two different units, and the
   * caller only reports a single shared one.
   */
  const yAxisUnit =
    config.type === 'histogram' || isHeatmap ? undefined : context.yAxisUnit;
  const yAxisName =
    config.type === 'histogram'
      ? strings.count
      : config.type === 'heatmap'
        ? ''
        : yAxisUnit
          ? `${strings.value} (${yAxisUnit})`
          : strings.value;

  // Explicit bounds where the plotted quantity differs from the column values.
  const bounds = computeBounds(context);
  const hasFixedRange = bounds.yMin !== undefined && bounds.yMax !== undefined;

  const primaryYAxis: NonNullable<EChartsOption['yAxis']> = {
    // Bar charts stay linear even with the log toggle on: a bar of height 0 has no
    // representable position on a log axis.
    type: config.logScale && config.type !== 'bar' ? 'log' : 'value',
    // `scale: true` lets ECharts tighten the axis to the data; with a stated range the
    // range wins, and a log axis may not contain zero.
    scale: !hasFixedRange,
    min: config.logScale ? undefined : bounds.yMin,
    max: bounds.yMax,
    name: yAxisName,
    nameLocation: 'end' as const,
    axisLabel: {
      fontSize: 10,
      formatter: (value: number) => formatAxisNumber(value),
    },
    minorTick: config.logScale
      ? { show: true, splitNumber: 9, length: 4 }
      : { show: false },
    minorSplitLine: config.logScale
      ? { show: true, lineStyle: { color: 'rgba(128,128,128,0.08)' } }
      : { show: false },
    splitLine: { show: true, lineStyle: { color: 'rgba(128,128,128,0.18)' } },
  };

  const heatmapYAxis = {
    type: 'category' as const,
    data: categories,
    axisLabel: { fontSize: 10, interval: 0 },
  };

  const option: EChartsOption = {
    animation: false,
    grid: {
      left: 64,
      right: config.secondAxis && !isHeatmap ? 74 : 22,
      top: 32,
      bottom: isHeatmap ? 74 : 80,
      containLabel: false,
    },
    legend: {
      // `data` must be supplied explicitly: the fit-line series have long generated
      // names that should stay out of the legend while remaining present on the chart.
      data: isHeatmap ? [] : legendNames(series),
      show: !isHeatmap && legendNames(series).length > 0,
      type: 'scroll',
      bottom: 38,
      textStyle: { fontSize: 11 },
    },
    tooltip: {
      trigger: isHeatmap ? 'item' : 'axis',
      confine: true,
      axisPointer: { type: isHeatmap ? 'none' : 'cross' },
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? formatTooltipNumber(value) : String(value),
    },
    dataZoom: isHeatmap
      ? []
      : [
          // Both axes are zoomable by wheel/drag. `filterMode: 'none'` keeps the data
          // extent intact so a zoom is purely a view change and is fully reversible —
          // see the "reset zoom" control in the axes panel.
          { id: 'zoom-x', type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { id: 'zoom-y', type: 'inside', yAxisIndex: 0, filterMode: 'none' },
        ],
    xAxis,
    yAxis: isHeatmap ? heatmapYAxis : primaryYAxis,
    series: series as EChartsOption['series'],
  };

  if (config.secondAxis && !isHeatmap) {
    option.yAxis = [
      primaryYAxis as never,
      {
        type: config.logScale ? 'log' : 'value',
        scale: !hasFixedRange,
        min: config.logScale ? undefined : bounds.yMin,
        max: bounds.yMax,
        position: 'right',
        name: strings.secondAxis,
        nameLocation: 'end',
        axisLabel: { fontSize: 10, formatter: (value: number) => formatAxisNumber(value) },
        minorTick: config.logScale
          ? { show: true, splitNumber: 9, length: 4 }
          : { show: false },
        minorSplitLine: config.logScale
          ? { show: true, lineStyle: { color: 'rgba(128,128,128,0.08)' } }
          : { show: false },
        splitLine: { show: false },
      } as never,
    ];
  }

  const pointCounts = displayedPointCounts(context, series);
  if (pointCounts && pointCounts.drawn < pointCounts.total) {
    option.graphic = [
      {
        elements: [
          {
            type: 'text',
            right: 8,
            top: 6,
            style: {
              text: strings.drawnOfTotal(pointCounts.drawn, pointCounts.total),
              fill: 'rgba(80,80,80,0.88)',
              font: '10px sans-serif',
            },
            z: 100,
          },
        ],
      },
    ];
  }

  if (isHeatmap) {
    option.visualMap = [
      {
        min: -1,
        max: 1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        itemWidth: 14,
        itemHeight: 200,
        precision: 2,
        textStyle: { fontSize: 10 },
        // Diverging scale: negative (blue) → none (white) → positive (red).
        inRange: { color: ['#3b6ea5', '#9ecae1', '#f7f7f7', '#fcae91', '#c83232'] },
      },
    ];
  }

  return option;
}

interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function panelRects(panelCount: number, columns: 1 | 2): PanelRect[] {
  const columnCount = Math.min(columns, panelCount);
  const rowCount = Math.ceil(panelCount / columnCount);
  const leftMargin = 10;
  const rightMargin = 3;
  const topMargin = 9;
  const bottomMargin = 13;
  const gapX = 4;
  const gapY = 6;
  const width =
    (100 - leftMargin - rightMargin - gapX * (columnCount - 1)) / columnCount;
  const height =
    (100 - topMargin - bottomMargin - gapY * (rowCount - 1)) / rowCount;

  return Array.from({ length: panelCount }, (_, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    return {
      left: leftMargin + column * (width + gapX),
      top: topMargin + row * (height + gapY),
      width,
      height,
    };
  });
}

function xExtent(config: ChartConfig): [number, number] | null {
  const def = chartTypeDef(config.type);
  if (config.type === 'boxplot' || config.type === 'violin' || config.type === 'errorBar' ||
      config.type === 'heatmap') {
    return null;
  }
  const values =
    config.type === 'histogram'
      ? config.sources[0]?.raw ?? []
      : resolveSeries(config).flatMap((entry) => entry.points.map((point) => point.x));
  const finiteValues = values.filter(
    (value) => Number.isFinite(value) && (!config.xLogScale || value > 0),
  );
  if (finiteValues.length === 0 || def.columnArity === 'matrix') return null;
  let min = Infinity;
  let max = -Infinity;
  for (const value of finiteValues) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

function buildComposedOption(context: BuildContext): EChartsOption {
  const { composition } = context.config;
  if (!composition) return buildSingleOption(context);

  const rects = panelRects(composition.panels.length, composition.columns);
  const grid: Array<Record<string, unknown>> = [];
  const xAxes: Array<Record<string, unknown>> = [];
  const yAxes: Array<Record<string, unknown>> = [];
  const series: SeriesOption[] = [];
  const titles: Array<Record<string, unknown>> = [];
  const visualMaps: Array<Record<string, unknown>> = [];
  const dataZoom: Array<Record<string, unknown>> = [];
  const graphics: Array<Record<string, unknown>> = [];
  const extents = composition.panels.map((panel) =>
    xExtent(chartConfigForPanel(context.config, panel)),
  );
  const sharedExtent = composition.shareXRange
    ? extents.reduce<[number, number] | null>((combined, extent) => {
        if (!extent) return combined;
        return combined
          ? [Math.min(combined[0], extent[0]), Math.max(combined[1], extent[1])]
          : extent;
      }, null)
    : null;
  const legendNames: string[] = [];

  composition.panels.forEach((panel, panelIndex) => {
    const rect = rects[panelIndex];
    const config = chartConfigForPanel(context.config, panel);
    const panelContext = { ...context, config };
    const panelOption = buildSingleOption(panelContext);
    const panelSeries = Array.isArray(panelOption.series) ? panelOption.series : [];
    const panelX = (Array.isArray(panelOption.xAxis) ? panelOption.xAxis[0] : panelOption.xAxis) as
      | Record<string, unknown>
      | undefined;
    const panelY = (
      Array.isArray(panelOption.yAxis) ? panelOption.yAxis : [panelOption.yAxis]
    ).filter(Boolean) as Array<Record<string, unknown>>;
    const xAxisIndex = panelIndex;
    const yStart = yAxes.length;

    grid.push({
      left: `${rect.left}%`,
      top: `${rect.top}%`,
      width: `${rect.width}%`,
      height: `${rect.height}%`,
      containLabel: false,
    });
    titles.push({
      text: panel.label,
      left: `${rect.left}%`,
      top: `${Math.max(0, rect.top - 4)}%`,
      textStyle: { fontSize: 11, fontWeight: 600 },
    });

    if (panelX) {
      const rowCount = Math.ceil(composition.panels.length / Math.min(composition.columns, composition.panels.length));
      const row = Math.floor(panelIndex / Math.min(composition.columns, composition.panels.length));
      xAxes.push({
        ...panelX,
        gridIndex: panelIndex,
        min: sharedExtent?.[0] ?? panelX.min,
        max: sharedExtent?.[1] ?? panelX.max,
        splitNumber: composition.shareXTicks ? 6 : panelX.splitNumber,
        alignTicks: composition.shareXTicks,
        axisLabel: {
          ...(panelX.axisLabel as Record<string, unknown> | undefined),
          show: !composition.shareXTicks || row === rowCount - 1,
        },
      });
    }
    panelY.forEach((axis, yIndex) => {
      yAxes.push({ ...axis, gridIndex: panelIndex, id: `panel-${panelIndex}-y-${yIndex}` });
    });

    const panelSeriesStart = series.length;
    panelSeries.forEach((entry) => {
      const yAxisIndex = Number((entry as { yAxisIndex?: unknown }).yAxisIndex ?? 0);
      series.push({
        ...entry,
        xAxisIndex,
        yAxisIndex: yStart + Math.min(yAxisIndex, Math.max(0, panelY.length - 1)),
      });
    });

    const panelVisualMaps = Array.isArray(panelOption.visualMap)
      ? panelOption.visualMap
      : panelOption.visualMap
        ? [panelOption.visualMap]
        : [];
    panelVisualMaps.forEach((visualMap) => {
      visualMaps.push({
        ...(visualMap as Record<string, unknown>),
        seriesIndex: panelSeriesStart,
        left: `${rect.left + rect.width / 2}%`,
        top: `${rect.top + rect.height + 1}%`,
        bottom: undefined,
        itemHeight: Math.max(40, Math.round(rect.width * 2)),
      });
    });

    dataZoom.push(
      { id: `zoom-x-${panelIndex}`, type: 'inside', xAxisIndex, filterMode: 'none' },
      { id: `zoom-y-${panelIndex}`, type: 'inside', yAxisIndex: yStart, filterMode: 'none' },
    );
    legendNames.push(...((panelOption.legend as { data?: string[] } | undefined)?.data ?? []));

    const counts = displayedPointCounts(panelContext, buildSeries(panelContext));
    if (counts && counts.drawn < counts.total) {
      graphics.push({
        type: 'text',
        left: `${rect.left + rect.width - 1}%`,
        top: `${rect.top + 2}%`,
        style: {
          text: context.strings.drawnOfTotal(counts.drawn, counts.total),
          textAlign: 'right',
          fill: 'rgba(80,80,80,0.88)',
          font: '10px sans-serif',
        },
        z: 100,
      });
    }
  });

  return {
    animation: false,
    title: titles,
    grid,
    xAxis: xAxes as EChartsOption['xAxis'],
    yAxis: yAxes as EChartsOption['yAxis'],
    series: series as EChartsOption['series'],
    visualMap: visualMaps as EChartsOption['visualMap'],
    dataZoom,
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross' },
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? formatTooltipNumber(value) : String(value),
    },
    legend: {
      data: [...new Set(legendNames)],
      show: legendNames.length > 0,
      type: 'scroll',
      bottom: 6,
      textStyle: { fontSize: 11 },
    },
    graphic: graphics.length > 0 ? [{ elements: graphics }] : undefined,
  };
}

function displayedPointCounts(
  context: BuildContext,
  series: SeriesOption[],
): { drawn: number; total: number } | null {
  const { type } = context.config;
  if (type !== 'line' && type !== 'scatter' && type !== 'regression') return null;

  const primary = series.filter((entry) => entry.type === (type === 'line' ? 'line' : 'scatter'));
  const resolved = resolveSeries(context.config);
  let drawn = 0;
  for (const entry of primary) {
    const data = (entry as { data?: unknown }).data;
    if (Array.isArray(data)) drawn += data.length;
  }
  const total = resolved.reduce((sum, entry) => sum + entry.points.length, 0);
  return { drawn, total };
}

/** Legend entries, excluding the fit lines whose names carry the regression statistics. */
function legendNames(series: SeriesOption[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of series) {
    const name = (entry as { name?: unknown }).name;
    // Unnamed series (the whisker geometry) and fit lines are drawn but kept out of the
    // legend — their generated names would only add clutter, and names are never repeated.
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name.includes('fit y=') || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e-3 && abs < 1e6) return String(Number(value.toPrecision(4)));
  return value.toExponential(1);
}

function formatTooltipNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  // Use plain notation where it stays readable, exponent form otherwise.
  if (abs >= 1e-4 && abs < 1e7) return String(Number(value.toPrecision(6)));
  return value.toExponential(4);
}

function withAlpha(color: string, alpha: number): string {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

export { stdDev };
