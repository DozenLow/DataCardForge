/**
 * Group confirmation popover for an ambiguous column unit (units v1, decision §三).
 *
 * The whole point of this panel is that it shows the *consequence before the action*: one
 * click confirms every column of the card that carries the same token, so the affected
 * columns are listed in full, above the choices. "The batch is always visible" is the safety
 * valve of group-level confirmation — a popover that only said "confirm `a` as A?" would
 * silently rewrite the meaning of ten more columns.
 *
 * Candidate readings come from the resolver (`UnitResolution.candidates`); it never adds
 * one of its own. Dismissal, viewport clamping and the portal are `Popup`'s job — a popup
 * rendered inside the card would be positioned against the card's transform and clipped.
 */
import type { ReactElement } from 'react';

import { NO_UNIT, type UnitCandidate } from '../../core/units.ts';
import { useTranslator } from '../workspaceStore.ts';
import { Popup } from './Popup.tsx';

export interface UnitAffectedColumn {
  columnIndex: number;
  label: string;
}

export interface UnitConfirmPopoverProps {
  /** Viewport anchor (the chip's top-left/bottom-left corner). */
  x: number;
  y: number;
  /** Raw token the resolver matched, shown verbatim so the user knows what is being read. */
  token: string;
  /** Suggested readings, in resolver order. Not a ranking. */
  candidates: readonly UnitCandidate[];
  /** Every pending column of THIS matrix carrying the same token (case-folded). */
  affected: readonly UnitAffectedColumn[];
  /**
   * Same-token columns that are *not* pending — already answered, or resolved some other
   * way. Shown read-only so the "N columns" count is never a surprise.
   */
  excluded?: readonly UnitAffectedColumn[];
  onDismiss: () => void;
  /** Confirm the group as one unit; `NO_UNIT` means "these columns have no unit". */
  onConfirm: (unit: string) => void;
}

export function UnitConfirmPopover({
  x,
  y,
  token,
  candidates,
  affected,
  excluded = [],
  onDismiss,
  onConfirm,
}: UnitConfirmPopoverProps): ReactElement {
  const { t } = useTranslator();

  return (
    <Popup x={x} y={y} className="context-menu context-menu--list unit-confirm" onDismiss={onDismiss}>
      <div className="context-menu__title" role="heading" aria-level={2}>
        {t('unit.popoverTitle', { token })}
      </div>
      <p className="context-menu__hint unit-confirm__hint">{t('unit.popoverHint')}</p>

      {/* The candidates. Hovering one previews how many columns it would take: the list
          below has to name them for the pending answer, so it names them for every choice. */}
      {candidates.map((candidate) => (
        <button
          key={candidate.unit}
          type="button"
          className="context-menu__item unit-confirm__candidate"
          title={affectedTitle(t, affected, candidate.unit)}
          onClick={() => onConfirm(candidate.unit)}
        >
          <span className="unit-confirm__unit">{candidate.unit}</span>
          {candidate.scalar ? null : (
            <span className="unit-confirm__tag">{t('unit.labelOnly')}</span>
          )}
        </button>
      ))}

      <div className="context-menu__separator" />
      <button
        type="button"
        className="context-menu__item unit-confirm__candidate"
        title={t('unit.notAUnitHint')}
        onClick={() => onConfirm(NO_UNIT)}
      >
        <span className="unit-confirm__unit">{t('unit.notAUnit')}</span>
      </button>

      <div className="context-menu__separator" />
      {/* The list of affected columns is fixed to the pending set: the group action covers
          exactly the columns that are still unanswered, and that is what must be shown. */}
      <div className="unit-confirm__batch">
        <div className="unit-confirm__batch-title">
          {affected.length > 0
            ? t('unit.affectedTitle', { n: affected.length, unit: token })
            : t('unit.affectedNone')}
        </div>
        <ul className="unit-confirm__columns">
          {affected.map((column) => (
            <li key={column.columnIndex}>{column.label}</li>
          ))}
        </ul>
        {excluded.length > 0 ? (
          <>
            <div className="unit-confirm__batch-title unit-confirm__batch-title--muted">
              {t('unit.affectedOther', { n: excluded.length })}
            </div>
            <ul className="unit-confirm__columns unit-confirm__columns--muted">
              {excluded.map((column) => (
                <li key={column.columnIndex}>{column.label}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="context-menu__separator" />
      <button type="button" className="context-menu__item" onClick={onDismiss}>
        {t('unit.cancel')}
      </button>
    </Popup>
  );
}

/** Hover text for a candidate: which columns that choice is about to answer. */
function affectedTitle(
  t: ReturnType<typeof useTranslator>['t'],
  affected: readonly UnitAffectedColumn[],
  unit: string,
): string {
  const names = affected.map((column) => column.label).join(', ');
  return `${t('unit.affectedTitle', { n: affected.length, unit })} ${names}`;
}