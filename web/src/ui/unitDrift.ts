/**
 * Unit-drift detection for a file change or a workspace restore (units L1a §3).
 *
 * The question this answers is narrow on purpose: *did the derived unit of a same-name
 * column change or become contested, so that a strictly-configured workspace should say
 * something?* Nothing here decides what the user sees — the caller does that, and only when
 * `effectiveUnitPolicy` is `strict`.
 *
 * Why "same NAME" and not "same position": replacing a file keeps the table's identity (the
 * card is still showing that file), so column N is expected to still be the same quantity.
 * A rename is exactly the signal that the quantity moved, which is why the comparison is
 * keyed on the column's display label rather than its index.
 *
 * Deliberate limits, matching the resolver's own contract (never guess):
 *   - `unknown` → `unknown` is not drift. "No unit" twice is agreement, not a change.
 *   - A unit that only becomes `ambiguous` (e.g. `pressure_kpa` → `pressure_value_bar`?) IS
 *     reported: the previously known unit can no longer be supported by the header.
 *   - Columns present on only one side are not reported. A file that gained a column has
 *     not contradicted anything we said before.
 */
import { resolveConfirmed, resolveUnit, unitSignature, type UnitConfirmations } from '../core/units.ts';

/** One column, as the comparison needs it: its display label plus its resolution state. */
export interface DriftedColumn {
  /** The column's full display annotation — what the user reads in the header. */
  name: string;
  /** What the unit was / is, or `''` when the resolver said nothing (`unknown`). */
  unit: string;
  /** True when the resolver could not decide (`ambiguous`) — a conflict, never a value. */
  ambiguous: boolean;
}

/** One same-name column whose derived unit changed between two versions of a table. */
export interface UnitDrift {
  /** The quantity both versions describe — the header with the unit suffix removed. */
  stem: string;
  before: DriftedColumn;
  after: DriftedColumn;
}

/**
 * The comparison key of a column: its name with the unit suffix REMOVED.
 *
 * Keying on the whole annotation would make this module useless — `pressure_kpa` and
 * `pressure_bar` are different strings, so a unit change would be two unrelated columns and
 * never a drift. The question is "is this still the same quantity?", and the answer is the
 * header WITHOUT the unit: `pressure`.
 *
 * The removal is anchored on the resolution the resolver actually found (`span`), never on a
 * guessed pattern: the same token the unit was read from is the token that is cut out. When
 * the resolver found nothing (unknown/ambiguous with no span) only the bracket form and a
 * trailing `_token` are dropped, because those are also pure spelling of "the unit goes here".
 * A column without an annotation keeps its positional name, which the backend also uses.
 */
export function columnDriftKey(column: { posName: string; annotation: string }): string {
  const annotation = column.annotation.trim();
  if (annotation === '') return column.posName;
  const span = resolveUnit(annotation).span;
  if (span) return trimUnitSlot(annotation.slice(0, span.start)) || annotation;
  // Unknown/ambiguous without a span: a trailing bracket is still a unit slot (`压力 (MPa)`),
  // so it is cut too — otherwise two versions could never be paired on their quantity.
  const bracket = /\s*[(（[［【][^()（）[\]［］【】]*[)）\]］】]\s*$/.exec(annotation);
  if (bracket) return annotation.slice(0, bracket.index).trim() || annotation;
  return annotation;
}

function describe(column: { posName: string; annotation: string }, confirmed: string | undefined): DriftedColumn {
  const resolution = resolveConfirmed(column.annotation, confirmed);
  return {
    name: column.annotation.trim() !== '' ? column.annotation.trim() : column.posName,
    unit: resolution.state === 'recognized' ? resolution.unit : '',
    ambiguous: resolution.state === 'ambiguous',
  };
}

/**
 * Compare the derived units of two versions of one table, name by name.
 *
 * `before` / `after` are the column lists (in column order) of the old and the new table,
 * each with the confirmation memory that applied to it — the memory is passed separately
 * because it is keyed by signature, and two versions of a file normally have different
 * signatures.
 */
export function detectUnitDrift(
  before: { columns: ReadonlyArray<{ posName: string; annotation: string }>; confirmations: UnitConfirmations },
  after: { columns: ReadonlyArray<{ posName: string; annotation: string }>; confirmations: UnitConfirmations },
): UnitDrift[] {
  const beforeByKey = new Map<string, { column: { posName: string; annotation: string }; index: number }>();
  before.columns.forEach((column, index) => {
    const key = columnDriftKey(column);
    if (!beforeByKey.has(key)) beforeByKey.set(key, { column, index });
  });

  const drift: UnitDrift[] = [];
  const seen = new Set<string>();
  after.columns.forEach((column, index) => {
    const key = columnDriftKey(column);
    const previous = beforeByKey.get(key);
    if (!previous || seen.has(key)) return;
    seen.add(key);
    const old = describe(previous.column, confirmationFor(before.confirmations, before.columns, previous.index));
    const next = describe(column, confirmationFor(after.confirmations, after.columns, index));
    // Nothing changed AND nothing became contested: clean data stays silent.
    if (old.unit === next.unit && old.ambiguous === next.ambiguous) return;
    // A column that had no unit and still has none is agreement (`unknown` twice). Going
    // from `unknown` to `ambiguous` is still reported: the file now makes a claim we cannot
    // read, which is a conflict a strict workspace should hear about.
    if (old.unit === '' && next.unit === '' && !old.ambiguous && !next.ambiguous) return;
    drift.push({ stem: key, before: old, after: next });
  });
  return drift;
}

/** The remembered answer for one column of one table — the same rule `columnUnitResolutions` uses. */
function confirmationFor(
  confirmations: UnitConfirmations,
  columns: ReadonlyArray<{ posName: string; annotation: string }>,
  index: number,
): string | undefined {
  const signature = signatureOf(columns);
  return confirmations[signature]?.[index];
}

/**
 * Signature of a column list.
 *
 * Re-exported shape of `unitSignature` so this module has one dependency: the annotations
 * in order, which is exactly the key the confirmation memory is stored under.
 */
function signatureOf(columns: ReadonlyArray<{ posName: string; annotation: string }>): string {
  return unitSignature(columns.map((column) => column.annotation));
}

/** Remove the spelling that introduced a unit slot: `_`, whitespace, an opening bracket. */
function trimUnitSlot(stem: string): string {
  return stem.replace(/[_\s]+$/, '').replace(/[(（[［【]+$/, '').trim();
}
