/**
 * Chart configuration model.
 *
 * A chart card is configured by:
 *   - a **type** (line / boxplot / violin / heatmap / …),
 *   - a list of **sources** (which matrix column feeds which slot),
 *   - presentation options (log axis, dual axis, regression line, normalisation).
 *
 * Everything is plain serialisable data so a workspace snapshot can round-trip it.
 */
import type { ChartTypeId } from './chartTypes.ts';
import { chartTypeDef } from './chartTypes.ts';

/** One column attached to a chart. */
export interface ChartSource {
  /** Identifies which matrix the column came from (for dependency tracking). */
  matrixId: number;
  columnIndex: number;
  /** Display label; `Pos.N` plus the file annotation when present. */
  label: string;
  /** Full-resolution values, smoothing applied on top by the renderer. */
  raw: number[];
}

export type ChartAnnotationAxis = 'x' | 'y';

export interface ChartReferenceLine {
  id: string;
  axis: ChartAnnotationAxis;
  value: number;
  label: string;
}

export interface ChartAcceptedRange {
  id: string;
  axis: ChartAnnotationAxis;
  lower: number;
  upper: number;
  label: string;
}

export interface ChartLimitRange {
  axis: ChartAnnotationAxis | 'value';
  lower: number | null;
  upper: number | null;
}

export interface ChartPanel {
  id: string;
  label: string;
  type: ChartTypeId;
  sources: Array<Pick<ChartSource, 'matrixId' | 'columnIndex'>>;
}

export interface ChartComposition {
  columns: 1 | 2;
  shareXTicks: boolean;
  shareXRange: boolean;
  panels: ChartPanel[];
}

export interface ChartConfig {
  type: ChartTypeId;
  sources: ChartSource[];
  /**
   * Optional X-axis source. When set, the chart uses this column's values as X instead
   * of the row index (`No.N`). Enables time-series and arbitrary X-axis plots.
   * `null` means "use row index" (the default for line/bar/histogram/boxplot/violin/errorBar).
   */
  xAxisSource: ChartSource | null;
  /** Render the X values on a logarithmic value axis. */
  xLogScale: boolean;
  /** Render series on a logarithmic Y value axis. */
  logScale: boolean;
  /** Put every second series on a right-hand axis. */
  secondAxis: boolean;
  /** Overlay an OLS fit (scatter / regression types). */
  showFitLine: boolean;
  /** User-defined horizontal/vertical reference lines. */
  referenceLines: ChartReferenceLine[];
  /** User-defined accepted intervals drawn as translucent bands. */
  acceptedRanges: ChartAcceptedRange[];
  /** Values outside this range are overlaid in red. `null` disables a bound. */
  limitRange: ChartLimitRange | null;
  /** Optional label on plotted points. */
  pointLabels: 'none' | 'value' | 'name';
  /** Optional single-card multi-panel composition. */
  composition: ChartComposition | null;
  /** Bin count for the histogram; `0` means "choose automatically". */
  binCount: number;
  /** Which spread the error bars show. */
  errorKind: 'sd' | 'se' | 'ci95';
  /** Bar/box/violin layout. */
  layout: 'grouped' | 'stacked';
  /** Error-bar cap width in x units. */
  capWidth: number;
}

export function defaultChartConfig(type: ChartTypeId, sources: ChartSource[]): ChartConfig {
  return {
    type,
    sources,
    xAxisSource: null,
    xLogScale: false,
    logScale: false,
    secondAxis: false,
    showFitLine: true,
    referenceLines: [],
    acceptedRanges: [],
    limitRange: null,
    pointLabels: 'none',
    composition: null,
    binCount: 0,
    errorKind: 'sd',
    layout: 'grouped',
    capWidth: 0.35,
  };
}

/** Value combining one source with the row index, ready for charting. */
export interface XYPoint {
  x: number;
  y: number;
}

/**
 * Pair a source's values with the row index (`No.N`, 1-based) — the default x axis for
 * line/bar/boxplot/violin/error-bar charts, matching the original Qt behaviour.
 * When `xSource` is provided, its values are used as X instead of the row index.
 */
export function withRowIndex(source: ChartSource, xSource?: ChartSource | null): XYPoint[] {
  const points: XYPoint[] = [];
  const len = Math.min(source.raw.length, xSource?.raw.length ?? source.raw.length);
  for (let i = 0; i < len; ++i) {
    const x = xSource ? xSource.raw[i] : i + 1;
    points.push({ x, y: source.raw[i] });
  }
  return points;
}

/** Pair two sources as (x, y), truncating to the shorter one. */
export function pair(xSource: ChartSource, ySource: ChartSource): XYPoint[] {
  const length = Math.min(xSource.raw.length, ySource.raw.length);
  const points: XYPoint[] = [];
  for (let i = 0; i < length; ++i) {
    points.push({ x: xSource.raw[i], y: ySource.raw[i] });
  }
  return points;
}

/**
 * Interpret the attached sources for a type, resolving the ambiguous cases:
 * for `pairs` the sources are consecutive (x, y) tuples; for `single` only the first is
 * used; for `matrix` every source participates.
 */
export function resolveSeries(config: ChartConfig): Array<{ label: string; points: XYPoint[] }> {
  const { sources, xAxisSource } = config;
  const def = chartTypeDef(config.type);

  switch (def.columnArity) {
    case 'single':
      return sources.slice(0, 1).map((source) => ({
        label: source.label,
        points: withRowIndex(source, xAxisSource),
      }));

    case 'pairs': {
      const out: Array<{ label: string; points: XYPoint[] }> = [];
      for (let i = 0; i + 1 < sources.length; i += 2) {
        out.push({
          label: `${sources[i].label} → ${sources[i + 1].label}`,
          points: pair(sources[i], sources[i + 1]),
        });
      }
      // An odd trailing column cannot form a pair; still show it as y against the row
      // index so the user sees the data rather than an empty chart.
      if (sources.length % 2 === 1 && sources.length > 1) {
        const last = sources[sources.length - 1];
        out.push({ label: `${last.label} (no x)`, points: withRowIndex(last, xAxisSource) });
      }
      return out;
    }

    case 'matrix':
    case 'onePerSeries':
    default:
      return sources.map((source) => ({
        label: source.label,
        points: withRowIndex(source, xAxisSource),
      }));
  }
}

/** Counts of finite samples outside the domain of each enabled logarithmic axis. */
export function nonPositiveAxisCounts(config: ChartConfig): { x: number; y: number } {
  const counts = { x: 0, y: 0 };
  if (!config.xLogScale && !config.logScale) return counts;

  for (const entry of resolveSeries(config)) {
    for (const point of entry.points) {
      if (config.xLogScale && Number.isFinite(point.x) && point.x <= 0) counts.x += 1;
      if (config.logScale && Number.isFinite(point.y) && point.y <= 0) counts.y += 1;
    }
  }
  return counts;
}

/** Resolve one panel back onto the chart's authoritative source list. */
export function chartConfigForPanel(config: ChartConfig, panel: ChartPanel): ChartConfig {
  const selected = panel.sources.flatMap((ref) => {
    const source = config.sources.find(
      (candidate) =>
        candidate.matrixId === ref.matrixId && candidate.columnIndex === ref.columnIndex,
    );
    return source ? [source] : [];
  });
  return {
    ...config,
    type: panel.type,
    sources: selected,
    composition: null,
  };
}

/** True when the configuration has enough sources to draw the selected type. */
export function isDrawable(config: ChartConfig): boolean {
  if (config.composition) {
    return config.composition.panels.some((panel) => {
      const resolved = chartConfigForPanel(config, panel);
      const needed = chartTypeDef(panel.type).columnArity;
      return needed === 'pairs' || needed === 'matrix'
        ? resolved.sources.length >= 2
        : resolved.sources.length >= 1;
    });
  }
  const def = chartTypeDef(config.type);
  if (config.sources.length === 0) return false;
  switch (def.columnArity) {
    case 'pairs':
      return config.sources.length >= 2;
    case 'matrix':
      return config.sources.length >= 2;
    default:
      return true;
  }
}
