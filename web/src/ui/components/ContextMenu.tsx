/**
 * The right-click menu, as three shared primitives.
 *
 * Why this file exists: the same nine chart types were hand-copied into three menus — the
 * data card's column header, the function card's result header and the script card's output
 * row. Each copy re-derived "how many columns remain", the disabled rule, the tooltip
 * wording and the toast, so the three could drift apart one edit at a time; and nine
 * near-identical entries sat at the top of a first-level menu, pushing the entries that
 * actually create *different* things (formula card / relation card / script card) below them.
 *
 * So: one chart-type list that lives inside a submenu, and one place that owns the
 * "enough columns?" rule. Callers only say which column the chart is anchored on and how to
 * build it (`onPick`), and the toast is emitted here — one implementation, one wording.
 *
 * `Popup` does the portal + viewport clamping (see its header for why a popup cannot be
 * rendered inside the card), so a submenu is just a second `Popup` anchored to the right of
 * its parent entry.
 */
import { useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  CHART_TYPE_ORDER,
  chartTypeDef,
  minimumColumns,
  type ChartTypeId,
} from '../../charts/chartTypes.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { Popup } from './Popup.tsx';

export interface ContextMenuProps {
  /** Viewport coordinates of the menu's top-left corner (before `Popup` clamps them). */
  x: number;
  y: number;
  /** Optional heading line. A column name is the useful one: it says WHERE this menu is. */
  title?: ReactNode;
  onDismiss: () => void;
  children: ReactNode;
}

/** A titled right-click menu. Nothing else: behaviour, clamping and dismissal are `Popup`'s. */
export function ContextMenu({ x, y, title, onDismiss, children }: ContextMenuProps): ReactElement {
  return (
    <Popup x={x} y={y} className="context-menu context-menu--list" onDismiss={onDismiss}>
      {title === undefined ? null : <div className="context-menu__title">{title}</div>}
      {children}
    </Popup>
  );
}

export interface ContextMenuItemProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Native tooltip — the one place to explain WHY an entry is greyed out. */
  title?: string;
}

/** One clickable row of a menu. */
export function ContextMenuItem({
  children,
  onClick,
  disabled = false,
  title,
}: ContextMenuItemProps): ReactElement {
  return (
    <button
      type="button"
      className="context-menu__item"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface ContextMenuSubProps {
  /** The first-level row's text; a chevron is appended by the component. */
  label: string;
  title?: string;
  /** The second-level menu's contents. */
  children: ReactNode;
}

/**
 * A first-level entry that opens a second-level menu to its right.
 *
 * Both gestures open it: hover (a submenu is a detail, not a destination) and click. A click
 * that merely confirms what the pointer already revealed must not close the panel again, so
 * the click handler remembers whether the hover opened it — otherwise moving to the entry and
 * clicking it would collapse the menu the user just found.
 */
export function ContextMenuSub({ label, title, children }: ContextMenuSubProps): ReactElement {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  /** Anchor of the open submenu, in viewport coordinates; `null` = closed. */
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const hoverOpened = useRef(false);
  const open = anchor !== null;

  // Anchor on the entry's RIGHT edge: the submenu is a child list of this row, and opening
  // over the parent would hide the entry the user is pointing at. `Popup` clamps the result
  // to the viewport, so a menu near the right edge flips back into view on its own.
  const openAt = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    setAnchor({ x: (rect?.right ?? 0) + 4, y: rect?.top ?? 0 });
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="context-menu__item context-menu__item--sub"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={() => {
          if (open) return;
          hoverOpened.current = true;
          openAt();
        }}
        onClick={() => {
          const wasHoverOpened = hoverOpened.current;
          hoverOpened.current = false;
          if (!open) openAt();
          else if (!wasHoverOpened) setAnchor(null);
        }}
      >
        {label}
        <span className="context-menu__chevron" aria-hidden="true">
          ▸
        </span>
      </button>
      {anchor ? (
        <Popup
          x={anchor.x}
          y={anchor.y}
          className="context-menu context-menu--list"
          onDismiss={() => setAnchor(null)}
        >
          {children}
        </Popup>
      ) : null}
    </>
  );
}

export interface ChartTypeItemsProps {
  /** Columns left from the anchor column (rightwards) — what a chart may read. */
  remaining: number;
  /** The anchor column's display name; only used in the "created" toast. */
  columnLabel: string;
  /** Build the card. `null` means the store refused (see the toast rule below). */
  onPick: (type: ChartTypeId) => number | null;
  /**
   * Wording for a refusal the width rule does NOT explain.
   *
   * An enabled entry can still fail: a script card announces its run one round trip before
   * the output's cache is filled, so "needs N columns" would blame the data for a timing
   * gap. Only the caller can tell the two apart; without the hint this list falls back to
   * the width wording, which is the only refusal it can prove on its own.
   */
  refusedHint?: string;
}

/**
 * The nine chart types, ready to drop into a `ContextMenuSub`.
 *
 * The rule lives here, not in the three callers: a chart reads the anchor column *and the
 * ones after it*, so "enough" is measured against the remaining columns — testing the
 * table's total once let the last column offer "scatter", which then created nothing.
 *
 * The toast is emitted here too, because the wording of a refusal belongs to the rule that
 * decided it. `onPick` returning `null` means the store said no; the caller has nothing
 * better to add, and a second toast would only replace this one on screen.
 */
export function ChartTypeItems({
  remaining,
  columnLabel,
  onPick,
  refusedHint,
}: ChartTypeItemsProps): ReactElement {
  const { t } = useTranslator();
  return (
    <>
      {CHART_TYPE_ORDER.map((id) => {
        const def = chartTypeDef(id);
        const needed = minimumColumns(id);
        const enough = remaining >= needed;
        const refusal = t('status.needTrailingColumns', {
          type: t(def.labelKey),
          n: needed,
          have: remaining,
        });
        return (
          <ContextMenuItem
            key={id}
            title={enough ? t(def.hintKey) : refusal}
            disabled={!enough}
            onClick={() => {
              const created = onPick(id);
              // Read the action at click time instead of subscribing: a toast is
              // fire-and-forget display state, not something a menu renders.
              const toast = useWorkspace.getState().showToast;
              // An entry this list *enabled* was refused for a reason the width rule cannot
              // see, so the caller's wording is the honest one there.
              if (created === null) toast('error', enough && refusedHint ? refusedHint : refusal);
              else toast('info', t('status.chartCreated', { name: columnLabel }));
            }}
          >
            {t(def.labelKey)}
          </ContextMenuItem>
        );
      })}
    </>
  );
}