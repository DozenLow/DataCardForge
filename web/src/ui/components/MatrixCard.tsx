/**
 * Matrix card — the React equivalent of `src/widgets/MatrixCard.cpp` plus its
 * `MatrixTableModel`.
 *
 * Behaviour carried over from the Qt frontend:
 *   - one card can hold many files; a selector at the *top* switches between them,
 *   - file-backed tables are read-only,
 *   - right-clicking a column header offers "draw line chart for this column",
 *   - switching files notifies the workspace so dependent charts refresh.
 *
 * Columns that feed a chart are marked on their headers; the connection lines
 * themselves are card-level (see ConnectionLayer).
 */
import { useMemo, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { columnUnitResolutions, type UnitResolution } from '../../core/units.ts';
import type { ChartTypeId } from '../../charts/chartTypes.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { MatrixCardModel } from '../types.ts';
import { CardShell } from './CardShell.tsx';
import {
  ChartTypeItems,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSub,
} from './ContextMenu.tsx';
import { AddToChartItems } from './AddToChartItems.tsx';
import { SummaryPanel } from './SummaryPanel.tsx';
import { UnitConfirmPopover, type UnitAffectedColumn } from './UnitConfirmPopover.tsx';
import { VirtualTable, type ColumnUnitChip } from './VirtualTable.tsx';

interface MatrixCardProps {
  card: MatrixCardModel;
  matrix: MatrixData | undefined;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onOpenChart: (columnIndex: number, type: ChartTypeId) => number | null;
  /** New function card reading this table, created from the clicked column. */
  onOpenFormula: (column: number) => void;
  /** Relation-enumeration card from this column and its neighbour (two cell ports). */
  onOpenRelationEnum: (column: number) => void;
  /**
   * New script card reading this table as a whole (one matrix port, named at birth).
   *
   * No column argument: a script declares the names it reads, so it binds the table rather
   * than one of its columns — the same reason the port name, not the column, is the handle.
   */
  onOpenScript: () => void;
  /**
   * New unit-conversion card reading this table.
   *
   * No column argument, like the script card: the card converts whichever of the table's
   * columns the user chooses on the card itself, and converting is always an explicit
   * button press there (nothing is rewritten at creation).
   */
  onOpenUnitConvert: () => void;
  onActivate: () => void;
  /** True while a file is being dragged over this card (it would replace its data). */
  dropTarget?: boolean;
  /**
   * Ask the app to pick ONE file and replace the active one — the control the card was
   * missing: before it existed, a data card's file could never change, which is why a
   * saved workspace could not be reused as a template for a new day's data.
   */
  onReplaceFile: () => void;
  /** Columns of the displayed matrix that feed the currently selected chart. */
  sourceColumns?: readonly number[];
}

export function MatrixCard({
  card,
  matrix,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onOpenChart,
  onOpenFormula,
  onOpenRelationEnum,
  onOpenScript,
  onOpenUnitConvert,
  onActivate,
  dropTarget = false,
  onReplaceFile,
  sourceColumns = [],
}: MatrixCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setActiveSource = useWorkspace((s) => s.setActiveSource);
  const editCell = useWorkspace((s) => s.editCell);
  const setEditable = useWorkspace((s) => s.setEditable);
  const showToast = useWorkspace((s) => s.showToast);

  const [menu, setMenu] = useState<{ x: number; y: number; column: number } | null>(null);
  const [highlightColumn, setHighlightColumn] = useState<number | null>(null);
  /** Ambiguous unit chip awaiting an answer (the popover's anchor), if any. */
  const [unitAsk, setUnitAsk] = useState<{ column: number; x: number; y: number } | null>(null);

  const activeMatrixId = card.sources[card.activeSource]?.matrixId ?? -1;
  const unitConfirmations = useWorkspace((s) => s.unitConfirmations);
  const confirmUnitGroup = useWorkspace((s) => s.confirmUnitGroup);

  /**
   * Every column's unit, derived — the matrix stores no unit field (decision §三): this is
   * always `annotation + confirmation memory`, recomputed when either changes.
   */
  const unitView = useMemo(
    () =>
      matrix
        ? columnUnitResolutions(
            matrix.columns().map((column) => column.annotation),
            unitConfirmations,
          )
        : null,
    [matrix, unitConfirmations],
  );

  /** Header label for a column, the same expression the table prints. */
  const columnName = (index: number): string =>
    (matrix && (matrix.columnLabel(index) || matrix.column(index).posName)) ||
    t('unit.unnamedColumn', { n: index + 1 });

  /** The ambiguous resolution behind the open popover (re-read every render: it can change). */
  const askedResolution: UnitResolution | null =
    unitAsk && unitView ? (unitView.resolutions[unitAsk.column] ?? null) : null;

  /**
   * Columns the confirm would actually touch: the same token, case-folded, still ambiguous.
   * Mirrors `confirmUnitGroup`'s own rule so the list shown and the list changed are one set.
   */
  const unitBatch = useMemo(() => {
    if (!unitView || !askedResolution) return { affected: [], excluded: [] };
    const token = askedResolution.token.toLowerCase();
    const affected: UnitAffectedColumn[] = [];
    const excluded: UnitAffectedColumn[] = [];
    unitView.resolutions.forEach((resolution, index) => {
      if (resolution.token === '' || resolution.token.toLowerCase() !== token) return;
      const entry = { columnIndex: index, label: columnName(index) };
      if (resolution.state === 'ambiguous') affected.push(entry);
      else excluded.push(entry);
    });
    return { affected, excluded };
    // `columnName` reads only `matrix` and `t`, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitView, askedResolution, matrix, t]);

  const rows = matrix?.rowCount() ?? 0;
  const cols = matrix?.columnCount() ?? 0;
  const activeSourceName = card.sources[card.activeSource]?.name ?? '';
  /** The header the menu was opened on — the menu's title and the chart toast's name. */
  const menuColumnLabel =
    menu && matrix && menu.column < cols
      ? matrix.columnLabel(menu.column) || matrix.column(menu.column).posName
      : '';

  const title = matrix
    ? t(card.sources.length > 1 ? 'card.matrixMulti' : 'card.matrix', {
        name: activeSourceName,
        count: card.sources.length - 1,
        rows,
        cols,
      })
    : activeSourceName;

  const badge = `${t('table.rows', { n: rows })} · ${t('table.cols', { n: cols })}${
    card.readOnly ? ` · ${t('table.readOnly')}` : ''
  }`;

  /**
   * What the table draws per column: recognized → the unit, ambiguous → the raw token plus a
   * `?`, unknown → nothing. The chip is presentation; the click is reported upwards.
   */
  const columnUnit = (index: number): ColumnUnitChip | null => {
    const resolution = unitView?.resolutions[index];
    if (!resolution) return null;
    if (resolution.state === 'recognized') {
      return {
        label: resolution.unit,
        ambiguous: false,
        title: t('unit.recognized', { unit: resolution.unit }),
      };
    }
    if (resolution.state === 'ambiguous') {
      return {
        label: resolution.token,
        ambiguous: true,
        title: t('unit.ambiguous', { token: resolution.token }),
      };
    }
    return null;
  };

  /** Close the popover and answer for the whole group (idempotent in the store). */
  const confirmAskedToken = (unit: string) => {
    if (askedResolution) confirmUnitGroup(activeMatrixId, askedResolution.token, unit);
    setUnitAsk(null);
  };

  return (
    <CardShell
      card={card}
      variant="card--matrix"
      title={title}
      badge={badge}
      active={active}
      dropTarget={dropTarget}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
    >
      <div className="matrix-card">
        {/* File row: which file is shown, the one control that changes it, and the lock.
            Before the replace control existed the file was frozen for the card's lifetime. */}
        <div className="matrix-card__bar">
          {card.sources.length > 1 ? (
            <select
              className="matrix-card__selector card__control"
              value={card.activeSource}
              onChange={(event) => setActiveSource(card.id, Number(event.target.value))}
              title={activeSourceName}
              aria-label={activeSourceName}
            >
              {card.sources.map((source, index) => (
                <option key={source.name} value={index}>
                  {source.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="matrix-card__single-file" title={activeSourceName}>
              {activeSourceName}
            </div>
          )}

          <button
            type="button"
            className="matrix-card__replace card__control"
            title={t('matrix.replaceFile')}
            aria-label={t('matrix.replaceFile')}
            onClick={() => onReplaceFile()}
          >
            {/* Inline SVG, not an emoji: a font without the glyph would render a blank box. */}
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.2 6.6a5 5 0 0 1 8.7-2.1M12.8 9.4a5 5 0 0 1-8.7 2.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M12.6 1.6v3h-3M3.4 14.4v-3h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Lock / unlock. Without this the whole cell-editing path was unreachable: every
              matrix card was created read-only and nothing in the UI could change that. */}
          <button
            type="button"
            className={`matrix-card__lock card__control${
              card.readOnly ? '' : ' matrix-card__lock--open'
            }`}
            title={card.readOnly ? t('table.editable') : t('table.readOnly')}
            aria-label={card.readOnly ? t('table.editable') : t('table.readOnly')}
            aria-pressed={!card.readOnly}
            onClick={() => setEditable(card.id, card.readOnly)}
          >
            {/* Inline SVG, not an emoji: a font without the glyph would render a blank box. */}
            {card.readOnly ? (
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M11.5 1.9l2.6 2.6L5.6 13H3v-2.6z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>

        {matrix && cols > 0 ? (
          <VirtualTable
            matrix={matrix}
            readOnly={card.readOnly}
            rowLabel={(n) => t('table.rowHeader', { n })}
            highlightColumn={highlightColumn}
            sourceColumns={sourceColumns}
            onCellChange={(row, col, value) => editCell(card.id, row, col, value)}
            onInvalidEdit={(raw) => showToast('error', t('table.invalidNumber', { value: raw }))}
            onHeaderClick={(column) =>
              setHighlightColumn((current) => (current === column ? null : column))
            }
            onHeaderContextMenu={(event, column) => {
              event.preventDefault();
              // The card owns its own menu: without this the event also reaches the canvas,
              // whose right-click gesture belongs to a different surface.
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY, column });
            }}
            columnUnit={columnUnit}
            onUnitChipClick={(column, event) => {
              // Anchor below the chip: the answered question is "which unit is this token?",
              // and the chip is the thing being explained.
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              setUnitAsk({ column, x: rect.left, y: rect.bottom + 4 });
            }}
          />
        ) : (
          <div className="matrix-card__empty">{t('empty.hint')}</div>
        )}
        {/* 摘要: the card's own table summarised by the backend. Its state, its node and its
            open flag live in the store (session-only), so the card model is untouched —
            and it never computes by itself; the panel asks first. */}
        <SummaryPanel card={card} />
      </div>

      {unitAsk && askedResolution && askedResolution.state === 'ambiguous' ? (
        <UnitConfirmPopover
          x={unitAsk.x}
          y={unitAsk.y}
          token={askedResolution.token}
          candidates={askedResolution.candidates}
          affected={unitBatch.affected}
          excluded={unitBatch.excluded}
          onDismiss={() => setUnitAsk(null)}
          onConfirm={confirmAskedToken}
        />
      ) : null}

      {menu ? (
        // The title is the column name, not the old "绘制图表 · <column>" line: "draw chart"
        // is now a submenu entry, and a title must say where the menu is — the header it was
        // opened on — because all three card menus share this shape.
        <ContextMenu x={menu.x} y={menu.y} title={menuColumnLabel} onDismiss={() => setMenu(null)}>
          <ContextMenuSub label={t('table.contextChartMenu')}>
            <ChartTypeItems
              remaining={cols - menu.column}
              columnLabel={menuColumnLabel}
              onPick={(type) => {
                // The primitive is menu-agnostic: it reports the outcome, the card owns its
                // own lifecycle. Close here for both outcomes — on a refusal the toast is
                // the answer, and a menu left open reads as "the click did nothing".
                const created = onOpenChart(menu.column, type);
                setMenu(null);
                return created;
              }}
            />
          </ContextMenuSub>
          {/* A chart that already exists can take this column: the explicit way to add a
              second source, now that the dock only lists cards a chart already reads. */}
          <AddToChartItems
            matrixId={card.sources[card.activeSource]?.matrixId ?? -1}
            columnIndex={menu.column}
          />
          <div className="context-menu__separator" />
          <ContextMenuItem
            onClick={() => {
              onOpenFormula(menu.column);
              setMenu(null);
            }}
          >
            {t('menu.newFormula')}
          </ContextMenuItem>
          <ContextMenuItem
            title={
              cols >= 2
                ? t('menu.newRelationEnum')
                : t('status.needTwoColumns', {
                    type: t('menu.newRelationEnum'),
                    have: cols,
                  })
            }
            disabled={cols < 2}
            onClick={() => {
              onOpenRelationEnum(menu.column);
              setMenu(null);
            }}
          >
            {t('menu.newRelationEnum')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              onOpenScript();
              setMenu(null);
            }}
          >
            {t('menu.newScriptCard')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              onOpenUnitConvert();
              setMenu(null);
            }}
          >
            {t('menu.newUnitConvertCard')}
          </ContextMenuItem>
        </ContextMenu>
      ) : null}
    </CardShell>
  );
}
