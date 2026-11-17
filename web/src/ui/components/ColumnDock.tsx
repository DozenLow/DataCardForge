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
 * It deliberately imports nothing from ChartCard or the ECharts stack, so it stays
 * inexpensive and testable on its own.
 */
import { useMemo } from 'react';

import { chartTypeDef, minimumColumns } from '../../charts/chartTypes.ts';
import { publishedMatrices, useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { ChartCardModel } from '../types.ts';

interface ColumnDockProps {
  card: ChartCardModel;
  /** Controls visibility of the whole chart's header, mirroring the footer. */
  open: boolean;
  onToggle: (open: boolean) => void;
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

export function ColumnDock({ card, open, onToggle }: ColumnDockProps) {
  const { t } = useTranslator();
  const cards = useWorkspace((s) => s.cards);
  const matrices = useWorkspace((s) => s.matrices);
  const addChartSource = useWorkspace((s) => s.addChartSource);
  const removeChartSource = useWorkspace((s) => s.removeChartSource);

  const typeDef = chartTypeDef(card.config.type);
  // A chart must always keep at least one column, and a paired type needs two.
  const floor = Math.max(1, minimumColumns(card.config.type));

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

  if (!open) {
    return (
      <div className="chart-card__dock">
        <button
          type="button"
          className="chart-card__dock-toggle"
          aria-expanded={false}
          aria-controls={`chart-dock-${card.id}`}
          title={t('chart.columnDock')}
          onClick={() => onToggle(true)}
        >
          {t('chart.columnDockToggle')}
        </button>
      </div>
    );
  }

  const empty = groups.every((group) => group.columns.length === 0);

  return (
    <div className="chart-card__dock chart-card__dock--open" id={`chart-dock-${card.id}`}>
      <div className="chart-card__dock-head">
        <span className="chart-card__dock-title">{t('chart.columnDock')}</span>
        <button
          type="button"
          className="chart-card__dock-collapse card__control"
          aria-label={t('chart.columnDockCollapse')}
          title={t('chart.columnDockCollapse')}
          onClick={() => onToggle(false)}
        >
          ‹
        </button>
      </div>
      {empty ? (
        <div className="chart-card__dock-empty">{t('chart.columnDockEmpty')}</div>
      ) : (
        <div className="chart-card__dock-list">
          {groups.map((group, groupIndex) => (
            // A group name is not unique: two cards can publish outputs called the same
            // thing, and the fallback group's title is a fixed string.
            <div key={groupIndex} className="chart-card__dock-group">
              <div className="chart-card__dock-group-title" title={group.name}>
                {group.name}
              </div>
              {group.columns.map((column) => {
                const checked = isChecked(column.matrixId, column.columnIndex);
                const atFloor = card.config.sources.length <= floor;
                return (
                  <label
                    key={`${column.matrixId}:${column.columnIndex}`}
                    className="chart-card__dock-item"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && atFloor}
                      title={
                        checked && atFloor
                          ? t('chart.columnDockRequired', { type: t(typeDef.labelKey), n: floor })
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
                    <span className="chart-card__dock-item-label">{column.label}</span>
                    {checked ? (
                      <span className="chart-card__dock-badge">
                        {orderOf(column.matrixId, column.columnIndex)}
                      </span>
                    ) : null}
                    {isXAxis(column.matrixId, column.columnIndex) ? (
                      <span className="chart-card__dock-badge">X</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {typeDef.columnArity === 'pairs' ? (
        <p className="chart-card__dock-order">{t('chart.columnDockOrder')}</p>
      ) : null}
    </div>
  );
}
