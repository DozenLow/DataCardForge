/**
 * Unit-conversion card — the body of a `builtin:unit-convert` function card (units v1 P2).
 *
 * Three decisions this file embodies, each of which is easy to undo by accident:
 *
 *   - **Nothing is converted here.** The browser derives the SOURCE units (they are
 *     metadata: `annotation` + the confirmation memory, exactly what the header chips
 *     show), the backend does the arithmetic. The only trigger is the card's 换算 button →
 *     the store's `convertUnits` → `POST /api/nodes/{id}/compute`
 *     (docs/decisions/2026-11-18-units-v1.md §四).
 *   - **Every target carries an explicit `from`.** The backend re-parses the annotation when
 *     `from` is absent, and a column the user confirmed on the data card (`current_a` → A)
 *     still parses `ambiguous` — so an omitted `from` would throw the confirmation away and
 *     the conversion would be refused with `unitAmbiguous`. `buildTargets` is the one place
 *     that decides what goes on the wire, and it never omits it.
 *   - **Only scalar units with a known dimension are convertible.** An `ambiguous` / no-unit
 *     column gets a disabled picker and a hint pointing at the data card (confirming is that
 *     card's gesture, not this one's); a recognised non-scalar one (°C / dB / HRC) says
 *     "not convertible" instead of offering a conversion that has no meaning.
 *
 * The result grid is the ordinary function-card one (`VirtualTable` + CSV), because the
 * output IS a whole table: the targeted columns converted, every other column passed
 * through verbatim by the backend.
 */
import { useEffect, useMemo, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import {
  columnUnitResolutions,
  convertibleUnits,
  type UnitCandidate,
  type UnitResolution,
} from '../../core/units.ts';
import type { MessageKey } from '../i18n.ts';
import { downloadText, matrixToCsv } from '../fileActions.ts';
import { registerPort, unregisterPort } from '../cardMetrics.ts';
import type { FunctionCardModel, NodeStatus } from '../types.ts';
import {
  unitConvertTargets,
  useTranslator,
  useWorkspace,
  type UnitConvertTarget,
} from '../workspaceStore.ts';
import { useGlobalSettings } from '../useGlobalSettings.ts';
import { CardShell } from './CardShell.tsx';
import { ROW_HEADER_WIDTH, VirtualTable } from './VirtualTable.tsx';

/**
 * The value a `<select>` shows for "keep as-is".
 *
 * The empty string is the React-controlled convention for "nothing chosen", so no registry
 * unit can collide with it (a unit token is never empty).
 */
const KEEP = '';

/** Every unit that can be a conversion TARGET, grouped by dimension (registry order kept). */
function unitsByDimension(): Map<string, UnitCandidate[]> {
  const map = new Map<string, UnitCandidate[]>();
  for (const candidate of convertibleUnits()) {
    if (candidate.dimension === null) continue;
    const list = map.get(candidate.dimension) ?? [];
    // The registry lists a unit once, but a defensively repeated entry must not become a
    // duplicate option.
    if (!list.some((entry) => entry.unit === candidate.unit)) list.push(candidate);
    map.set(candidate.dimension, list);
  }
  return map;
}

/**
 * Turn the picker's choices into `params.targets`.
 *
 * `targets` is `column -> unit string`; the source unit is always read back from the
 * resolution for that column, never from the picker. Entries whose column is not convertible
 * are dropped (the picker cannot choose them, but a hand-edited workspace can hold them).
 */
export function buildTargets(
  resolutions: readonly UnitResolution[],
  chosen: Readonly<Record<number, string>>,
): UnitConvertTarget[] {
  const targets: UnitConvertTarget[] = [];
  for (const [key, to] of Object.entries(chosen)) {
    const column = Number(key);
    if (to === KEEP || to === '') continue;
    const resolution = resolutions[column];
    if (!resolution || resolution.state !== 'recognized' || !resolution.scalar) continue;
    // THE line of this card: an explicit `from` is how the user's confirmation travels.
    targets.push({ column, from: resolution.unit, to });
  }
  return targets.sort((left, right) => left.column - right.column);
}

/**
 * Start the picker from the card's stored parameter.
 *
 * A reloaded workspace keeps its `targets` (they are the signature's parameter), so the
 * picker must show what the card will send, not an empty column of "keep as-is".
 */
function initialChoices(targets: readonly UnitConvertTarget[]): Record<number, string> {
  const choices: Record<number, string> = {};
  for (const target of targets) choices[target.column] = target.to;
  return choices;
}

interface UnitConvertCardProps {
  card: FunctionCardModel;
  /**
   * The card's display cache, if the caller already has it.
   *
   * Optional and only a fallback: the authoritative read is the store subscription below,
   * so the grid appears the moment a conversion lands even when the parent re-renders for
   * an unrelated reason first (a card is one subscription away from its own numbers).
   */
  resultMatrix?: MatrixData;
  /** Column labels of the input table, for the "input table is empty" hint. */
  sourceColumnNames: string[];
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onActivate: () => void;
}

export function UnitConvertCard({
  card,
  resultMatrix,
  sourceColumnNames,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onActivate,
}: UnitConvertCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const matrices = useWorkspace((s) => s.matrices);
  /** Own subscription to the display cache: the grid must follow the store, not the props. */
  const displayMatrix = useWorkspace((s) => s.matrices.get(card.displayMatrixId)) ?? resultMatrix;
  const unitConfirmations = useWorkspace((s) => s.unitConfirmations);
  /** The workspace + global half of the units resolution chain (units L1b §B2). */
  const unitConstants = useWorkspace((s) => s.unitConstants);
  const globalUnitPreconfirm = useGlobalSettings().unitPreconfirm;
  /** Units a formula output inherits from a unit-preserving expression (units L2a). */
  const inheritedUnits = useWorkspace((s) => s.inheritedUnits);
  const convertUnits = useWorkspace((s) => s.convertUnits);
  const loadFullResult = useWorkspace((s) => s.loadFullResult);
  const run = useWorkspace((s) => s.unitRuns[card.id]);

  /** The input table, resolved through the card's one matrix port. */
  const sourceMatrix = useMemo(() => {
    const input = card.inputs.find((entry) => entry.target.type === 'matrix');
    return input ? matrices.get(input.target.matrixId) : undefined;
  }, [card.inputs, matrices]);

  /**
   * Every column's source unit — the SAME derivation the data card's header chips use:
   * `annotation` + the confirmation memory, recomputed when either changes (the matrix
   * stores no unit field).
   */
  const resolutions = useMemo<readonly UnitResolution[]>(
    () =>
      sourceMatrix
        ? columnUnitResolutions(
            sourceMatrix.columns().map((column) => column.annotation),
            unitConfirmations,
            // A conversion target is only offered when the SOURCE unit is known, so the
            // source must be read through the same chain as the chip that shows it —
            // including a unit the source formula output inherited (units L2a).
            { constants: unitConstants, preconfirm: globalUnitPreconfirm, inherited: inheritedUnits },
          ).resolutions
        : [],
    [sourceMatrix, unitConfirmations, unitConstants, globalUnitPreconfirm, inheritedUnits],
  );

  const dimensions = useMemo(() => unitsByDimension(), []);

  /** The picker's current choice per column (`''` = 保持原样). */
  const [chosen, setChosen] = useState<Record<number, string>>(() =>
    initialChoices(unitConvertTargets(card)),
  );

  /**
   * Follow the card when its parameter changes from the outside (a restored workspace, an
   * undo). Only when the SET of targets changes: adopting every render would fight the user
   * while they are still choosing, before the button is pressed.
   */
  const storedTargets = JSON.stringify(unitConvertTargets(card));
  useEffect(() => {
    setChosen(initialChoices(unitConvertTargets(card)));
    // `storedTargets` is the identity that matters; the card object itself changes on every
    // render (node state, lamp, …).
  }, [storedTargets]);

  // One port, one anchor: the connection layer finds it by portId, never by position.
  const portRef = (element: HTMLElement | null) => {
    if (!element) return undefined;
    registerPort(card.id, 'src', element, 'left');
    return () => unregisterPort(card.id, 'src');
  };

  const columns = sourceMatrix ? sourceMatrix.columns() : [];
  const targets = useMemo(() => buildTargets(resolutions, chosen), [resolutions, chosen]);
  const pending = JSON.stringify(targets.map(({ column, to }) => ({ column, to })));
  const stored = JSON.stringify(
    unitConvertTargets(card).map(({ column, to }) => ({ column, to })),
  );
  /** The picker holds choices the card has not been told about yet. */
  const edited = targets.length > 0 && pending !== stored;

  const rows = displayMatrix?.rowCount() ?? 0;
  const cols = displayMatrix?.columnCount() ?? 0;
  /**
   * The five visible states, derived the way the 摘要 panel derives them.
   *
   * The node's own status is authoritative; `stale` is "this card HAS converted before and
   * the node is dirty now", which the backend produces for an upstream change (it also
   * empties the result matrix, so the grid is already gone by then).
   */
  const state: NodeStatus['state'] | 'idle' | 'stale' =
    run?.status === 'running' || card.node?.state === 'computing'
      ? 'computing'
      : run?.status === 'error' || card.node?.state === 'error'
        ? 'error'
        : card.node?.state === 'dirty'
          ? // Only a card that HAS produced a table can be stale: a never-converted one is
            // 尚未换算, and saying 上游已变 there would invent a lost result.
            run?.computedAt !== null && run?.computedAt !== undefined
            ? 'stale'
            : 'idle'
          : card.node?.state === 'done'
            ? 'done'
            : 'idle';

  /**
   * The error sentence, built from the backend's structured `code` + params — never from
   * server prose (the backend does not send any). An unknown code still says something
   * instead of swallowing the failure.
   */
  const error = useMemo(() => {
    if (!run || run.status !== 'error' || run.code === null) return null;
    const key = `formula.error.${run.code}` as MessageKey;
    const localised = t(key, normaliseParams(run.params));
    const usable = localised !== key && !/\{\w+\}/.test(localised);
    return usable ? localised : `${t('formula.error.unknown')} (${run.code})`;
  }, [run, t]);

  const columnName = (index: number): string =>
    (sourceMatrix && (sourceMatrix.columnLabel(index) || sourceMatrix.column(index).posName)) ||
    t('unit.unnamedColumn', { n: index + 1 });

  const statusText =
    state === 'computing'
      ? t('convert.converting')
      : state === 'error'
        ? (error ?? t('formula.error.unknown'))
        : state === 'stale'
          ? t('convert.resultStale')
          : state === 'done'
            ? t('convert.done', {
                // Local time: there is no computed-at field in the protocol, so the card
                // says out loud which clock this is (the 摘要 panel's rule).
                time: run?.computedAt
                  ? new Date(run.computedAt).toLocaleTimeString(undefined, { hour12: false })
                  : '—',
              })
            : edited
              ? t('convert.edited')
              : t('convert.resultPending');

  const badge = `${sourceColumnNames.length} ${t('convert.columns')} · ${rows} ${t('formula.rows')}`;

  /**
   * One row per input column: label, source unit, target picker and the reason the picker
   * is disabled when it is.
   */
  const pickerRow = (index: number) => {
    const resolution = resolutions[index];
    const name = columnName(index);
    const convertible =
      resolution !== undefined && resolution.state === 'recognized' && resolution.scalar;
    const targetsForDimension =
      convertible && resolution.dimension !== null
        ? (dimensions.get(resolution.dimension) ?? [])
        : [];

    /** Why the picker cannot be used, or `null` when it can. */
    const blocked: string | null = !resolution
      ? null
      : resolution.state === 'ambiguous'
        ? t('convert.needSource')
        : resolution.state === 'unknown'
          ? t('convert.needSource')
          : !resolution.scalar
            ? t('convert.notConvertible')
            : null;

    const sourceLabel =
      resolution === undefined || resolution.state === 'unknown'
        ? t('convert.unknown')
        : resolution.state === 'ambiguous'
          ? t('convert.ambiguous', { token: resolution.token })
          : resolution.unit;

    return (
      <li key={index} className="unit-convert__entry" data-column={index}>
        <span className="unit-convert__name" title={name}>
          {name}
        </span>
        <span
          className={`unit-convert__source unit-convert__source--${resolution?.state ?? 'unknown'}`}
          title={
            resolution?.state === 'ambiguous'
              ? t('convert.needSourceTip', { token: resolution.token })
              : resolution?.state === 'recognized' && !resolution.scalar
                ? t('convert.notConvertibleTip', { unit: resolution.unit })
                : undefined
          }
        >
          {sourceLabel}
        </span>
        <select
          className="unit-convert__target card__control"
          aria-label={`${t('convert.targetUnit')} — ${name}`}
          value={chosen[index] ?? KEEP}
          disabled={!convertible}
          onChange={(event) =>
            setChosen((current) => ({ ...current, [index]: event.target.value }))
          }
        >
          <option value={KEEP}>{t('convert.keep')}</option>
          {targetsForDimension.map((candidate) => (
            <option key={candidate.unit} value={candidate.unit}>
              {candidate.unit}
            </option>
          ))}
        </select>
        {blocked ? <span className="unit-convert__blocked">{blocked}</span> : null}
      </li>
    );
  };

  const download = (): void => {
    if (!displayMatrix) return;
    downloadText(`unit-convert-${card.id}.csv`, matrixToCsv(displayMatrix), 'text/csv;charset=utf-8');
  };

  return (
    <CardShell
      card={card}
      variant="card--formula card--unit-convert"
      title={t('convert.card')}
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
      minWidth={420}
      minHeight={320}
    >
      <div className="unit-convert">
        <div className="unit-convert__body">
          {/* ── the picker: one row per input column ── */}
          <section className="unit-convert__columns" aria-label={t('convert.zoneColumns')}>
            <header className="unit-convert__head">
              <span className="unit-convert__col-label">{t('convert.column')}</span>
              <span className="unit-convert__col-label">{t('convert.sourceUnit')}</span>
              <span className="unit-convert__col-label">{t('convert.targetUnit')}</span>
            </header>
            {columns.length === 0 ? (
              <p className="unit-convert__empty">{t('convert.noSource')}</p>
            ) : (
              <ul className="unit-convert__list">
                {columns.map((_, index) => pickerRow(index))}
              </ul>
            )}
            {/* The folded rail of the input zone: the one port, so a connection line still
                has something to attach to when the card is narrow. */}
            <span ref={portRef} className="unit-convert__port" aria-hidden>
              src
            </span>
          </section>

          {/* ── the result: the ordinary function-card grid ── */}
          <section className="unit-convert__result" aria-label={t('convert.zoneResult')}>
            <div className="unit-convert__bar">
              <span className={`node-light node-light--${state}`} aria-hidden />
              <span className="unit-convert__status" role="status">
                {statusText}
              </span>
              <span className="unit-convert__actions">
                {cols > 0 ? (
                  <button
                    type="button"
                    className="card__control unit-convert__export"
                    onClick={download}
                  >
                    {t('convert.export')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="card__control unit-convert__convert"
                  disabled={targets.length === 0 || state === 'computing'}
                  title={
                    targets.length === 0 && columns.length > 0
                      ? t('convert.nothingChosen')
                      : undefined
                  }
                  onClick={() => convertUnits(card.id, targets)}
                >
                  {state === 'computing'
                    ? t('convert.converting')
                    : state === 'done' || state === 'stale'
                      ? t('convert.reconvert')
                      : t('convert.convert')}
                </button>
              </span>
            </div>
            {error ? (
              <p className="unit-convert__error" role="alert">
                {error}
              </p>
            ) : null}
            {displayMatrix && cols > 0 ? (
              <div className="unit-convert__grid">
                <VirtualTable
                  matrix={displayMatrix}
                  readOnly
                  rowLabel={(n) => t('convert.rowHeader', { n })}
                  rowHeaderWidth={ROW_HEADER_WIDTH}
                />
                {card.result && !card.result.complete && !card.result.truncated ? (
                  <div className="unit-convert__more" role="status">
                    <span className="unit-convert__count">
                      {t('formula.resultPreview', {
                        shown: card.result.shownRows,
                        total: card.result.totalRows,
                      })}
                    </span>
                    <button
                      type="button"
                      className="card__control"
                      title={t('formula.showAllTip', { total: card.result.totalRows })}
                      onClick={() => loadFullResult(card.id)}
                    >
                      {t('formula.showMore')}
                    </button>
                  </div>
                ) : null}
                {card.result?.truncated ? (
                  <p className="unit-convert__truncated">
                    {t('formula.resultTruncated', { n: card.result.shownRows })}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="unit-convert__empty">
                {/* The zone must agree with the status bar: "nothing chosen" is only true
                    when no target is pending. Saying it while choices await the first
                    conversion (or while an upstream change invalidated the last table)
                    contradicted the bar one line above. */}
                {run?.status === 'error'
                  ? t('convert.resultError')
                  : state === 'computing'
                    ? t('convert.converting')
                    : state === 'stale'
                      ? t('convert.resultStale')
                      : targets.length > 0
                        ? t('convert.resultPending')
                        : t('convert.nothingChosen')}
              </div>
            )}
          </section>
        </div>
      </div>
    </CardShell>
  );
}

/**
 * Error params as translation values.
 *
 * The backend sends numbers for `column` (a 0-based index) and strings for the rest. The
 * panel prints the index verbatim — it is the same identity the picker lists — rather than
 * trying to re-derive a label from a table that may already have changed.
 */
function normaliseParams(
  params: Record<string, unknown> | null,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}