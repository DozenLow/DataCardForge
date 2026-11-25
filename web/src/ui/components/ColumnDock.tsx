/**
 * Column dock — the collapsible column picker on the left edge of a chart card.
 *
 * A chart depends on the whole matrix *card*, so which columns it draws is purely a
 * presentation choice. This dock is the one place that choice is made (it replaced the
 * footer's "+ Add column…" select). Collapsed it costs a thin rail; expanded it lists the
 * matrices of **the cards this chart reads** — a data card's active file, and each output
 * of a function card — grouped by where the columns come from.
 *
 * It deliberately does NOT enumerate the whole workspace: a matrix the chart has no edge to
 * is not a presentation choice but a new connection, and connections are explicit (right-
 * click a column or an output row -> 添加到图表). Listing everything made one chart able to
 * draw any card's output — including the very table a script card consumes — which the
 * dataflow contract forbids.
 *
 * Since 2026-11-19 the zone is the SHARED `SidePanel` in the formula card's visual language
 * rather than a bespoke dock: the same head, the same rotated rail, the same port-row
 * metrics. That is not only cosmetic — a chart that rendered no port had its wires land on
 * its card edge (`resolveEdgeAnchors` falls back when nothing is registered), while every
 * other card met its wire at the row the data actually belongs to. Each chart source is now
 * a real port (`chartPortId`), registered on its row when the panel is open and on its rail
 * chip when it is folded — exactly what FormulaCard does with its inputs.
 *
 * It deliberately imports nothing from ChartCard or the ECharts stack, so it stays
 * inexpensive and testable on its own.
 */
import { useMemo } from 'react';

import { chartTypeDef } from '../../charts/chartTypes.ts';
import { minimumColumnsForConfig } from '../../charts/chartModel.ts';
import { publishedMatrices, useTranslator, useWorkspace } from '../workspaceStore.ts';
import { registerPort, unregisterPort, type AnchorSide } from '../cardMetrics.ts';
import { CHART_PORT_X, chartPortId } from '../migrate.ts';
import type { ChartCardModel } from '../types.ts';
import { SidePanel } from './SidePanel.tsx';

interface ColumnDockProps {
  card: ChartCardModel;
  /** Visibility of the left zone, persisted with the card (`columnPanelOpen`). */
  open: boolean;
  onToggle: (open: boolean) => void;
  /**
   * Scrolling the dock moves its ports. Wired to one `invalidateLayout`, so the connection
   * layer re-measures on the same schedule the formula card uses.
   */
  onScroll?: () => void;
}

interface DockColumn {
  matrixId: number;
  columnIndex: number;
  label: string;
}

interface DockGroup {
  name: string;
  columns: DockColumn[];
}

/**
 * Display label for one column of a listed matrix.
 *
 * The store builds the same label for every `ChartSource` it materialises (`columnLabel`),
 * but this file also lists columns the chart has never attached, and that helper is private
 * to the store — so the rule is repeated here rather than exported a second time.
 */
function dockColumnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? `${column.posName} ${column.annotation}` : column.posName;
}

export function ColumnDock({ card, open, onToggle, onScroll }: ColumnDockProps) {
  const { t } = useTranslator();
  const cards = useWorkspace((s) => s.cards);
  const matrices = useWorkspace((s) => s.matrices);
  const addChartSource = useWorkspace((s) => s.addChartSource);
  const removeChartSource = useWorkspace((s) => s.removeChartSource);
  const setChartConfig = useWorkspace((s) => s.setChartConfig);

  const typeDef = chartTypeDef(card.config.type);
  // A chart must always keep at least one column, and a paired type needs two.
  const floor = Math.max(
    minimumColumnsForConfig(card.config),
    ...(card.config.composition?.panels.map((panel) =>
      minimumColumnsForConfig({ ...card.config, type: panel.type, composition: null }),
    ) ?? []),
  );

  /**
   * The cards this chart reads — its own edges, not the workspace.
   *
   * `inputs[]` is the authoritative edge list (a chart's edges are re-derived from its
   * config by the store), so this needs no separate bookkeeping.
   */
  const connected = useMemo(() => {
    const ids = new Set<number>();
    for (const input of card.inputs) ids.add(input.target.cardId);
    return ids;
  }, [card.inputs]);

  const groups = useMemo<DockGroup[]>(() => {
    const out: DockGroup[] = [];
    // (matrixId, columnIndex) pairs a group already offers. The fallback below uses it to
    // add only what the user could not reach any other way — and to dedupe a source that
    // was somehow attached twice.
    const listed = new Set<string>();

    for (const entry of cards) {
      // Only the cards this chart reads. Another card's matrix is reachable through the
      // explicit "添加到图表" gesture, never by appearing here.
      if (!connected.has(entry.id)) continue;
      // `publishedMatrices` enumerates what the card publishes; a chart publishes nothing,
      // so it contributes no group without this file needing to know what a chart is.
      for (const published of publishedMatrices(entry)) {
        const matrix = matrices.get(published.matrixId);
        // A declared slot exists before anything fills it. Listing zero columns would only
        // add an empty heading, and there is no column for the user to choose anyway.
        if (!matrix || matrix.columnCount() === 0) continue;

        const columns: DockColumn[] = [];
        for (let index = 0; index < matrix.columnCount(); ++index) {
          columns.push({
            matrixId: published.matrixId,
            columnIndex: index,
            label: dockColumnLabel(matrix.column(index)),
          });
          listed.add(`${published.matrixId}:${index}`);
        }

        // A file is identified by its name; an output by the card that declares it plus the
        // name the declaration gives it (falling back to the identity, which never lies).
        const ownerLabel = entry.title.trim() || t('chart.columnDockOwner', { n: entry.id });
        out.push({
          name:
            published.fileName ?? `${ownerLabel} · ${published.outputName ?? published.outputId}`,
          columns,
        });
      }
    }

    // Whatever the chart draws that no card publishes would otherwise be invisible — and an
    // invisible attached column cannot be unchecked, which is exactly the trap this dock
    // exists to prevent. The label recorded at attach time is used because there may be no
    // matrix left to read names from: its source card was closed, or its slot never got
    // filled, and the chart still plots the values it holds.
    const unlisted: DockColumn[] = [];
    for (const source of card.config.sources) {
      const key = `${source.matrixId}:${source.columnIndex}`;
      if (listed.has(key)) continue;
      listed.add(key);
      unlisted.push({
        matrixId: source.matrixId,
        columnIndex: source.columnIndex,
        label: source.label,
      });
    }
    if (unlisted.length > 0) out.push({ name: t('chart.columnDockUnlisted'), columns: unlisted });

    return out;
  }, [cards, matrices, card.config.sources, connected, t]);

  const isChecked = (matrixId: number, columnIndex: number): boolean =>
    card.config.sources.some(
      (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
    );

  const orderOf = (matrixId: number, columnIndex: number): number =>
    card.config.sources.findIndex(
      (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
    ) + 1;

  const isXAxis = (matrixId: number, columnIndex: number): boolean =>
    card.config.xAxisSource !== null &&
    card.config.xAxisSource.matrixId === matrixId &&
    card.config.xAxisSource.columnIndex === columnIndex;

  /**
   * Port ids this card's dependency edges name — the ids the connection layer looks up.
   *
   * Derived from the display config with the same rule the store uses to build `inputs[]`
   * (`chartInputsFromConfig`), so the registry and the edges can never disagree: one
   * `chartPortId` per attached column, plus `CHART_PORT_X` when an explicit X axis is set.
   */
  const portIds = useMemo<string[]>(() => {
    const ids = card.config.sources.map((source) =>
      chartPortId(source.matrixId, source.columnIndex),
    );
    if (card.config.xAxisSource) ids.push(CHART_PORT_X);
    return ids;
  }, [card.config.sources, card.config.xAxisSource]);

  /**
   * Register one rendered element as the endpoint of `portId`.
   *
   * Memoised by port identity on purpose: a fresh callback per render would make React
   * detach and re-attach the ref (unregister + register), and every registration bumps the
   * layout version — one wire re-measure per render for nothing.
   */
  const portRefFor = useMemo(() => {
    const callbacks = new Map<
      string,
      (element: HTMLElement | null) => (() => void) | undefined
    >();
    return (portId: string, side: AnchorSide) => {
      const key = `${side}:${portId}`;
      const existing = callbacks.get(key);
      if (existing) return existing;
      const callback = (element: HTMLElement | null) => {
        if (!element) return undefined;
        registerPort(card.id, portId, element, side);
        // A stale rect would leave a wire pointing at nothing once the row leaves the list
        // (or the column folds, which hands the id to the rail chip).
        return () => unregisterPort(card.id, portId);
      };
      callbacks.set(key, callback);
      return callback;
    };
  }, [card.id]);

  /** The port id a listed column stands for — the key the folded rail registers. */
  const portIdOfColumn = (matrixId: number, columnIndex: number): string =>
    chartPortId(matrixId, columnIndex);

  /**
   * The lamp describes whether the chart has something to draw, which is the one piece of
   * state this zone owns: `done` once it has the columns its type needs, `dirty` otherwise.
   */
  const drawable = card.config.sources.length >= floor;

  const empty = groups.every((group) => group.columns.length === 0);

  /** Folded rail: one chip per registered port, and the chip IS the port element. */
  const rail =
    portIds.length === 0 ? (
      <span className="side-panel__rail-empty">—</span>
    ) : (
      <>
        {card.config.sources.map((source) => (
          <button
            type="button"
            className="rail-port"
            key={portIdOfColumn(source.matrixId, source.columnIndex)}
            ref={portRefFor(portIdOfColumn(source.matrixId, source.columnIndex), 'left')}
            title={source.label}
            onClick={() => onToggle(true)}
          >
            {source.label}
          </button>
        ))}
        {card.config.xAxisSource ? (
          // `portIds` names CHART_PORT_X too, so the folded rail must keep its anchor
          // registered — otherwise the explicit X-axis wire falls back to the card edge.
          <button
            type="button"
            className="rail-port"
            key={CHART_PORT_X}
            ref={portRefFor(CHART_PORT_X, 'left')}
            title={t('chart.xAxisPort')}
            onClick={() => onToggle(true)}
          >
            {t('chart.xAxisPort')}
          </button>
        ) : null}
      </>
    );

  return (
    <SidePanel
      side="left"
      open={open}
      onToggle={onToggle}
      title={t('chart.columnDock')}
      panelId={`chart-dock-${card.id}`}
      className="chart-card__dock"
      onScroll={onScroll}
      headExtra={
        <span
          className={`node-light node-light--${drawable ? 'done' : 'dirty'}`}
          title={drawable ? t('chart.columnDockReady') : t('chart.columnDockMissing')}
          aria-hidden
        />
      }
      rail={rail}
    >
      {empty ? (
        <p className="formula-card__zone-empty">{t('chart.columnDockEmpty')}</p>
      ) : (
        <div className="chart-card__dock-groups">
          {groups.map((group, groupIndex) => (
            // A group name is not unique: two cards can publish outputs called the same
            // thing, and the fallback group's title is a fixed string.
            <div key={groupIndex} className="chart-card__dock-group">
              <div className="chart-card__dock-group-title" title={group.name}>
                {group.name}
              </div>
              <ul className="formula-card__port-list">
                {group.columns.map((column) => {
                  const checked = isChecked(column.matrixId, column.columnIndex);
                  const xAxis = isXAxis(column.matrixId, column.columnIndex);
                  const atFloor = card.config.sources.length <= floor;
                  const portId = portIdOfColumn(column.matrixId, column.columnIndex);
                  return (
                    <li
                      key={portId}
                      // A checked column IS a port this chart reads, so its row is the
                      // wire's endpoint — the metric the formula card's `src` row uses.
                      className={`formula-card__port chart-card__dock-item${
                        checked ? ' chart-card__dock-item--port' : ''
                      }`}
                      ref={checked ? portRefFor(portId, 'left') : undefined}
                      data-port-id={portId}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={checked && atFloor}
                        title={
                          checked && atFloor
                            ? t('chart.columnDockRequired', {
                                type: t(typeDef.labelKey),
                                n: floor,
                              })
                            : column.label
                        }
                        onChange={(event) => {
                          if (event.target.checked) {
                            addChartSource(card.id, column.matrixId, column.columnIndex);
                          } else {
                            removeChartSource(card.id, column.matrixId, column.columnIndex);
                          }
                        }}
                      />
                      <span className="formula-card__port-src chart-card__dock-item-label">
                        {column.label}
                      </span>
                      {checked ? (
                        <span className="formula-card__port-id chart-card__dock-badge">
                          {orderOf(column.matrixId, column.columnIndex)}
                        </span>
                      ) : null}
                      {xAxis ? (
                        <button
                          type="button"
                          className="formula-card__port-id chart-card__dock-badge chart-card__dock-x card__control"
                          ref={portRefFor(CHART_PORT_X, 'left')}
                          title={t('chart.xAxisPort')}
                          aria-label={t('chart.xAxisPort')}
                          onClick={() => {
                            // The X axis is a presentation choice like the plotted
                            // columns, so it is set (and cleared) from this zone.
                            if (xAxis) {
                              setChartConfig(card.id, { xAxisSource: null });
                            }
                          }}
                        >
                          X
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {typeDef.columnArity === 'pairs' ? (
        <p className="formula-card__zone-empty chart-card__dock-order">
          {t('chart.columnDockOrder')}
        </p>
      ) : null}
    </SidePanel>
  );
}