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
import type {
  ChartAnalysisOutput,
  ChartFilterOutput,
  ChartConfig,
  ChartSource,
} from './chartModel.ts';
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
  /** Unit carried by the Z/colour dimension of a field heatmap. */
  colorAxisUnit?: string;
  /** Server-produced fit/interval/diagnostic result; absent before an explicit run. */
  analysis?: ChartAnalysisOutput;
  /** Server-produced display-only low-pass/detrend curve. */
  displayFilter?: ChartFilterOutput;
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
  const grouped: Array<{ context: BuildContext; series?: SeriesOption[] }> =
    context.config.factorSource &&
    (context.config.factorMapping.color || context.config.factorMapping.shape)
      ? factorSeriesContexts(context)
      : [{ context }];
  const categoryFactor =
    context.config.factorSource &&
    (context.config.factorMapping.color || context.config.factorMapping.shape) &&
    ['boxplot', 'violin', 'errorBar'].includes(context.config.type)
      ? factorExpandedContext(context)
      : null;
  const seriesContexts = categoryFactor ? [{ context: categoryFactor }] : grouped;

  let series: SeriesOption[] = [];
  for (const entry of seriesContexts) {
    series.push(...(entry.series ?? buildBaseSeries(entry.context)));
  }
  const annotated = applyVectorAnnotations(series, context);
  const rawPoints = seriesContexts.flatMap((entry) => smallSamplePointSeries(entry.context));
  const strip = factorAnnotationSeries(context);
  const analysis = analysisOverlaySeries(context);
  const filteredRawOverlay = rawCurveOverlay(context);
  return [...annotated, ...rawPoints, ...strip, ...analysis, ...filteredRawOverlay];
}

function buildBaseSeries(context: BuildContext): SeriesOption[] {
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
  return series;
}

const FACTOR_SYMBOLS = ['circle', 'diamond', 'triangle', 'rect', 'roundRect', 'pin'] as const;

interface FactorGroup {
  code: number;
  label: string;
  indices: number[];
}

function factorGroups(config: ChartConfig): FactorGroup[] {
  const source = config.factorSource;
  if (!source) return [];
  const groups = new Map<number, FactorGroup>();
  for (let index = 0; index < source.raw.length; ++index) {
    const code = source.raw[index];
    if (!Number.isFinite(code) || !Number.isInteger(code)) continue;
    const current = groups.get(code);
    if (current) current.indices.push(index);
    else {
      groups.set(code, {
        code,
        label: source.categories?.[code] ?? String(code),
        indices: [index],
      });
    }
  }
  return [...groups.values()];
}

function filteredFactorConfig(config: ChartConfig, indices: number[]): ChartConfig {
  const filter = (source: ChartSource | null): ChartSource | null =>
    source
      ? { ...source, raw: indices.map((index) => source.raw[index] ?? NaN) }
      : null;
  return {
    ...config,
    sources: config.sources.map(
      (source) => filter(source) as ChartSource,
    ),
    xAxisSource: filter(config.xAxisSource),
    factorSource: filter(config.factorSource),
  };
}

function factorSeriesContexts(
  context: BuildContext,
): Array<{ context: BuildContext; series?: SeriesOption[] }> {
  if (
    context.config.type === 'heatmap' ||
    ['boxplot', 'violin', 'errorBar'].includes(context.config.type)
  ) {
    return [{ context }];
  }
  const groups = factorGroups(context.config);
  if (groups.length <= 1) return [{ context }];
  return groups.map((group, index) => {
    const config = filteredFactorConfig(context.config, group.indices);
    const base = buildBaseSeries({ ...context, config });
    const color = lineColor(index);
    const symbol = FACTOR_SYMBOLS[index % FACTOR_SYMBOLS.length];
    const styled = base.map((entry) => {
      const originalName = (entry as { name?: unknown }).name;
      const name =
        typeof originalName === 'string'
          ? `${originalName} · ${group.label}`
          : group.label;
      const withStyle = {
        ...entry,
        name,
      } as SeriesOption & Record<string, unknown>;
      if (context.config.factorMapping.color) {
        withStyle.lineStyle = {
          ...((entry as { lineStyle?: object }).lineStyle ?? {}),
          color,
        };
        withStyle.itemStyle = {
          ...((entry as { itemStyle?: object }).itemStyle ?? {}),
          color,
        };
      }
      if (
        context.config.factorMapping.shape &&
        (entry.type === 'line' || entry.type === 'scatter') &&
        !name.includes('fit y=')
      ) {
        withStyle.symbol = symbol;
        withStyle.showSymbol = true;
      }
      return withStyle as SeriesOption;
    });
    return {
      context: { ...context, config },
      series: styled,
    };
  });
}

function factorExpandedContext(context: BuildContext): BuildContext {
  const groups = factorGroups(context.config);
  if (groups.length === 0) return context;
  const sources = groups.flatMap((group) =>
    context.config.sources.map((source) => ({
      ...source,
      label: `${source.label} · ${group.label}`,
      raw: group.indices.map((index) => source.raw[index] ?? NaN),
    })),
  );
  return { ...context, config: { ...context.config, sources } };
}

function factorFacetContext(context: BuildContext): BuildContext {
  const { config } = context;
  if (!config.factorMapping.facet || !config.factorSource) return context;
  const groups = factorGroups(config);
  if (groups.length <= 1) return context;
  return {
    ...context,
    config: {
      ...config,
      composition: {
        columns: 2,
        shareXTicks: true,
        shareXRange: true,
        panels: groups.map((group) => ({
          id: `factor-${group.code}`,
          label: group.label,
          type: config.type,
          sources: config.sources.map((source) => ({
            matrixId: source.matrixId,
            columnIndex: source.columnIndex,
          })),
          factorCode: group.code,
        })),
      },
    },
  };
}

function factorAnnotationSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  if (
    !config.factorMapping.heatmapStrip ||
    config.type !== 'heatmap' ||
    !config.factorSource
  ) {
    return [];
  }
  const field = config.heatmapMode === 'field';
  const bounds = computeBounds(context);
  const xSource = field ? config.sources[0] : null;
  const factor = config.factorSource;
  const count = field ? Math.min(xSource?.raw.length ?? 0, factor.raw.length) : config.sources.length;
  const data: Array<[number, number, number]> = [];
  for (let index = 0; index < count; ++index) {
    const code = factor.raw[index];
    if (!Number.isFinite(code)) continue;
    const x = field ? Number(xSource?.raw[index]) : index;
    const y = field ? (bounds.yMax ?? 0) : -0.45;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    data.push([x, y, code]);
  }
  if (data.length === 0) return [];

  const xStep = field ? fieldAxisStep(data, 0) : 1;
  return [
    {
      name: 'factor strip',
      type: 'custom',
      data,
      clip: false,
      z: 20,
      animation: false,
      renderItem: (
        _params: CustomSeriesRenderItemParams,
        api: CustomSeriesRenderItemAPI,
      ) => {
        const x = Number(api.value(0));
        const y = Number(api.value(1));
        const code = Number(api.value(2));
        const left = api.coord([x - xStep / 2, y])[0];
        const right = api.coord([x + xStep / 2, y])[0];
        const cy = api.coord([x, y])[1];
        return {
          type: 'rect',
          shape: {
            x: Math.min(left, right),
            y: cy - 5,
            width: Math.max(1, Math.abs(right - left)),
            height: 5,
          },
          style: {
            fill: lineColor(Math.max(0, Math.floor(code))),
            opacity: 0.88,
          },
        } as unknown as RenderItemResult;
      },
    } as CustomSeriesOption,
  ];
}

// ── line / bar ─────────────────────────────────────────────────────────────

function yAxisIndexFor(config: ChartConfig, index: number): number {
  return config.secondAxis && index % 2 === 1 ? 1 : 0;
}

function lineSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const filtered = config.displayFilter ? context.displayFilter : undefined;
  const xData = filtered?.x ?? config.xAxisSource?.raw;
  return config.sources.map((source, index) => {
    const values =
      index === 0 && filtered
        ? filtered.filtered
        : smoothed(source, smoothing);
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

function rawCurveOverlay(context: BuildContext): SeriesOption[] {
  const { config, displayFilter } = context;
  if (
    config.type !== 'line' ||
    !config.displayFilter?.overlayRaw ||
    !displayFilter
  ) {
    return [];
  }
  return [
    {
      name: 'Raw',
      type: 'line',
      data: displayFilter.x.map(
        (x, index) => [x, displayFilter.raw[index]] as [number, number],
      ),
      showSymbol: false,
      lineStyle: {
        width: 1,
        color: '#777777',
        type: 'dashed',
        opacity: 0.62,
      },
      itemStyle: { color: '#777777' },
      silent: true,
      z: 1,
      animation: false,
    },
  ];
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
    if (config.showFitLine && !config.analysis) {
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
    if (!config.analysis) {
      const fit = fitOverlay(entry.points, entry.label, index, config);
      if (fit) out.push(fit);
    }
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

function analysisOverlaySeries(context: BuildContext): SeriesOption[] {
  const { analysis, config } = context;
  if (!analysis || !config.analysis) return [];
  const fit: SeriesOption = {
    name: 'backend fit',
    type: 'line',
    data: analysis.x.map((x, index) => [x, analysis.fitted[index]] as [number, number]),
    showSymbol: false,
    silent: false,
    lineStyle: { width: 2.2, color: lineColor(1) },
    z: 10,
    animation: false,
  };
  const series: SeriesOption[] = [fit];
  const addBand = (
    name: string,
    lower: number[],
    upper: number[],
    color: string,
  ) => {
    const quads: Array<number[]> = [];
    for (let index = 0; index + 1 < analysis.x.length; ++index) {
      quads.push([
        analysis.x[index],
        lower[index],
        upper[index],
        analysis.x[index + 1],
        lower[index + 1],
        upper[index + 1],
      ]);
    }
    if (quads.length === 0) return;
    series.push({
      name,
      type: 'custom',
      data: quads,
      coordinateSystem: 'cartesian2d',
      animation: false,
      silent: true,
      z: 2,
      renderItem: (
        _params: CustomSeriesRenderItemParams,
        api: CustomSeriesRenderItemAPI,
      ) => {
        const p0 = api.coord([api.value(0), api.value(1)]);
        const p1 = api.coord([api.value(0), api.value(2)]);
        const p2 = api.coord([api.value(3), api.value(5)]);
        const p3 = api.coord([api.value(3), api.value(4)]);
        return {
          type: 'polygon',
          shape: { points: [p0, p1, p2, p3] },
          style: { fill: color, stroke: 'none' },
        } as unknown as RenderItemResult;
      },
    } as CustomSeriesOption);
  };
  if (config.analysis.bands === 'confidence' || config.analysis.bands === 'both') {
    addBand(
      'mean confidence band',
      analysis.confidenceLower,
      analysis.confidenceUpper,
      'rgba(44, 123, 182, 0.16)',
    );
  }
  if (config.analysis.bands === 'prediction' || config.analysis.bands === 'both') {
    addBand(
      'individual prediction band',
      analysis.predictionLower,
      analysis.predictionUpper,
      'rgba(230, 159, 0, 0.13)',
    );
  }
  return series;
}

// ── histogram ──────────────────────────────────────────────────────────────

function histogramSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const source = config.sources[0];
  if (!source) return [];

  const values = source.raw;
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
  const { config, strings } = context;

  const summaries = config.sources.map((source) => fiveNumberSummary(source.raw));
  const factorColors = config.factorSource && config.factorMapping.color;
  const boxData = summaries.map((summary, index) => {
    const values = [
      summary.min,
      summary.q1,
      summary.median,
      summary.q3,
      summary.max,
    ];
    return factorColors
      ? {
          value: values,
          itemStyle: {
            color: withAlpha(lineColor(index), 0.18),
            borderColor: lineColor(index),
          },
        }
      : values;
  });

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
    for (const value of outliers(source.raw)) {
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

function fieldAxisStep(
  data: ReadonlyArray<[number, number, number]>,
  dimension: 0 | 1,
): number {
  const values = [...new Set(data.map((point) => point[dimension]))].sort((a, b) => a - b);
  if (values.length < 2) return Math.max(1, Math.abs(values[0] ?? 1));
  let step = Infinity;
  for (let index = 1; index < values.length; ++index) {
    step = Math.min(step, values[index] - values[index - 1]);
  }
  return Number.isFinite(step) && step > 0 ? step : 1;
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
  const { config, strings } = context;

  // Pre-compute every curve: `renderItem` is called per item on each render, so it must
  // stay cheap and must not recompute the KDE.
  const shapes: ViolinShape[] = config.sources.map((source) => {
    const values = finite(source.raw);
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
  const { config, strings } = context;

  const stats: ErrorStat[] = config.sources.map((source) => {
    const values = finite(source.raw);
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
  if (context.config.heatmapMode === 'field') return fieldHeatmapSeries(context);
  const { config, strings } = context;
  const series = config.sources.map((source) => source.raw);
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

function fieldHeatmapSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const [xSource, ySource, zSource] = config.sources;
  if (!xSource || !ySource || !zSource) return [];
  const length = Math.min(xSource.raw.length, ySource.raw.length, zSource.raw.length);
  const data: Array<[number, number, number]> = [];
  for (let index = 0; index < length; ++index) {
    const x = xSource.raw[index];
    const y = ySource.raw[index];
    const z = zSource.raw[index];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      data.push([x, y, z]);
    }
  }

  const xStep = fieldAxisStep(data, 0);
  const yStep = fieldAxisStep(data, 1);
  const series: SeriesOption[] = [
    {
      name: zSource.label,
      type: 'custom',
      data,
      encode: { x: 0, y: 1 },
      clip: true,
      z: 2,
      animation: false,
      renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
        const x = Number(api.value(0));
        const y = Number(api.value(1));
        const left = api.coord([x - xStep / 2, y])[0];
        const right = api.coord([x + xStep / 2, y])[0];
        const top = api.coord([x, y + yStep / 2])[1];
        const bottom = api.coord([x, y - yStep / 2])[1];
        return {
          type: 'rect',
          shape: {
            x: Math.min(left, right),
            y: Math.min(top, bottom),
            width: Math.max(1, Math.abs(right - left)),
            height: Math.max(1, Math.abs(bottom - top)),
          },
          style: {
            fill: api.visual('color'),
            stroke: 'rgba(255,255,255,0.35)',
            lineWidth: 0.4,
          },
        } as unknown as RenderItemResult;
      },
    } as CustomSeriesOption,
  ];
  if (config.showFieldContours) {
    const contours = contourSegments(data, fieldColorBounds(config, data));
    if (contours.length > 0) {
      series.push({
        name: 'contours',
        type: 'lines',
        coordinateSystem: 'cartesian2d',
        polyline: false,
        data: contours.map((coords) => ({ coords })),
        lineStyle: { width: 1.1, color: 'rgba(32,32,32,0.72)', opacity: 0.8 },
        silent: true,
        animation: false,
        z: 8,
      } as SeriesOption);
    }
  }
  return series;
}

function fieldColorBounds(
  config: ChartConfig,
  data: ReadonlyArray<[number, number, number]>,
): [number, number] {
  if (
    config.fieldColorRange &&
    Number.isFinite(config.fieldColorRange.min) &&
    Number.isFinite(config.fieldColorRange.max) &&
    config.fieldColorRange.min < config.fieldColorRange.max
  ) {
    return [config.fieldColorRange.min, config.fieldColorRange.max];
  }
  let min = Infinity;
  let max = -Infinity;
  for (const point of data) {
    if (point[2] < min) min = point[2];
    if (point[2] > max) max = point[2];
  }
  return Number.isFinite(min) && Number.isFinite(max) && min < max
    ? [min, max]
    : [0, 1];
}

type ContourPoint = [number, number];

function contourSegments(
  data: ReadonlyArray<[number, number, number]>,
  range: [number, number],
): Array<[ContourPoint, ContourPoint]> {
  const xs = [...new Set(data.map((point) => point[0]))].sort((a, b) => a - b);
  const ys = [...new Set(data.map((point) => point[1]))].sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2 || data.length !== xs.length * ys.length) return [];

  const values = new Map<string, number>();
  for (const [x, y, z] of data) values.set(`${x}\u0000${y}`, z);
  if (xs.some((x) => ys.some((y) => !values.has(`${x}\u0000${y}`)))) return [];

  const segments: Array<[ContourPoint, ContourPoint]> = [];
  const levels = 6;
  for (let levelIndex = 1; levelIndex < levels; ++levelIndex) {
    const level = range[0] + ((range[1] - range[0]) * levelIndex) / levels;
    for (let yi = 0; yi < ys.length - 1; ++yi) {
      for (let xi = 0; xi < xs.length - 1; ++xi) {
        const x0 = xs[xi];
        const x1 = xs[xi + 1];
        const y0 = ys[yi];
        const y1 = ys[yi + 1];
        const corners: Array<{ point: ContourPoint; value: number }> = [
          { point: [x0, y0], value: values.get(`${x0}\u0000${y0}`)! },
          { point: [x1, y0], value: values.get(`${x1}\u0000${y0}`)! },
          { point: [x1, y1], value: values.get(`${x1}\u0000${y1}`)! },
          { point: [x0, y1], value: values.get(`${x0}\u0000${y1}`)! },
        ];
        const hits: ContourPoint[] = [];
        for (let edge = 0; edge < 4; ++edge) {
          const from = corners[edge];
          const to = corners[(edge + 1) % 4];
          const crosses =
            (from.value < level && to.value >= level) ||
            (from.value >= level && to.value < level);
          if (!crosses) continue;
          const ratio = (level - from.value) / (to.value - from.value);
          hits.push([
            from.point[0] + (to.point[0] - from.point[0]) * ratio,
            from.point[1] + (to.point[1] - from.point[1]) * ratio,
          ]);
        }
        if (hits.length === 2) segments.push([hits[0], hits[1]]);
        else if (hits.length === 4) {
          const centre = (corners[0].value + corners[1].value +
            corners[2].value + corners[3].value) / 4;
          if (centre >= level) {
            segments.push([hits[0], hits[3]], [hits[1], hits[2]]);
          } else {
            segments.push([hits[0], hits[1]], [hits[2], hits[3]]);
          }
        }
      }
    }
  }
  return segments;
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
  const { config } = context;

  if (config.type === 'heatmap' && config.heatmapMode === 'field') {
    const [xSource, ySource, zSource] = config.sources;
    if (!xSource || !ySource || !zSource) return {};
    const length = Math.min(xSource.raw.length, ySource.raw.length, zSource.raw.length);
    const points: Array<[number, number, number]> = [];
    for (let index = 0; index < length; ++index) {
      const point: [number, number, number] = [
        xSource.raw[index],
        ySource.raw[index],
        zSource.raw[index],
      ];
      if (point.every(Number.isFinite)) points.push(point);
    }
    if (points.length === 0) return {};
    const xStep = fieldAxisStep(points, 0);
    const yStep = fieldAxisStep(points, 1);
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const [x, y] of points) {
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
    return {
      xMin: xMin - xStep / 2,
      xMax: xMax + xStep / 2,
      yMin: yMin - yStep / 2,
      yMax: yMax + yStep / 2,
    };
  }

  // Violin: the outline is drawn along the *value* axis (the KDE curve spans the sample
  // range, and the ribbon width encodes density — normalised to the peak in renderItem).
  // So the range is the data extent, exactly like a box plot, plus room for the
  // mirrored edge padding of the density estimate.
  if (config.type === 'violin') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(source.raw);
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
      const values = finite(source.raw);
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
      const values = finite(source.raw);
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
  if (context.config.showAnalysisDiagnostics && context.analysis) {
    return buildAnalysisDiagnosticOption(context);
  }
  const effectiveContext = factorFacetContext(context);
  const composition = effectiveContext.config.composition;
  if (composition && composition.panels.length > 1) {
    return buildComposedOption(effectiveContext);
  }

  function buildAnalysisDiagnosticOption(context: BuildContext): EChartsOption {
    const analysis = context.analysis!;
    const sigma = analysis.summary.residualStandardError;
    const main = buildSingleOption({
      ...context,
      config: { ...context.config, showAnalysisDiagnostics: false },
    });
    const grid = [
      { left: '10%', top: '10%', width: '38%', height: '35%', containLabel: false },
      { left: '56%', top: '10%', width: '38%', height: '35%', containLabel: false },
      { left: '10%', top: '58%', width: '38%', height: '32%', containLabel: false },
      { left: '56%', top: '58%', width: '38%', height: '32%', containLabel: false },
    ];
    const mainX = Array.isArray(main.xAxis) ? main.xAxis[0] : main.xAxis;
    const mainY = Array.isArray(main.yAxis) ? main.yAxis[0] : main.yAxis;
    const mainSeries = Array.isArray(main.series) ? main.series : [];
    const series: SeriesOption[] = mainSeries.map((entry) => ({
      ...entry,
      xAxisIndex: 0,
      yAxisIndex: 0,
    }));
    series.push(
      {
        name: 'Residual vs fitted',
        type: 'scatter',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: analysis.fitted.map(
          (value, index) => [value, analysis.residual[index]] as [number, number],
        ),
        symbolSize: 5,
        itemStyle: { color: lineColor(2) },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            { yAxis: 0 },
            { yAxis: 2 * sigma, name: '+2σ' },
            { yAxis: -2 * sigma, name: '−2σ' },
          ],
          lineStyle: { type: 'dashed', color: '#8b3a3a' },
          label: { show: true, formatter: (params: { name?: string }) => params.name ?? '0' },
        },
        animation: false,
      } as SeriesOption,
      {
        name: 'Residual order',
        type: 'scatter',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: analysis.residual.map(
          (value, index) => [index + 1, value] as [number, number],
        ),
        symbolSize: 5,
        itemStyle: { color: lineColor(3) },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: 0 }, { yAxis: 2 * sigma }, { yAxis: -2 * sigma }],
          lineStyle: { type: 'dashed', color: '#8b3a3a' },
        },
        animation: false,
      } as SeriesOption,
      {
        name: 'QQ',
        type: 'scatter',
        xAxisIndex: 3,
        yAxisIndex: 3,
        data: analysis.qqTheoretical.map(
          (value, index) => [value, analysis.qqResidual[index]] as [number, number],
        ),
        symbolSize: 5,
        itemStyle: { color: lineColor(4) },
        animation: false,
      },
    );
    const axes = [
      { ...(mainX as object), gridIndex: 0 },
      { type: 'value', gridIndex: 1, scale: true, name: 'Fitted' },
      { type: 'value', gridIndex: 2, min: 1, name: 'Observation' },
      { type: 'value', gridIndex: 3, scale: true, name: 'Theoretical normal' },
    ];
    const yAxes = [
      { ...(mainY as object), gridIndex: 0 },
      { type: 'value', gridIndex: 1, scale: true, name: 'Residual' },
      { type: 'value', gridIndex: 2, scale: true, name: 'Residual' },
      { type: 'value', gridIndex: 3, scale: true, name: 'Observed residual' },
    ];
    return {
      animation: false,
      grid,
      xAxis: axes as EChartsOption['xAxis'],
      yAxis: yAxes as EChartsOption['yAxis'],
      series: series as EChartsOption['series'],
      title: [
        { text: 'A · Fit', left: '10%', top: '2%', textStyle: { fontSize: 11 } },
        { text: 'B · Residual vs fitted', left: '56%', top: '2%', textStyle: { fontSize: 11 } },
        { text: 'C · Residual order', left: '10%', top: '50%', textStyle: { fontSize: 11 } },
        { text: 'D · QQ', left: '56%', top: '50%', textStyle: { fontSize: 11 } },
      ],
      legend: { show: false },
      tooltip: { trigger: 'axis', confine: true },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, yAxisIndex: 0, filterMode: 'none' },
        { type: 'inside', xAxisIndex: 1, yAxisIndex: 1, filterMode: 'none' },
        { type: 'inside', xAxisIndex: 2, yAxisIndex: 2, filterMode: 'none' },
        { type: 'inside', xAxisIndex: 3, yAxisIndex: 3, filterMode: 'none' },
      ],
    };
  }
  return buildSingleOption(effectiveContext);
}

function buildSingleOption(context: BuildContext): EChartsOption {
  const { config, strings } = context;
  const series = buildSeries(context);
  const categoryConfig =
    config.factorSource &&
    (config.factorMapping.color || config.factorMapping.shape) &&
    ['boxplot', 'violin', 'errorBar'].includes(config.type)
      ? factorExpandedContext(context).config
      : config;
  const categories = categoryConfig.sources.map((source) => source.label);
  const isHeatmap = config.type === 'heatmap';
  const isCorrelationHeatmap = isHeatmap && config.heatmapMode === 'correlation';
  const isFieldHeatmap = isHeatmap && config.heatmapMode === 'field';
  const bounds = computeBounds(context);
  // When an explicit X-axis source is set, the X axis is always a value axis regardless
  // of chart type — this enables time-series and arbitrary X plots.
  const hasExplicitX = config.xAxisSource !== null;
  const kind: AxisKind = isCorrelationHeatmap
    ? 'category'
    : hasExplicitX || isFieldHeatmap
      ? 'value'
      : xAxisKind(config);

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
              : isFieldHeatmap
                ? config.sources[0]?.label
                : config.type === 'scatter' || config.type === 'regression'
                ? config.sources[0]?.label
                : strings.rowIndex,
          min: bounds.xMin,
          max: bounds.xMax,
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
        ? isFieldHeatmap
          ? config.sources[1]?.label ?? ''
          : ''
        : yAxisUnit
          ? `${strings.value} (${yAxisUnit})`
          : strings.value;

  // Explicit bounds where the plotted quantity differs from the column values.
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
    dataZoom: isCorrelationHeatmap
      ? []
      : [
          // Both axes are zoomable by wheel/drag. `filterMode: 'none'` keeps the data
          // extent intact so a zoom is purely a view change and is fully reversible —
          // see the "reset zoom" control in the axes panel.
          { id: 'zoom-x', type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { id: 'zoom-y', type: 'inside', yAxisIndex: 0, filterMode: 'none' },
        ],
    xAxis,
    yAxis: isCorrelationHeatmap ? heatmapYAxis : primaryYAxis,
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
    if (isFieldHeatmap) {
      const field = series[0] as {
        data?: Array<[number, number, number]>;
      };
      const [min, max] = fieldColorBounds(config, field?.data ?? []);
      option.visualMap = [
        {
          min,
          max,
          calculable: !config.fieldColorRange,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          itemWidth: 14,
          itemHeight: 200,
          precision: 3,
          text: context.colorAxisUnit ? [context.colorAxisUnit, ''] : undefined,
          textStyle: { fontSize: 10 },
          seriesIndex: 0,
          dimension: 2,
          inRange: { color: ['#253494', '#2c7fb8', '#41b6c4', '#f7fcb9', '#f03b20'] },
        },
      ];
      return option;
    }
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
