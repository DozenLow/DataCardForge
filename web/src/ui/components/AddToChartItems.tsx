/**
 * "添加到图表 ▸" — attach one column to a chart that already exists.
 *
 * The column dock lists only the cards a chart already reads, so adding a *new* source is
 * this menu: a deliberate gesture on the column it adds, listing the charts that could
 * receive it. The store derives the chart's edge from its sources (`commitChartConfig`), so
 * the connection is made — and cycle-checked — by the same rule as any other graph edit.
 */
import { isChartCard, type CardModel, type ChartCardModel } from '../types.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { ContextMenuItem, ContextMenuSub } from './ContextMenu.tsx';

interface AddToChartItemsProps {
  /** The matrix the picked column belongs to. */
  matrixId: number;
  columnIndex: number;
}

/** Every chart in the workspace — the cards a column could join. */
function targetCharts(cards: readonly CardModel[]): ChartCardModel[] {
  return cards.filter(isChartCard);
}

export function AddToChartItems({ matrixId, columnIndex }: AddToChartItemsProps) {
  const { t } = useTranslator();
  const cards = useWorkspace((state) => state.cards);
  const addChartSource = useWorkspace((state) => state.addChartSource);
  const charts = targetCharts(cards);
  // No chart, no submenu: an empty one would read as a broken command.
  if (charts.length === 0) return null;

  return (
    <ContextMenuSub label={t('chart.addToExisting')}>
      {charts.map((chart) => (
        <ContextMenuItem
          key={chart.id}
          onClick={() => addChartSource(chart.id, matrixId, columnIndex)}
        >
          {chart.title.trim() || t('chart.columnDockOwner', { n: chart.id })}
        </ContextMenuItem>
      ))}
    </ContextMenuSub>
  );
}
