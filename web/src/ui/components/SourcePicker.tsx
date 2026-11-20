/**
 * Source picker — where one script input port says which table it reads (M2).
 *
 * WHY THIS MAY ENUMERATE THE WHOLE WORKSPACE (and the chart dock may not):
 * `ColumnDock` lists only the cards a chart already reads, because which COLUMNS a chart
 * draws is a presentation choice — an unattached column is not a choice but a new
 * connection, and connections are explicit gestures. A script port is the opposite kind of
 * thing: `B` in the script is a **binding declaration** that has to name a table, the port
 * exists before any edge does, and the left panel is its only edit surface. So this picker
 * may enumerate every publishable matrix in the workspace, and the line between the two
 * surfaces is fixed in the decision
 * (docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md §五).
 *
 * WHAT IT LISTS: `publishedMatrices(card)` per card — a data card publishes the file it is
 * showing, a function card publishes one address per declared output (unit-convert cards
 * included, with no special case here). Never a raw matrix id: which id stands behind a
 * card's second output is the store's rule to keep, not a component's to re-derive.
 *
 * WHY A PORTAL: a card is a react-rnd window positioned with `transform`, which makes it the
 * containing block for `position: fixed` descendants, and `.card { overflow: hidden }` clips
 * them. `Popup` renders into `document.body` for exactly that reason (see Popup.tsx) — an
 * overlay drawn inside the card would be clipped or displaced by the card's own offset.
 *
 * THREE MARKED STATES, none of them a veto on what already exists:
 *   - 成环 (self / downstream): GREYED and not clickable. The store would refuse the edge
 *     (`applyCardInputs` runs the same `findDownstreamPath` test), so this never calls it —
 *     a click that has to be undone by a toast is worse than a row that cannot be clicked.
 *   - 已绑定: another port already reads this matrix. Still pickable: two variables over one
 *     table is harmless (`A` and `B` can both be `a.csv`), so this is a label, not a block.
 *   - 尚未计算: an output slot that carries no server-side matrix yet (`resultMatrixId <= 0`)
 *     — a card born offline, or restored from a snapshot before its node existed. Still
 *     pickable: the binding is declared now and completes when the slot registers (the
 *     store's retry predicate covers it). Note that a node's slots get their ids at PUSH
 *     time, so "never computed but already registered" does not reach this state; the mark
 *     means "there is no table to read yet", which is the only thing the binding cares about.
 *
 * CANCEL LEAVES NOTHING BEHIND: this component never declares a port until a row is picked
 * (the store's `addScriptInput` is what creates port + name + edge, in one atomic write), so
 * dismissing the popup by Escape, by an outside click or by the window resizing writes
 * exactly nothing.
 */
import { useMemo } from 'react';

import type { Locale } from '../i18n.ts';
import { portVarName } from '../bindings.ts';
import {
  countScriptOccurrences,
  nextScriptVarName,
  publishedMatrices,
  useTranslator,
  useWorkspace,
  type PublishedMatrix,
} from '../workspaceStore.ts';
import {
  isFormulaCard,
  isMatrixCard,
  isScriptCard,
  scriptParams,
  type CardModel,
} from '../types.ts';
import { Popup } from './Popup.tsx';

export type SourcePickerMode = 'add' | 'rebind';

export interface SourcePickerProps {
  /** The script card the port belongs to (or is about to be added to). */
  cardId: number;
  mode: SourcePickerMode;
  /** The port being re-bound. Required for `rebind`, ignored for `add`. */
  portId?: string;
  /** Viewport coordinates of the control that opened the picker (see `Popup`). */
  x: number;
  y: number;
  /** Fired on cancel, on Escape, on an outside click — and after a successful pick. */
  onDismiss: () => void;
}

// ── prose ─────────────────────────────────────────────────────────────────────────────
//
// Same shape as ScriptCard's own table (and for the same reason: this lane owns only its
// own files). Every string here is bilingual; nothing user-visible is hard-coded below.

interface PickerLabels {
  addTitle: string;
  /** `{name}` is the port's variable (`A`). */
  rebindTitle: string;
  /** `{n}` is the card id, for a card that carries no title of its own. */
  cardFallback: string;
  /** `{name}` is the variable of the port that already reads this matrix. */
  boundAs: string;
  uncomputed: string;
  refusedSelf: string;
  refusedDownstream: string;
  empty: string;
  /** `{name}` is the name the new port will take, `{n}` how often the script names it. */
  nameReuse: string;
  activeFileOnly: string;
}

const LABELS: Record<Locale, PickerLabels> = {
  zh: {
    addTitle: '新增输入端口的来源',
    rebindTitle: '端口 {name} 改接来源',
    cardFallback: '卡片 #{n}',
    boundAs: '已绑定为 {name}',
    uncomputed: '尚未计算',
    refusedSelf: '本卡自己的输出',
    refusedDownstream: '会成环：此卡已经依赖本卡',
    empty: '工作区里还没有可发布的矩阵',
    nameReuse: '新端口将命名为 {name}，脚本里还有 {n} 处 {name} —— 这些引用会接到新表上',
    activeFileOnly: '数据卡只列出它当前显示的文件（要换文件请先在数据卡上切换）',
  },
  en: {
    addTitle: 'Source for the new input port',
    rebindTitle: 'Re-bind port {name}',
    cardFallback: 'Card #{n}',
    boundAs: 'Already bound as {name}',
    uncomputed: 'Not computed yet',
    refusedSelf: 'This card’s own output',
    refusedDownstream: 'Would create a cycle: this card already depends on this one',
    empty: 'No publishable matrices in this workspace yet',
    nameReuse:
      'The new port will be named {name} and the script still names it {n}× — those references ' +
      'will point at the new table',
    activeFileOnly:
      'A data card lists only the file it is showing (switch the file on the card first)',
  },
};

/** `{name}` / `{n}` substitution — same one-liner ScriptCard's prose table uses. */
function fill(template: string, params: Record<string, string | number>): string {
  let text = template;
  for (const [key, value] of Object.entries(params)) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

// ── one pickable matrix ─────────────────────────────────────────────────────────────

interface Candidate {
  matrixId: number;
  /** What this matrix is called inside its group: a file name, or an output name/id. */
  label: string;
  /** The stable identity of a function card's output (`out:1`), or null for a file. */
  badge: string | null;
  /** Why the store would refuse this source; null when the row is pickable. */
  refused: null | 'self' | 'downstream';
  /** Variable of ANOTHER port that already reads this matrix, or null. */
  boundAs: string | null;
  /** A function-card output with no server-side matrix yet (`resultMatrixId <= 0`). */
  uncomputed: boolean;
}

interface CandidateGroup {
  ownerId: number;
  title: string;
  rows: Candidate[];
}

/**
 * Greyed, not hidden: a refused candidate must stay READABLE — the reason is the point —
 * and it may not look clickable. The colour comes from the shared popup-item rule, so only
 * the two properties that change are set here (inline: this lane owns no stylesheet).
 */
const REFUSED_STYLE = { opacity: 0.45, cursor: 'not-allowed' } as const;

/**
 * The row's label: one line, ellipsised. A file name can be longer than the popup, and
 * `.chart-card__popup-item` is `nowrap`, so without this the text would spill out of the
 * rounded box. Inline for the same reason as above (no stylesheet in this lane's scope).
 */
const LABEL_STYLE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

export function SourcePicker({ cardId, mode, portId, x, y, onDismiss }: SourcePickerProps) {
  const { locale } = useTranslator();
  const labels = LABELS[locale];
  const cards = useWorkspace((state) => state.cards);
  // The live graph: the same test the store applies before it writes an edge, so a row is
  // greyed exactly when `applyCardInputs` would refuse the pick.
  const dependencies = useWorkspace((state) => state.dependencies);
  const addScriptInput = useWorkspace((state) => state.addScriptInput);
  const rebindScriptInput = useWorkspace((state) => state.rebindScriptInput);

  const card = cards.find((entry) => entry.id === cardId);
  const scriptCard = card !== undefined && isScriptCard(card) ? card : null;
  const script = scriptCard ? scriptParams(scriptCard) : null;

  /** The port's variable names, aligned to `inputs[]` (the panel's own rule). */
  const portNames = useMemo(
    () =>
      scriptCard
        ? scriptCard.inputs.map((input, index) => portVarName(scriptCard, input, index))
        : [],
    [scriptCard],
  );

  const groups = useMemo<CandidateGroup[]>(() => {
    if (!scriptCard) return [];
    const out: CandidateGroup[] = [];
    for (const entry of cards) {
      const published = publishedMatrices(entry);
      if (published.length === 0) continue;

      const rows = published.map(
        (item: PublishedMatrix): Candidate => ({
          matrixId: item.matrixId,
          // A file is named by its file name; an output by the name its declaration gives
          // it, falling back to the identity (which is always true) — never to an invented
          // "Output 1".
          label: item.fileName ?? item.outputName ?? item.outputId ?? `#${item.matrixId}`,
          // The stable `out:N`, shown only when the label is a NAME: an unnamed output is
          // already labelled by its identity, and printing it twice says nothing.
          badge: item.outputId !== null && item.outputName !== null ? item.outputId : null,
          // Self first: `findDownstreamPath(from, from)` also reports a path, and "your own
          // output" explains itself better than "would create a cycle".
          refused:
            entry.id === cardId
              ? 'self'
              : dependencies.findDownstreamPath(entry.id, cardId) !== null
                ? 'downstream'
                : null,
          boundAs: boundVarName(scriptCard, entry.id, item, portId, portNames),
          uncomputed:
            item.outputId !== null && isFormulaCard(entry)
              ? (entry.outputs.find((output) => output.outputId === item.outputId)
                  ?.resultMatrixId ?? -1) <= 0
              : false,
        }),
      );

      out.push({
        ownerId: entry.id,
        // The group is the SOURCE CARD; the row is the matrix it publishes. A data card in
        // this build carries no title of its own (`title: ''`), so it falls back to its id —
        // the file it is showing is what its one row says (ColumnDock names the same way).
        title:
          entry.title.trim() !== ''
            ? entry.title
            : fill(labels.cardFallback, { n: entry.id }),
        rows,
      });
    }
    return out;
  }, [cards, dependencies, scriptCard, cardId, portId, portNames, labels]);

  /**
   * The NAME-REUSE warning (M1 finding f).
   *
   * A removed port frees its letter, and the next add hands that letter out again — the
   * script, however, may still name it (a stale reference that survived the removal). The
   * new port would then silently become what that reference points at. This says so before
   * the pick; it is a hint, never a block (the store's `nextScriptVarName` sees only live
   * names, and that rule is correct for a name allocator).
   */
  const nextName =
    scriptCard && script !== null ? nextScriptVarName([...portNames, ...script.outputs]) : '';
  const nextNameOccurrences =
    mode === 'add' && script !== null && nextName !== ''
      ? countScriptOccurrences(script.script, nextName)
      : 0;

  /** Only worth saying when a data card actually hides files behind its active one. */
  const hidesFiles = cards.some((entry) => isMatrixCard(entry) && entry.sources.length > 1);

  if (!scriptCard) return null;
  if (mode === 'rebind' && portId === undefined) return null;

  // The re-bound port's variable, for the heading. A port that a write removed under the
  // open popup falls back to its identity, which is always true.
  const reboundIndex =
    portId === undefined ? -1 : scriptCard.inputs.findIndex((input) => input.portId === portId);
  const reboundName = portId === undefined ? '' : portNames[reboundIndex] ?? portId;
  const title =
    mode === 'rebind' ? fill(labels.rebindTitle, { name: reboundName }) : labels.addTitle;

  const pick = (ownerId: number, candidate: Candidate): void => {
    // Belt and braces: a refused row is `disabled`, but a cycle candidate must never reach
    // the store from this surface, whatever the DOM does.
    if (candidate.refused !== null) return;
    // The store owns the write (port + name + edge, atomically, cycle-checked). In rebind
    // mode it changes the target only: `in:N`, the variable and the script stay put.
    const target = { type: 'matrix' as const, cardId: ownerId, matrixId: candidate.matrixId };
    const accepted =
      mode === 'rebind' && portId !== undefined
        ? rebindScriptInput(cardId, portId, target)
        : addScriptInput(cardId, target) !== null;
    // A refusal (the graph moved under us) keeps the popup open so another row can be
    // picked; the store has already said why with its own toast.
    if (accepted) onDismiss();
  };

  const empty = groups.length === 0;

  return (
    <Popup
      x={x}
      y={y}
      className="chart-card__popup chart-card__popup--wide source-picker"
      onDismiss={onDismiss}
    >
      <div
        className="source-picker__body"
        role="group"
        aria-label={title}
        data-source-picker={cardId}
        data-mode={mode}
        data-rebind-port={mode === 'rebind' ? portId : undefined}
      >
        <div className="chart-card__field source-picker__title">{title}</div>

        {nextNameOccurrences > 0 ? (
          <p className="script-card__name-warn source-picker__warning" role="status">
            {fill(labels.nameReuse, { name: nextName, n: nextNameOccurrences })}
          </p>
        ) : null}

        {empty ? (
          <p className="formula-card__zone-empty source-picker__empty">{labels.empty}</p>
        ) : (
          <div className="chart-card__dock-groups source-picker__groups">
            {groups.map((group) => (
              <div className="chart-card__dock-group source-picker__group" key={group.ownerId}>
                <div
                  className="chart-card__dock-group-title source-picker__group-title"
                  title={group.title}
                >
                  {group.title}
                </div>
                <ul className="formula-card__port-list">
                  {group.rows.map((candidate) => {
                    const mark =
                      candidate.refused === 'self'
                        ? labels.refusedSelf
                        : candidate.refused === 'downstream'
                          ? labels.refusedDownstream
                          : candidate.boundAs !== null
                            ? fill(labels.boundAs, { name: candidate.boundAs })
                            : candidate.uncomputed
                              ? labels.uncomputed
                              : null;
                    return (
                      <li key={`${group.ownerId}:${candidate.matrixId}`}>
                        <button
                          type="button"
                          className="chart-card__popup-item source-picker__item"
                          style={candidate.refused !== null ? REFUSED_STYLE : undefined}
                          // A refused source is not a choice: `disabled` also takes it out
                          // of the keyboard's tab order, which is what "not pickable" means.
                          disabled={candidate.refused !== null}
                          data-matrix-id={candidate.matrixId}
                          data-owner-id={group.ownerId}
                          data-refusal={candidate.refused ?? undefined}
                          data-bound-as={candidate.boundAs ?? undefined}
                          data-uncomputed={candidate.uncomputed ? 'true' : undefined}
                          title={
                            candidate.refused !== null
                              ? mark ?? undefined
                              : [candidate.label, mark].filter(Boolean).join(' · ')
                          }
                          onClick={() => pick(group.ownerId, candidate)}
                        >
                          <span className="source-picker__item-label" style={LABEL_STYLE}>
                            {candidate.label}
                          </span>
                          {candidate.badge !== null ? (
                            <span className="script-card__output-id source-picker__item-id">
                              {candidate.badge}
                            </span>
                          ) : null}
                          {mark !== null ? (
                            <span
                              className={`chart-card__dock-badge source-picker__mark${
                                candidate.refused !== null ? ' source-picker__mark--refused' : ''
                              }`}
                            >
                              {mark}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {hidesFiles ? (
          <p className="context-menu__hint source-picker__hint">{labels.activeFileOnly}</p>
        ) : null}
      </div>
    </Popup>
  );
}

/**
 * The variable of ANOTHER port that already reads this matrix, or null.
 *
 * `otherPortId` is excluded because a re-bind's own current source is not "already bound" —
 * marking it would tell the user nothing and read as a collision with itself. Duplicates are
 * allowed on purpose (two variables may read one table), so this is a label, not a veto: the
 * row stays pickable, and the label says which variable it would double.
 */
function boundVarName(
  card: CardModel,
  ownerId: number,
  published: PublishedMatrix,
  otherPortId: string | undefined,
  portNames: readonly string[],
): string | null {
  if (!isFormulaCard(card)) return null;
  const index = card.inputs.findIndex(
    (input) =>
      input.portId !== otherPortId &&
      input.target.cardId === ownerId &&
      input.target.matrixId === published.matrixId,
  );
  if (index < 0) return null;
  return portNames[index] ?? card.inputs[index].portId;
}