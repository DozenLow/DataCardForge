/**
 * Chart card — multi-type scientific plotting on ECharts (SVG renderer).
 *
 * History: the Qt version was a single-type line chart (QCustomPlot). The card now owns
 * a `ChartConfig` (type + attached columns + presentation options) and rebuilds the
 * ECharts option whenever that config, the data, or the smoothing changes.
 *
 * Vector export is the reason this project chose the web stack, so exporting is a
 * first-class control rather than a hidden toolbox item:
 *   - **SVG** — the live chart is already a real `<svg>`; the file is that DOM tree,
 *     serialised with computed styles folded in. Fully vector.
 *   - **PNG** — rasterised at 2×/4× for slides or print.
 *   - **PDF** — one page wrapping a high-resolution raster (see `charts/pdf.ts`). The UI
 *     marks it as non-vector so nobody submits it as a vector figure by mistake.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Type-only import: ECharts is ~1 MB, so it is loaded lazily and must not be pulled into
// the initial bundle just for its types.
import type * as echartsNamespace from 'echarts';

import { applySmoothing, MAX_SG_DEGREE, type SmoothingMode } from '../../core/Smoothing.ts';
import { columnUnitResolutions } from '../../core/units.ts';
import { invalidateLayout } from '../cardMetrics.ts';
import { formatBytes } from '../i18n.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { useGlobalSettings } from '../useGlobalSettings.ts';
import { isChartCard, isMatrixCard, type ChartCardModel } from '../types.ts';
import {
  CHART_TYPE_ORDER,
  EXPORT_FORMATS,
  chartTypeDef,
} from '../../charts/chartTypes.ts';
import { buildOption, ZOOM_COMPONENT_IDS, type BuildContext } from '../../charts/chartOptions.ts';
import {
  isDrawable,
  minimumColumnsForConfig,
  nonPositiveAxisCounts,
  type ChartAnnotationAxis,
  type ChartAnalysisOptions,
  type ChartLimitRange,
  type ChartPanel,
  type ChartSource,
} from '../../charts/chartModel.ts';
import { exportChart, type ExportType } from '../../charts/export.ts';
import { CardShell } from './CardShell.tsx';
import { ColumnDock } from './ColumnDock.tsx';
import { Popup } from './Popup.tsx';

interface ChartCardProps {
  card: ChartCardModel;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onActivate: () => void;
}

const SMOOTHING_MODES: SmoothingMode[] = [
  'none',
  'movingAverage',
  'exponential',
  'median',
  'savitzkyGolay',
];

let annotationSequence = 0;

function annotationId(prefix: string): string {
  annotationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${annotationSequence.toString(36)}`;
}

type PanelKind = 'type' | 'options' | 'annotations' | 'panels' | 'factors' | 'export';

/** An open toolbar dropdown, pinned to the button that opened it in viewport coordinates. */
interface OpenPanel {
  kind: PanelKind;
  x: number;
  y: number;
}

export function ChartCard({
  card,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onActivate,
}: ChartCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setSmoothing = useWorkspace((s) => s.setSmoothing);
  const setChartType = useWorkspace((s) => s.setChartType);
  const setChartConfig = useWorkspace((s) => s.setChartConfig);
  const setChartColumnPanel = useWorkspace((s) => s.setChartColumnPanel);
  const runChartAnalysis = useWorkspace((s) => s.runChartAnalysis);
  const analysisRun = useWorkspace((s) => s.chartAnalyses[card.id]);
  const matrices = useWorkspace((s) => s.matrices);
  const cards = useWorkspace((s) => s.cards);
  const showToast = useWorkspace((s) => s.showToast);
  const unitConfirmations = useWorkspace((s) => s.unitConfirmations);
  /** The workspace + global half of the units resolution chain (units L1b §B2). */
  const unitConstants = useWorkspace((s) => s.unitConstants);
  const globalUnitPreconfirm = useGlobalSettings().unitPreconfirm;
  /** Units a formula output inherits from a unit-preserving expression (units L2a). */
  const inheritedUnits = useWorkspace((s) => s.inheritedUnits);
  const typeDef = useMemo(() => chartTypeDef(card.config.type), [card.config.type]);
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chart, setChart] = useState<echartsNamespace.ECharts | null>(null);
  const [echarts, setEcharts] = useState<typeof echartsNamespace | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [pixelRatio, setPixelRatio] = useState(2);
  const [referenceAxis, setReferenceAxis] = useState<ChartAnnotationAxis>('y');
  const [referenceValue, setReferenceValue] = useState('');
  const [referenceLabel, setReferenceLabel] = useState('');
  const [acceptedAxis, setAcceptedAxis] = useState<ChartAnnotationAxis>('y');
  const [acceptedLower, setAcceptedLower] = useState('');
  const [acceptedUpper, setAcceptedUpper] = useState('');
  const [acceptedLabel, setAcceptedLabel] = useState('');
  const [fieldMin, setFieldMin] = useState(
    card.config.fieldColorRange ? String(card.config.fieldColorRange.min) : '',
  );
  const [fieldMax, setFieldMax] = useState(
    card.config.fieldColorRange ? String(card.config.fieldColorRange.max) : '',
  );
  const [analysisInitial, setAnalysisInitial] = useState(
    card.config.analysis?.initial?.join(', ') ?? '',
  );
  const [analysisLower, setAnalysisLower] = useState(
    card.config.analysis?.lower?.join(', ') ?? '',
  );
  const [analysisUpper, setAnalysisUpper] = useState(
    card.config.analysis?.upper?.join(', ') ?? '',
  );

  // A `single`-arity type plots only the first column, so counting every attached column in
  // the badge made a histogram claim "2 × 10000 points" while drawing one series.
  const drawnSources =
    typeDef.columnArity === 'single' ? card.config.sources.slice(0, 1) : card.config.sources;
  const totalPoints = drawnSources.reduce(
    (max, source) => Math.max(max, source.raw.length),
    0,
  );
  const seriesCount =
    typeDef.columnArity === 'pairs'
      ? Math.floor(card.config.sources.length / 2) + (card.config.sources.length % 2)
      : drawnSources.length;
  const needed = minimumColumnsForConfig(card.config);
  const drawable = isDrawable(card.config);

  /**
   * Data facts the axes panel has to state, because the chart cannot:
   *  - a log axis silently discards every sample <= 0;
   *  - `yAxisIndexFor` puts every odd-indexed series on the right axis, and nothing in the
   *    chart shows which ones they are.
   */
  const nonPositiveCounts = useMemo(
    () => nonPositiveAxisCounts(card.config),
    [card.config],
  );

  const secondAxisLabels = useMemo(
    () =>
      card.config.secondAxis
        ? card.config.sources
            .filter((_, index) => index % 2 === 1)
            .map((source) => source.label)
        : [],
    [card.config.secondAxis, card.config.sources],
  );

  // ── ECharts lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    void import('echarts').then((module) => {
      if (cancelled) return;
      // Exposed for the headless smoke test, which reads the plotted series back out of
      // the live instance to verify data updates rather than pixels.
      (window as unknown as { echarts?: typeof module }).echarts = module;
      setEcharts(module);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !echarts || !drawable) return;
    // The SVG renderer is what makes `chartToSvgString` produce real vector output.
    const instance = echarts.init(el, undefined, { renderer: 'svg', useDirtyRect: true });
    setChart(instance);
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      instance.dispose();
      setChart(null);
    };
  }, [echarts, drawable]);

  /** Localised strings handed to the (i18n-free) option builder. */
  const strings = useMemo<BuildContext['strings']>(
    () => ({
      rowIndex: t('chart.rowIndex'),
      value: t('chart.value'),
      count: t('chart.points', { n: '' }).trim(),
      density: t('chart.density'),
      binCentre: t('chart.binCentre'),
      correlation: t('chart.correlation'),
      quartiles: t('chart.quartiles'),
      // The legend entry states which spread measure is drawn.
      mean: `${t('chart.mean')} ± ${t(errorKey(card))}`,
      outliers: t('chart.outliers'),
      secondAxis: t('chart.secondAxis'),
      drawnOfTotal: (drawn, total) => t('chart.drawnOfTotal', { drawn, total }),
    }),
    // The legend name embeds the selected error kind, so it must rebuild with it.
    // `t` is stable per locale (see `translatorFor`), so this only rebuilds when it must.
    [t, card.config.errorKind],
  );

  /**
   * Unit for the value axis, derived at render time — a chart stores no unit (units v1).
   *
   * Only a *single shared* `recognized` unit is reported: if the plotted columns disagree,
   * or any of them is ambiguous/unknown, the axis keeps the plain "Value" title. An axis
   * title is a statement about every number on it, so a mixed set must not claim one.
   */
  const recognizedUnit = useCallback((source: ChartSource): string | undefined => {
    const matrix = matrices.get(source.matrixId);
    if (!matrix || !matrix.column(source.columnIndex)) return undefined;
    const { resolutions } = columnUnitResolutions(
      matrix.columns().map((entry) => entry.annotation),
      unitConfirmations,
      { constants: unitConstants, preconfirm: globalUnitPreconfirm, inherited: inheritedUnits },
    );
    const resolution = resolutions[source.columnIndex];
    return resolution?.state === 'recognized' ? resolution.unit : undefined;
  }, [
    matrices,
    unitConfirmations,
    unitConstants,
    globalUnitPreconfirm,
    inheritedUnits,
  ]);

  const yAxisUnit = useMemo((): string | undefined => {
    // A histogram plots counts and a heatmap plots correlation coefficients; neither y axis
    // measures the column's unit.
    if (card.config.type === 'histogram' || card.config.type === 'heatmap') return undefined;
    const sources =
      typeDef.columnArity === 'single' ? card.config.sources.slice(0, 1) : card.config.sources;
    if (sources.length === 0) return undefined;
    let shared: string | null = null;
    for (const source of sources) {
      const unit = recognizedUnit(source);
      if (!unit) return undefined;
      if (shared === null) shared = unit;
      else if (shared !== unit) return undefined;
    }
    return shared ?? undefined;
  }, [
    card.config.type,
    card.config.sources,
    typeDef.columnArity,
    recognizedUnit,
  ]);

  const colorAxisUnit = useMemo(() => {
    if (card.config.type !== 'heatmap' || card.config.heatmapMode !== 'field') return undefined;
    const source = card.config.sources[2];
    return source ? recognizedUnit(source) : undefined;
  }, [card.config.heatmapMode, card.config.sources, card.config.type, recognizedUnit]);

  const option = useMemo(
    () =>
      drawable
        ? buildOption({
            config: card.config,
            smoothing: card.smoothing,
            strings,
            yAxisUnit,
            colorAxisUnit,
            analysis: analysisRun?.output,
          })
        : null,
    [
      card.config,
      card.smoothing,
      strings,
      drawable,
      yAxisUnit,
      colorAxisUnit,
      analysisRun?.output,
    ],
  );

  useEffect(() => {
    if (!chart || !option) return;
    // `notMerge` because switching chart type changes the axis kinds entirely.
    // `chart` is in the deps on purpose: the instance is created asynchronously (after the
    // lazy ECharts import), and the option must be applied the moment it exists. A locale
    // change also lands here, because the option's labels come from `strings`.
    chart.setOption(option, { notMerge: true });
  }, [chart, option]);

  /**
   * Open/close a toolbar dropdown, pinned just below its button in **viewport**
   * coordinates. The popup is portalled to `document.body`: inside the card it would be
   * positioned against the card's `transform` (the card is a react-rnd window) and clipped
   * by `overflow: hidden`.
   */
  const togglePanel = useCallback(
    (kind: PanelKind, event: React.MouseEvent) => {
      // Read the geometry *before* scheduling the update: React nulls `currentTarget` once
      // the handler returns, and the updater below can run after that. Doing the read inside
      // the updater threw "Cannot read properties of null", which unmounted the whole app.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setPanel((current) =>
        current?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom + 4 },
      );
    },
    [],
  );

  const dismissPanel = useCallback(() => setPanel(null), []);

  const addReferenceLine = useCallback(() => {
    const value = Number(referenceValue);
    if (referenceValue.trim() === '' || !Number.isFinite(value)) return;
    setChartConfig(card.id, {
      referenceLines: [
        ...card.config.referenceLines,
        { id: annotationId('line'), axis: referenceAxis, value, label: referenceLabel },
      ],
    });
    setReferenceValue('');
    setReferenceLabel('');
  }, [
    card.id,
    card.config.referenceLines,
    referenceAxis,
    referenceLabel,
    referenceValue,
    setChartConfig,
  ]);

  const addAcceptedRange = useCallback(() => {
    const lower = Number(acceptedLower);
    const upper = Number(acceptedUpper);
    if (
      acceptedLower.trim() === '' ||
      acceptedUpper.trim() === '' ||
      !Number.isFinite(lower) ||
      !Number.isFinite(upper) ||
      lower >= upper
    ) {
      return;
    }
    setChartConfig(card.id, {
      acceptedRanges: [
        ...card.config.acceptedRanges,
        {
          id: annotationId('area'),
          axis: acceptedAxis,
          lower,
          upper,
          label: acceptedLabel,
        },
      ],
    });
    setAcceptedLower('');
    setAcceptedUpper('');
    setAcceptedLabel('');
  }, [
    acceptedAxis,
    acceptedLabel,
    acceptedLower,
    acceptedUpper,
    card.id,
    card.config.acceptedRanges,
    setChartConfig,
  ]);

  const patchLimitRange = useCallback(
    (patch: Partial<ChartLimitRange>) => {
      const current: ChartLimitRange = card.config.limitRange ?? {
        axis: 'y',
        lower: null,
        upper: null,
      };
      const next = { ...current, ...patch };
      setChartConfig(card.id, {
        limitRange: next,
      });
    },
    [card.config.limitRange, card.id, setChartConfig],
  );

  /**
   * The dock's ports scroll with its body, so the layer re-measures after a scroll.
   *
   * Same schedule the formula card measures its input rows on: one `invalidateLayout` per
   * scroll event, not a manual re-registration of every port.
   */
  const handleDockScroll = useCallback(() => invalidateLayout(), []);

  /** Return both value axes to their full data range. */
  const resetZoom = useCallback(() => {
    if (!chart) return;
    // `dataZoom` is always installed for the value-axis types, and a wheel over the plot
    // zooms instead of scrolling. Without this the user has no way back to the full range.
    const option = chart.getOption() as { dataZoom?: unknown[] };
    const zoomCount = option.dataZoom?.length ?? ZOOM_COMPONENT_IDS.length;
    for (let dataZoomIndex = 0; dataZoomIndex < zoomCount; ++dataZoomIndex) {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex, start: 0, end: 100 });
    }
  }, [chart]);

  const enablePanels = useCallback(() => {
    const refs = card.config.sources.map((source) => ({
      matrixId: source.matrixId,
      columnIndex: source.columnIndex,
    }));
    const makePanel = (label: string): ChartPanel => ({
      id: annotationId('panel'),
      label,
      type: card.config.type,
      sources: refs,
    });
    setChartConfig(card.id, {
      composition: {
        columns: 2,
        shareXTicks: true,
        shareXRange: false,
        panels: [makePanel('A'), makePanel('B')],
      },
    });
  }, [card.config.sources, card.config.type, card.id, setChartConfig]);

  const updatePanel = useCallback(
    (panelId: string, patch: Partial<ChartPanel>) => {
      const composition = card.config.composition;
      if (!composition) return;
      setChartConfig(card.id, {
        composition: {
          ...composition,
          panels: composition.panels.map((panel) =>
            panel.id === panelId ? { ...panel, ...patch } : panel,
          ),
        },
      });
    },
    [card.config.composition, card.id, setChartConfig],
  );

  const removePanel = useCallback(
    (panelId: string) => {
      const composition = card.config.composition;
      if (!composition) return;
      const panels = composition.panels.filter((panel) => panel.id !== panelId);
      setChartConfig(card.id, {
        composition:
          panels.length >= 2 ? { ...composition, panels } : null,
      });
    },
    [card.config.composition, card.id, setChartConfig],
  );

  // ── export ─────────────────────────────────────────────────────────────

  const handleExport = useCallback(
    async (type: ExportType) => {
      const container = containerRef.current;
      if (!container) return;
      setPanel(null);
      try {
        const result = await exportChart(container, type, {
          name: exportBaseName(card),
          pixelRatio,
          background: '#ffffff',
        });
        showToast(
          'info',
          t('status.exported', { name: result.fileName, size: formatBytes(result.bytes) }),
        );
        if (!result.vector && type === 'pdf') {
          // Be explicit: a raster-in-PDF is not a vector figure.
          window.setTimeout(() => {
            showToast('info', t('status.notVector', { format: type.toUpperCase() }));
          }, 100);
        }
      } catch (error) {
        showToast('error', t('status.exportFailed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [card, pixelRatio, showToast, t],
  );

  // ── source columns ─────────────────────────────────────────────────────

  /**
   * Matrices this chart is allowed to read: those owned by a matrix card that already
   * feeds it. Keeping this restriction means "chart follows its table's file switch"
   * stays true, which the dependency graph relies on.
   */
  const availableColumns = useMemo(() => {
    const ownerIds = new Set(card.config.sources.map((source) => source.matrixId));
    const options: Array<{
      matrixId: number;
      columnIndex: number;
      label: string;
      file: string;
      categories?: string[];
    }> = [];
    for (const entry of cards) {
      if (!isMatrixCard(entry)) continue;
      for (const fileSource of entry.sources) {
        if (!ownerIds.has(fileSource.matrixId)) continue;
        const matrix = matrices.get(fileSource.matrixId);
        if (!matrix) continue;
        for (let index = 0; index < matrix.columnCount(); ++index) {
          const column = matrix.column(index);
          options.push({
            matrixId: fileSource.matrixId,
            columnIndex: index,
            label: column.annotation !== '' ? column.annotation : column.posName,
            file: fileSource.name,
            categories: column.categories?.slice(),
          });
        }
      }
    }
    return options;
  }, [cards, matrices, card.config.sources]);

  const badge = `${seriesCount} × ${t('chart.points', { n: totalPoints })}`;
  const title = t('card.chart', {
    type: t(typeDef.labelKey),
    name: card.config.sources[0]?.label ?? t('card.unlabeled'),
  });

  /**
   * The X-axis dropdown's value, forced back to "row index" whenever the stored source is
   * not among the offered columns. Without this the `<select>` silently falls back to its
   * first option while the chart keeps using the stale column — the control and the drawn
   * axis would disagree.
   */
  const xAxisSelectValue = (() => {
    const source = card.config.xAxisSource;
    if (!source) return '';
    const value = `${source.matrixId}:${source.columnIndex}`;
    return availableColumns.some(
      (column) => column.matrixId === source.matrixId && column.columnIndex === source.columnIndex,
    )
      ? value
      : '';
  })();

  const factorSelectValue = (() => {
    const source = card.config.factorSource;
    if (!source) return '';
    const value = `${source.matrixId}:${source.columnIndex}`;
    return availableColumns.some(
      (column) =>
        column.matrixId === source.matrixId &&
        column.columnIndex === source.columnIndex &&
        column.categories,
    )
      ? value
      : '';
  })();

  const setAnalysisModel = useCallback(
    (model: ChartAnalysisOptions['model'] | 'none') => {
      if (model === 'none') {
        setChartConfig(card.id, {
          analysis: null,
          showAnalysisDiagnostics: false,
        });
        return;
      }
      const analysis: ChartAnalysisOptions = {
        model,
        throughOrigin: false,
        weighting: 'none',
        initial: null,
        lower: null,
        upper: null,
        confidence: 0.95,
        bands: 'both',
      };
      setAnalysisInitial('');
      setAnalysisLower('');
      setAnalysisUpper('');
      setChartConfig(card.id, { analysis });
    },
    [card.id, setChartConfig],
  );

  const patchAnalysis = useCallback(
    (patch: Partial<ChartAnalysisOptions>) => {
      if (!card.config.analysis) return;
      setChartConfig(card.id, {
        analysis: { ...card.config.analysis, ...patch },
      });
    },
    [card.config.analysis, card.id, setChartConfig],
  );

  const parseAnalysisArray = (text: string): number[] | null | undefined => {
    if (!text.trim()) return null;
    const values = text.split(',').map((token) => Number(token.trim()));
    if (values.some((value) => !Number.isFinite(value))) return undefined;
    return values;
  };
  const analysisArrayInvalid = [
    analysisInitial,
    analysisLower,
    analysisUpper,
  ].some((text) => parseAnalysisArray(text) === undefined);

  return (
    <CardShell
      card={card}
      variant="card--chart"
      title={title}
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
    >
      <div className="chart-card">
        <ColumnDock
          card={card}
          open={Boolean(card.columnPanelOpen)}
          onToggle={(open) => setChartColumnPanel(card.id, open)}
          onScroll={handleDockScroll}
        />
        <div className="chart-card__main">
        {/* Toolbar: chart type, options, export. */}
        <div className="chart-card__toolbar">
          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${panel?.kind === 'type' ? ' is-open' : ''}`}
              title={t(typeDef.hintKey)}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('type', event)}
            >
              {t(typeDef.labelKey)} ▾
            </button>
            {panel?.kind === 'type' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup"
                onDismiss={dismissPanel}
              >
                {CHART_TYPE_ORDER.map((id) => {
                  const def = chartTypeDef(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`chart-card__popup-item${
                        card.config.type === id ? ' is-active' : ''
                      }`}
                      title={t(def.hintKey)}
                      onClick={() => {
                        setChartType(card.id, id);
                        setPanel(null);
                      }}
                    >
                      {t(def.labelKey)}
                    </button>
                  );
                })}
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel?.kind === 'factors' ? ' is-open' : ''
              }`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('factors', event)}
            >
              {t('chart.factors')} ▾
            </button>
            {panel?.kind === 'factors' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--wide"
                onDismiss={dismissPanel}
              >
                <label className="chart-card__field">
                  <span>{t('chart.factorSource')}</span>
                  <select
                    className="card__control"
                    value={factorSelectValue}
                    onChange={(event) => {
                      if (!event.target.value) {
                        setChartConfig(card.id, { factorSource: null });
                        return;
                      }
                      const [matrixId, columnIndex] = event.target.value.split(':').map(Number);
                      const column = availableColumns.find(
                        (entry) =>
                          entry.matrixId === matrixId &&
                          entry.columnIndex === columnIndex &&
                          entry.categories,
                      );
                      const matrix = matrices.get(matrixId);
                      if (!column?.categories || !matrix) return;
                      const data = matrix.column(columnIndex)?.data;
                      if (!data) return;
                      setChartConfig(card.id, {
                        factorSource: {
                          matrixId,
                          columnIndex,
                          label: column.label,
                          raw: data.slice(),
                          categories: column.categories.slice(),
                        },
                        factorMapping: {
                          ...card.config.factorMapping,
                          color: true,
                        },
                      });
                    }}
                  >
                    <option value="">{t('chart.factorNone')}</option>
                    {availableColumns
                      .filter((column) => column.categories && column.categories.length > 0)
                      .map((column) => (
                        <option
                          key={`${column.matrixId}:${column.columnIndex}`}
                          value={`${column.matrixId}:${column.columnIndex}`}
                        >
                          {column.label} · {column.file}
                        </option>
                      ))}
                  </select>
                </label>
                {card.config.type !== 'heatmap' ? (
                  <>
                    <label className="chart-card__field">
                      <input
                        type="checkbox"
                        disabled={!card.config.factorSource}
                        checked={card.config.factorMapping.color}
                        onChange={(event) =>
                          setChartConfig(card.id, {
                            factorMapping: {
                              ...card.config.factorMapping,
                              color: event.target.checked,
                            },
                          })
                        }
                      />
                      <span>{t('chart.factorColor')}</span>
                    </label>
                    <label className="chart-card__field">
                      <input
                        type="checkbox"
                        disabled={!card.config.factorSource}
                        checked={card.config.factorMapping.shape}
                        onChange={(event) =>
                          setChartConfig(card.id, {
                            factorMapping: {
                              ...card.config.factorMapping,
                              shape: event.target.checked,
                            },
                          })
                        }
                      />
                      <span>{t('chart.factorShape')}</span>
                    </label>
                  </>
                ) : (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      disabled={!card.config.factorSource}
                      checked={card.config.factorMapping.heatmapStrip}
                      onChange={(event) =>
                        setChartConfig(card.id, {
                          factorMapping: {
                            ...card.config.factorMapping,
                            heatmapStrip: event.target.checked,
                          },
                        })
                      }
                    />
                    <span>{t('chart.factorHeatmapStrip')}</span>
                  </label>
                )}
                <label className="chart-card__field">
                  <input
                    type="checkbox"
                    disabled={!card.config.factorSource}
                    checked={card.config.factorMapping.facet}
                    onChange={(event) =>
                      setChartConfig(card.id, {
                        factorMapping: {
                          ...card.config.factorMapping,
                          facet: event.target.checked,
                        },
                      })
                    }
                  />
                  <span>{t('chart.factorFacet')}</span>
                </label>
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel?.kind === 'panels' ? ' is-open' : ''
              }`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('panels', event)}
            >
              {t('chart.panels')} ▾
            </button>
            {panel?.kind === 'panels' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--panels"
                onDismiss={dismissPanel}
              >
                {!card.config.composition ? (
                  <button
                    type="button"
                    className="chart-card__popup-item"
                    onClick={enablePanels}
                  >
                    {t('chart.enablePanels')}
                  </button>
                ) : (
                  <>
                    <label className="chart-card__field">
                      <span>{t('chart.panelColumns')}</span>
                      <select
                        className="card__control"
                        value={card.config.composition.columns}
                        onChange={(event) => {
                          const composition = card.config.composition!;
                          setChartConfig(card.id, {
                            composition: {
                              ...composition,
                              columns: Number(event.target.value) as 1 | 2,
                            },
                          });
                        }}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </label>
                    <label className="chart-card__field">
                      <input
                        type="checkbox"
                        checked={card.config.composition.shareXTicks}
                        onChange={(event) => {
                          const composition = card.config.composition!;
                          setChartConfig(card.id, {
                            composition: {
                              ...composition,
                              shareXTicks: event.target.checked,
                            },
                          });
                        }}
                      />
                      <span>{t('chart.shareXTicks')}</span>
                    </label>
                    <label className="chart-card__field">
                      <input
                        type="checkbox"
                        checked={card.config.composition.shareXRange}
                        onChange={(event) => {
                          const composition = card.config.composition!;
                          setChartConfig(card.id, {
                            composition: {
                              ...composition,
                              shareXRange: event.target.checked,
                            },
                          });
                        }}
                      />
                      <span>{t('chart.shareXRange')}</span>
                    </label>

                    {card.config.composition.panels.map((chartPanel) => (
                      <div className="chart-card__panel-editor" key={chartPanel.id}>
                        <div className="chart-card__panel-heading">
                          <input
                            className="card__control chart-card__panel-label"
                            value={chartPanel.label}
                            aria-label={t('chart.panelLabel')}
                            onChange={(event) =>
                              updatePanel(chartPanel.id, { label: event.target.value })
                            }
                          />
                          <select
                            className="card__control"
                            value={chartPanel.type}
                            onChange={(event) =>
                              updatePanel(chartPanel.id, {
                                type: event.target.value as ChartPanel['type'],
                              })
                            }
                          >
                            {CHART_TYPE_ORDER.map((id) => (
                              <option key={id} value={id}>
                                {t(chartTypeDef(id).labelKey)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="chart-card__annotation-remove"
                            title={t('chart.removePanel')}
                            onClick={() => removePanel(chartPanel.id)}
                          >
                            ×
                          </button>
                        </div>
                        <div className="chart-card__panel-sources">
                          {card.config.sources.map((source) => {
                            const selected = chartPanel.sources.some(
                              (ref) =>
                                ref.matrixId === source.matrixId &&
                                ref.columnIndex === source.columnIndex,
                            );
                            return (
                              <label key={`${source.matrixId}:${source.columnIndex}`}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => {
                                    const refs = selected
                                      ? chartPanel.sources.filter(
                                          (ref) =>
                                            ref.matrixId !== source.matrixId ||
                                            ref.columnIndex !== source.columnIndex,
                                        )
                                      : [
                                          ...chartPanel.sources,
                                          {
                                            matrixId: source.matrixId,
                                            columnIndex: source.columnIndex,
                                          },
                                        ];
                                    updatePanel(chartPanel.id, { sources: refs });
                                  }}
                                />
                                <span>{source.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {card.config.composition.panels.length < 4 ? (
                      <button
                        type="button"
                        className="chart-card__popup-item"
                        onClick={() => {
                          const composition = card.config.composition!;
                          const refs = card.config.sources.map((source) => ({
                            matrixId: source.matrixId,
                            columnIndex: source.columnIndex,
                          }));
                          const panels = [
                            ...composition.panels,
                            {
                              id: annotationId('panel'),
                              label: String.fromCharCode(65 + composition.panels.length),
                              type: card.config.type,
                              sources: refs,
                            },
                          ];
                          setChartConfig(card.id, {
                            composition: { ...composition, panels },
                          });
                        }}
                      >
                        {t('chart.addPanel')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="chart-card__popup-item"
                      onClick={() => setChartConfig(card.id, { composition: null })}
                    >
                      {t('chart.disablePanels')}
                    </button>
                  </>
                )}
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel?.kind === 'annotations' ? ' is-open' : ''
              }`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('annotations', event)}
            >
              {t('chart.annotations')} ▾
            </button>
            {panel?.kind === 'annotations' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--annotations"
                onDismiss={dismissPanel}
              >
                <label className="chart-card__field">
                  <span>{t('chart.pointLabels')}</span>
                  <select
                    className="card__control"
                    value={card.config.pointLabels}
                    onChange={(event) =>
                      setChartConfig(card.id, {
                        pointLabels: event.target.value as 'none' | 'value' | 'name',
                      })
                    }
                  >
                    <option value="none">{t('chart.pointLabels.none')}</option>
                    <option value="value">{t('chart.pointLabels.value')}</option>
                    <option value="name">{t('chart.pointLabels.name')}</option>
                  </select>
                </label>

                <div className="chart-card__annotation-section">
                  <strong>{t('chart.referenceLines')}</strong>
                  <div className="chart-card__annotation-form">
                    <select
                      className="card__control"
                      value={referenceAxis}
                      onChange={(event) => setReferenceAxis(event.target.value as ChartAnnotationAxis)}
                      aria-label={t('chart.annotationAxis')}
                    >
                      <option value="x">X</option>
                      <option value="y">Y</option>
                    </select>
                    <input
                      type="number"
                      className="card__control chart-card__number"
                      value={referenceValue}
                      placeholder={t('chart.annotationValue')}
                      onChange={(event) => setReferenceValue(event.target.value)}
                    />
                    <input
                      className="card__control chart-card__annotation-label"
                      value={referenceLabel}
                      placeholder={t('chart.annotationLabel')}
                      onChange={(event) => setReferenceLabel(event.target.value)}
                    />
                    <button type="button" className="card__control" onClick={addReferenceLine}>
                      {t('chart.add')}
                    </button>
                  </div>
                  {card.config.referenceLines.map((line) => (
                    <div className="chart-card__annotation-row" key={line.id}>
                      <span>
                        {line.axis.toUpperCase()} = {line.value}
                        {line.label ? ` · ${line.label}` : ''}
                      </span>
                      <button
                        type="button"
                        className="chart-card__annotation-remove"
                        title={t('chart.remove')}
                        onClick={() =>
                          setChartConfig(card.id, {
                            referenceLines: card.config.referenceLines.filter(
                              (entry) => entry.id !== line.id,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <div className="chart-card__annotation-section">
                  <strong>{t('chart.acceptedRanges')}</strong>
                  <div className="chart-card__annotation-form">
                    <select
                      className="card__control"
                      value={acceptedAxis}
                      onChange={(event) => setAcceptedAxis(event.target.value as ChartAnnotationAxis)}
                      aria-label={t('chart.annotationAxis')}
                    >
                      <option value="x">X</option>
                      <option value="y">Y</option>
                    </select>
                    <input
                      type="number"
                      className="card__control chart-card__number"
                      value={acceptedLower}
                      placeholder={t('chart.lower')}
                      onChange={(event) => setAcceptedLower(event.target.value)}
                    />
                    <input
                      type="number"
                      className="card__control chart-card__number"
                      value={acceptedUpper}
                      placeholder={t('chart.upper')}
                      onChange={(event) => setAcceptedUpper(event.target.value)}
                    />
                    <input
                      className="card__control chart-card__annotation-label"
                      value={acceptedLabel}
                      placeholder={t('chart.annotationLabel')}
                      onChange={(event) => setAcceptedLabel(event.target.value)}
                    />
                    <button type="button" className="card__control" onClick={addAcceptedRange}>
                      {t('chart.add')}
                    </button>
                  </div>
                  {card.config.acceptedRanges.map((range) => (
                    <div className="chart-card__annotation-row" key={range.id}>
                      <span>
                        {range.axis.toUpperCase()} {range.lower}…{range.upper}
                        {range.label ? ` · ${range.label}` : ''}
                      </span>
                      <button
                        type="button"
                        className="chart-card__annotation-remove"
                        title={t('chart.remove')}
                        onClick={() =>
                          setChartConfig(card.id, {
                            acceptedRanges: card.config.acceptedRanges.filter(
                              (entry) => entry.id !== range.id,
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <div className="chart-card__annotation-section">
                  <strong>{t('chart.limitRange')}</strong>
                  <div className="chart-card__annotation-form">
                    <select
                      className="card__control"
                      value={card.config.limitRange?.axis ?? 'y'}
                      onChange={(event) =>
                        patchLimitRange({
                          axis: event.target.value as ChartLimitRange['axis'],
                        })
                      }
                      aria-label={t('chart.annotationAxis')}
                    >
                      <option value="x">X</option>
                      <option value="y">Y</option>
                      <option value="value">{t('chart.colorValue')}</option>
                    </select>
                    <input
                      type="number"
                      className="card__control chart-card__number"
                      value={card.config.limitRange?.lower ?? ''}
                      placeholder={t('chart.lower')}
                      onChange={(event) =>
                        patchLimitRange({
                          lower:
                            event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                    <input
                      type="number"
                      className="card__control chart-card__number"
                      value={card.config.limitRange?.upper ?? ''}
                      placeholder={t('chart.upper')}
                      onChange={(event) =>
                        patchLimitRange({
                          upper:
                            event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                  </div>
                  <p className="chart-card__note">{t('chart.limitRangeHint')}</p>
                </div>
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${panel?.kind === 'options' ? ' is-open' : ''}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('options', event)}
            >
              {t('chart.axis')} ▾
            </button>
            {panel?.kind === 'options' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--wide"
                onDismiss={dismissPanel}
              >
                {/* Log axis is meaningless for bar (zero-height) and correlation types. */}
                {/* X-axis source selector — available for types that use row index by default. */}
                {typeDef.usesRowIndexAsX ? (
                  <label className="chart-card__field">
                    <span>{t('chart.xAxis')}</span>
                    <select
                      className="card__control"
                      value={xAxisSelectValue}
                      onChange={(event) => {
                        const val = event.target.value;
                        if (!val) {
                          setChartConfig(card.id, { xAxisSource: null });
                          return;
                        }
                        const [matrixId, columnIndex] = val.split(':').map(Number);
                        const matrix = matrices.get(matrixId);
                        if (!matrix || columnIndex >= matrix.columnCount()) return;
                        const col = matrix.column(columnIndex);
                        setChartConfig(card.id, {
                          xAxisSource: {
                            matrixId,
                            columnIndex,
                            label: col.annotation || col.posName,
                            raw: col.data.slice(),
                            categories: col.categories?.slice(),
                          },
                        });
                      }}
                    >
                      <option value="">{t('chart.xAxisDefault')}</option>
                      {availableColumns.map((col) => (
                        <option
                          key={`${col.matrixId}:${col.columnIndex}`}
                          value={`${col.matrixId}:${col.columnIndex}`}
                        >
                          {col.label} · {col.file}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {typeDef.supportsLogScale ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.logScale}
                      onChange={(event) =>
                        setChartConfig(card.id, { logScale: event.target.checked })
                      }
                    />
                    <span>{t('chart.logScale')}</span>
                  </label>
                ) : null}
                {card.config.type === 'heatmap' ? (
                  <>
                    <label className="chart-card__field">
                      <span>{t('chart.heatmapMode')}</span>
                      <select
                        className="card__control"
                        value={card.config.heatmapMode}
                        onChange={(event) =>
                          setChartConfig(card.id, {
                            heatmapMode: event.target.value as 'correlation' | 'field',
                          })
                        }
                      >
                        <option value="correlation">{t('chart.heatmapMode.correlation')}</option>
                        <option value="field">{t('chart.heatmapMode.field')}</option>
                      </select>
                    </label>
                    {card.config.heatmapMode === 'field' ? (
                      <>
                        <p className="chart-card__note">{t('chart.fieldTripletHint')}</p>
                        <label className="chart-card__field">
                          <span>{t('chart.colorMin')}</span>
                          <input
                            type="number"
                            className="card__control chart-card__number"
                            value={fieldMin}
                            onChange={(event) => setFieldMin(event.target.value)}
                          />
                        </label>
                        <label className="chart-card__field">
                          <span>{t('chart.colorMax')}</span>
                          <input
                            type="number"
                            className="card__control chart-card__number"
                            value={fieldMax}
                            onChange={(event) => setFieldMax(event.target.value)}
                          />
                        </label>
                        <div className="chart-card__field">
                          <button
                            type="button"
                            className="card__control"
                            onClick={() => {
                              const min = Number(fieldMin);
                              const max = Number(fieldMax);
                              if (
                                fieldMin.trim() === '' ||
                                fieldMax.trim() === '' ||
                                !Number.isFinite(min) ||
                                !Number.isFinite(max) ||
                                min >= max
                              ) {
                                return;
                              }
                              setChartConfig(card.id, {
                                fieldColorRange: { min, max },
                              });
                            }}
                          >
                            {t('chart.lockColorRange')}
                          </button>
                          <button
                            type="button"
                            className="card__control"
                            onClick={() => {
                              setChartConfig(card.id, { fieldColorRange: null });
                              setFieldMin('');
                              setFieldMax('');
                            }}
                          >
                            {t('chart.autoColorRange')}
                          </button>
                        </div>
                        <label className="chart-card__field">
                          <input
                            type="checkbox"
                            checked={card.config.showFieldContours}
                            onChange={(event) =>
                              setChartConfig(card.id, {
                                showFieldContours: event.target.checked,
                              })
                            }
                          />
                          <span>{t('chart.fieldContours')}</span>
                        </label>
                      </>
                    ) : null}
                  </>
                ) : null}
                {typeDef.supportsLogX ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.xLogScale ?? false}
                      onChange={(event) =>
                        setChartConfig(card.id, { xLogScale: event.target.checked })
                      }
                    />
                    <span>{t('chart.logXScale')}</span>
                  </label>
                ) : null}
                {typeDef.supportsSecondAxis ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.secondAxis}
                      onChange={(event) =>
                        setChartConfig(card.id, { secondAxis: event.target.checked })
                      }
                    />
                    <span>{t('chart.secondAxis')}</span>
                  </label>
                ) : null}
                {['bar', 'boxplot', 'violin', 'errorBar'].includes(card.config.type) ? (
                  <label className="chart-card__field">
                    <span>{t('chart.rawPoints')}</span>
                    <select
                      className="card__control"
                      value={card.config.rawPointMode}
                      onChange={(event) =>
                        setChartConfig(card.id, {
                          rawPointMode: event.target.value as 'auto' | 'always' | 'never',
                        })
                      }
                    >
                      <option value="auto">{t('chart.rawPoints.auto')}</option>
                      <option value="always">{t('chart.rawPoints.always')}</option>
                      <option value="never">{t('chart.rawPoints.never')}</option>
                    </select>
                  </label>
                ) : null}
                {card.config.type === 'scatter' || card.config.type === 'regression' ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.showFitLine}
                      onChange={(event) =>
                        setChartConfig(card.id, { showFitLine: event.target.checked })
                      }
                    />
                    <span>{t('chart.fitLine')}</span>
                  </label>
                ) : null}
                {card.config.type === 'line' ||
                card.config.type === 'scatter' ||
                card.config.type === 'regression' ? (
                  <div className="chart-card__analysis-section">
                    <label className="chart-card__field">
                      <span>{t('chart.analysisModel')}</span>
                      <select
                        className="card__control"
                        value={card.config.analysis?.model ?? 'none'}
                        onChange={(event) =>
                          setAnalysisModel(
                            event.target.value as ChartAnalysisOptions['model'] | 'none',
                          )
                        }
                      >
                        <option value="none">{t('chart.analysisOff')}</option>
                        <option value="linear">{t('chart.analysis.linear')}</option>
                        <option value="4pl">{t('chart.analysis.4pl')}</option>
                        <option value="exponential">{t('chart.analysis.exponential')}</option>
                        <option value="power">{t('chart.analysis.power')}</option>
                      </select>
                    </label>
                    {card.config.analysis ? (
                      <>
                        {card.config.analysis.model === 'linear' ? (
                          <label className="chart-card__field">
                            <input
                              type="checkbox"
                              checked={card.config.analysis.throughOrigin}
                              onChange={(event) =>
                                patchAnalysis({ throughOrigin: event.target.checked })
                              }
                            />
                            <span>{t('chart.analysisThroughOrigin')}</span>
                          </label>
                        ) : null}
                        <label className="chart-card__field">
                          <span>{t('chart.analysisWeighting')}</span>
                          <select
                            className="card__control"
                            value={card.config.analysis.weighting}
                            onChange={(event) =>
                              patchAnalysis({
                                weighting: event.target.value as ChartAnalysisOptions['weighting'],
                              })
                            }
                          >
                            <option value="none">{t('chart.analysisWeighting.none')}</option>
                            <option value="inverseX">{t('chart.analysisWeighting.inverseX')}</option>
                            <option value="inverseX2">{t('chart.analysisWeighting.inverseX2')}</option>
                          </select>
                        </label>
                        <label className="chart-card__field chart-card__field--column">
                          <span>{t('chart.analysisInitial')}</span>
                          <input
                            className="card__control"
                            value={analysisInitial}
                            placeholder={t('chart.analysisDefaults')}
                            onChange={(event) => {
                              setAnalysisInitial(event.target.value);
                              const parsed = parseAnalysisArray(event.target.value);
                              if (parsed !== undefined) patchAnalysis({ initial: parsed });
                            }}
                          />
                        </label>
                        <label className="chart-card__field chart-card__field--column">
                          <span>{t('chart.analysisLower')}</span>
                          <input
                            className="card__control"
                            value={analysisLower}
                            placeholder={t('chart.analysisDefaults')}
                            onChange={(event) => {
                              setAnalysisLower(event.target.value);
                              const parsed = parseAnalysisArray(event.target.value);
                              if (parsed !== undefined) patchAnalysis({ lower: parsed });
                            }}
                          />
                        </label>
                        <label className="chart-card__field chart-card__field--column">
                          <span>{t('chart.analysisUpper')}</span>
                          <input
                            className="card__control"
                            value={analysisUpper}
                            placeholder={t('chart.analysisDefaults')}
                            onChange={(event) => {
                              setAnalysisUpper(event.target.value);
                              const parsed = parseAnalysisArray(event.target.value);
                              if (parsed !== undefined) patchAnalysis({ upper: parsed });
                            }}
                          />
                        </label>
                        <label className="chart-card__field">
                          <span>{t('chart.analysisBands')}</span>
                          <select
                            className="card__control"
                            value={card.config.analysis.bands}
                            onChange={(event) =>
                              patchAnalysis({
                                bands: event.target.value as ChartAnalysisOptions['bands'],
                              })
                            }
                          >
                            <option value="none">{t('chart.analysisBands.none')}</option>
                            <option value="confidence">
                              {t('chart.analysisBands.confidence')}
                            </option>
                            <option value="prediction">
                              {t('chart.analysisBands.prediction')}
                            </option>
                            <option value="both">{t('chart.analysisBands.both')}</option>
                          </select>
                        </label>
                        <label className="chart-card__field">
                          <input
                            type="checkbox"
                            checked={card.config.showAnalysisDiagnostics}
                            onChange={(event) =>
                              setChartConfig(card.id, {
                                showAnalysisDiagnostics: event.target.checked,
                              })
                            }
                          />
                          <span>{t('chart.analysisDiagnostics')}</span>
                        </label>
                        <button
                          type="button"
                          className="chart-card__popup-item"
                          disabled={analysisRun?.state === 'running' || analysisArrayInvalid}
                          onClick={() => void runChartAnalysis(card.id)}
                        >
                          {analysisRun?.state === 'running'
                            ? t('chart.analysisRunning')
                            : t('chart.analysisRun')}
                        </button>
                        {analysisArrayInvalid ? (
                          <p className="chart-card__warn">{t('chart.analysisArrayInvalid')}</p>
                        ) : null}
                        {analysisRun?.state === 'error' ? (
                          <p className="chart-card__warn">
                            {t('chart.analysisError', {
                              code: analysisRun.code ?? 'internalError',
                              reason: String(analysisRun.params?.reason ?? ''),
                            })}
                          </p>
                        ) : null}
                        {analysisRun?.state === 'done' && analysisRun.output ? (
                          <p className="chart-card__note">
                            {t('chart.analysisSummary', {
                              r2: Number(analysisRun.output.summary.r2).toFixed(4),
                              n: String(analysisRun.output.summary.n),
                              lod: Number.isFinite(analysisRun.output.summary.lod)
                                ? Number(analysisRun.output.summary.lod).toFixed(4)
                                : '—',
                              loq: Number.isFinite(analysisRun.output.summary.loq)
                                ? Number(analysisRun.output.summary.loq).toFixed(4)
                                : '—',
                            })}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
                {card.config.type === 'bar' ? (
                  <label className="chart-card__field">
                    <span>{t('chart.layout')}</span>
                    <select
                      className="card__control"
                      value={card.config.layout}
                      onChange={(event) =>
                        setChartConfig(card.id, {
                          layout: event.target.value as 'grouped' | 'stacked',
                        })
                      }
                    >
                      <option value="grouped">{t('chart.layout.grouped')}</option>
                      <option value="stacked">{t('chart.layout.stacked')}</option>
                    </select>
                  </label>
                ) : null}
                {card.config.type === 'histogram' ? (
                  <label className="chart-card__field">
                    <span>{t('chart.bins')}</span>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      className="card__control chart-card__number"
                      value={card.config.binCount}
                      onChange={(event) => {
                        // The chart clamps to 1..200 anyway; storing the raw text meant the
                        // field showed a number (99999, -5) that had no effect on the render.
                        const raw = Number(event.target.value);
                        const clamped = Number.isFinite(raw)
                          ? Math.min(200, Math.max(0, Math.floor(raw)))
                          : 0;
                        setChartConfig(card.id, { binCount: clamped });
                      }}
                    />
                    <em>
                      {card.config.binCount === 0
                        ? t('chart.binsAuto')
                        : t('chart.binsUsed', { n: card.config.binCount })}
                    </em>
                  </label>
                ) : null}
                {card.config.type === 'errorBar' ? (
                  <>
                    <label className="chart-card__field">
                      <span>{t('chart.errorKind')}</span>
                      <select
                        className="card__control"
                        value={card.config.errorKind}
                        onChange={(event) =>
                          setChartConfig(card.id, {
                            errorKind: event.target.value as 'sd' | 'se' | 'ci95',
                          })
                        }
                      >
                        <option value="sd">{t('chart.error.sd')}</option>
                        <option value="se">{t('chart.error.se')}</option>
                        <option value="ci95">{t('chart.error.ci95')}</option>
                      </select>
                    </label>
                    <label className="chart-card__field">
                      <span>{t('chart.capWidth')}</span>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={card.config.capWidth}
                        onChange={(event) =>
                          setChartConfig(card.id, { capWidth: Number(event.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
                {card.config.xLogScale && nonPositiveCounts.x > 0 ? (
                  <p className="chart-card__warn">
                    {t('chart.logXDropsNonPositive', { n: nonPositiveCounts.x })}
                  </p>
                ) : null}
                {card.config.logScale && nonPositiveCounts.y > 0 ? (
                  <p className="chart-card__warn">
                    {t('chart.logYDropsNonPositive', { n: nonPositiveCounts.y })}
                  </p>
                ) : null}
                {secondAxisLabels.length > 0 ? (
                  <p className="chart-card__note">
                    {t('chart.secondAxisOn', { names: secondAxisLabels.join(', ') })}
                  </p>
                ) : null}
                {/* A wheel over the plot zooms both axes; this is the way back. */}
                {typeDef.id !== 'heatmap' ? (
                  <button
                    type="button"
                    className="chart-card__popup-item"
                    onClick={resetZoom}
                  >
                    {t('chart.resetZoom')}
                  </button>
                ) : null}
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel?.kind === 'export' ? ' is-open' : ''
              }`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('export', event)}
            >
              {t('chart.export')} ▾
            </button>
            {panel?.kind === 'export' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--export"
                onDismiss={dismissPanel}
              >
                {EXPORT_FORMATS.map((format) => (
                  <button
                    key={format.id}
                    type="button"
                    className="chart-card__popup-item"
                    onClick={() =>
                      void handleExport(
                        format.id === 'png' ? 'png' : (format.id as ExportType),
                      )
                    }
                  >
                    {format.id === 'png'
                      ? t('chart.exportPng', { ratio: pixelRatio })
                      : t(format.labelKey)}
                    <em className="chart-card__vec">
                      {format.vector ? t('chart.vector') : t('chart.raster')}
                    </em>
                  </button>
                ))}
                <label className="chart-card__field chart-card__field--tight">
                  <span>{t('chart.pixelRatio')}</span>
                  <select
                    className="card__control"
                    value={pixelRatio}
                    onChange={(event) => setPixelRatio(Number(event.target.value))}
                  >
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
              </Popup>
            ) : null}
          </div>

          <span className="chart-card__spacer" />
          <span className="chart-card__hint">{t(typeDef.hintKey)}</span>
        </div>

        {/* Plot area.

            The two branches carry explicit `key`s so React cannot recycle one DOM node for
            the other. Without them the node was reused on the plot -> empty transition and
            the text React had just written was wiped by zrender's `SVGPainter.dispose()`
            (`root.innerHTML = ''`), leaving a blank "needs N columns" message. */}
        {drawable ? (
          <div key="plot" className="chart-card__plot" ref={containerRef} />
        ) : (
          <div key="empty" className="chart-card__empty">
            {t('chart.needMoreColumns', { type: t(typeDef.labelKey), n: needed })}
          </div>
        )}

        {/* Column chips + smoothing */}
        <div className="chart-card__footer">
          <div className="chart-card__columns">
            <span className="chart-card__label">{t('chart.columns')}</span>
            {typeDef.columnArity === 'single' && card.config.sources.length > 1 ? (
              <span className="chart-card__note">
                {t('chart.onlyFirstColumn', { name: drawnSources[0]?.label ?? '' })}
              </span>
            ) : null}
            {card.config.sources.map((source) => (
              <span
                key={`${source.matrixId}:${source.columnIndex}`}
                className="chart-card__chip"
                title={source.label}
              >
                {/* A span is required for the ellipsis: `text-overflow` has no effect on
                    an anonymous flex item, so a long label would be cut mid-glyph. */}
                <span className="chart-card__chip-label">{source.label}</span>
                {/* No × here: removing a column is the column picker's job, and the dock's
                    X badge doubles as the toggle for the explicit X axis. Two controls that
                    both read "X" in one card taught nothing about which does what. */}
              </span>
            ))}
          </div>

          <div className="chart-card__controls">
            <label className="chart-card__control">
              <span>{t('chart.smoothing')}</span>
              <select
                className="card__control"
                value={card.smoothing.mode}
                onChange={(event) =>
                  setSmoothing(card.id, {
                    ...card.smoothing,
                    mode: event.target.value as SmoothingMode,
                  })
                }
              >
                {SMOOTHING_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`chart.mode.${mode}` as 'chart.mode.none')}
                  </option>
                ))}
              </select>
            </label>

            {card.smoothing.mode === 'exponential' ? (
              <label className="chart-card__control">
                <span>{t('chart.alpha')}</span>
                <input
                  type="range"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={card.smoothing.alpha}
                  onChange={(event) =>
                    setSmoothing(card.id, { ...card.smoothing, alpha: Number(event.target.value) })
                  }
                />
                <em>{card.smoothing.alpha.toFixed(2)}</em>
              </label>
            ) : (
              <label className="chart-card__control">
                <span>{t('chart.window')}</span>
                <input
                  type="range"
                  min={1}
                  max={101}
                  step={2}
                  value={card.smoothing.window}
                  disabled={card.smoothing.mode === 'none'}
                  onChange={(event) =>
                    setSmoothing(card.id, { ...card.smoothing, window: Number(event.target.value) })
                  }
                />
                <em>{card.smoothing.window}</em>
              </label>
            )}

            {card.smoothing.mode === 'savitzkyGolay' ? (
              <label className="chart-card__control">
                <span>{t('chart.degree')}</span>
                <input
                  type="number"
                  className="card__control chart-card__number"
                  min={1}
                  max={5}
                  value={card.smoothing.degree}
                  onChange={(event) => {
                    // `min`/`max` on a number input only constrain the spinner, not typing:
                    // 60 used to reach `sgCoefficients` and blow the series up to ±90.
                    const raw = Number(event.target.value);
                    const degree = Number.isFinite(raw)
                      ? Math.min(MAX_SG_DEGREE, Math.max(1, Math.floor(raw)))
                      : 1;
                    setSmoothing(card.id, { ...card.smoothing, degree });
                  }}
                />
              </label>
            ) : null}
          </div>
        </div>
        </div>
      </div>
    </CardShell>
  );
}

/** i18n key for the card's selected error kind (used in the legend name). */
function errorKey(card: ChartCardModel): 'chart.error.sd' | 'chart.error.se' | 'chart.error.ci95' {
  switch (card.config.errorKind) {
    case 'se':
      return 'chart.error.se';
    case 'ci95':
      return 'chart.error.ci95';
    default:
      return 'chart.error.sd';
  }
}

/** File-name stem for exports: chart type plus the first column label. */
function exportBaseName(card: ChartCardModel): string {
  const type = card.config.type;
  const label = card.config.sources[0]?.label ?? 'chart';
  const safe = `${type}-${label}`
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `datacardforge-${safe || 'chart'}`;
}

/** Re-exported so tests and the matrix card can share one definition of "drawable". */
export function chartIsDrawable(card: ChartCardModel): boolean {
  return isChartCard(card) && isDrawable(card.config);
}

/** Unused import guard: `applySmoothing` is re-exported for tests that exercise it here. */
export { applySmoothing };
