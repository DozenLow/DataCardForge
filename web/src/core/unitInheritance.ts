/**
 * Units L2a — safe-whitelist unit inheritance (docs/tasks/2026-11-19-units-l2.md §L2a).
 *
 * A formula output has no unit of its own: its header is whatever the expression is named.
 * When the expression is PROVABLY unit-preserving over a single source column, the output
 * column carries that column's unit, and every consumer (chip, axis, convert card) reads it
 * through the ordinary resolution chain — no new wire channel, no number rewritten.
 *
 * Two hard rules keep this honest:
 *
 *   1. **Provable or nothing.** Only shapes whose unit algebra is trivial are inherited:
 *      the identity, scaling by a dimensionless number, and the single-column functions that
 *      are known to preserve the input's unit (`ABS`, `MOV`, `EMA`, … `CEIL`). Everything else —
 *      `SIGN`, `SQRT`, `POW`, `LOG`, `LN`, `LOG10`, `EXP`, `COUNT`, `NAN`, `VAR`, any two-column
 *      arithmetic, and any nesting of a non-whitelisted call — inherits NOTHING. A guess here
 *      would put a wrong unit on screen, which is worse than no unit at all.
 *   2. **Structure only.** The decision is read off the parser's AST; no value is evaluated, so
 *      inheritance cannot change a number even if the classifier were wrong (it would only
 *      mislabel). `expression.ts` stays the one parser — its evaluation semantics are untouched.
 *
 * The result is metadata: it is DERIVED (never persisted, never merged with a user's explicit
 * assertion) and it sits below the user's confirmation/assertion in the resolution chain
 * (`constants > confirmation > inherited > preconfirm > parse`).
 */

import { parseExpression, type ASTNode } from './expression.ts';
import { candidateByUnit, type UnitResolution } from './units.ts';

/**
 * Single-source-column functions that provably preserve the input column's unit.
 *
 * Deliberately absent (each of these changes the unit or is dimensionless by construction):
 *   - `SIGN` (dimensionless ratio), `COUNT`/`NAN` (counts), `VAR` (square of the unit);
 *   - `SQRT` (unit^½), `POW` (unit^b), `LOG`/`LN`/`LOG10`/`EXP` (transcendental, need a
 *     dimensionless argument and return one);
 *   - `IF` and multi-argument `MIN`/`MAX` (the result may come from a different column).
 *
 * `SUM/AVG/MEAN/MIN/MAX/MEDIAN/STD/SEM` reduce the column to a scalar and broadcast it, but
 * they are aggregations OF the same quantity, so the unit is unchanged. `QUANTILE` likewise.
 * `ROUND/FLOOR/CEIL` and `MOV/EMA` are filters of the same quantity. `ABS` preserves it.
 */
export const UNIT_PRESERVING_FUNCTIONS: ReadonlySet<string> = new Set([
  'ABS',
  'MOV',
  'EMA',
  'AVG',
  'MEAN',
  'MEDIAN',
  'MIN',
  'MAX',
  'SUM',
  'STD',
  'SEM',
  'QUANTILE',
  'ROUND',
  'FLOOR',
  'CEIL',
]);

/**
 * Where the inherited unit of an output column comes from, when one can be proven.
 *
 * `column` is the source column's index in the matrix the formula reads; `name` is the
 * spelling the formula used (for messages/titles). `unit` is the source column's canonical
 * unit as resolved by the ordinary chain.
 */
export interface InheritedUnit {
  readonly column: number;
  readonly name: string;
  readonly unit: string;
}

/** The unit a resolution states, or `''` when it states none. */
function declaredUnit(resolution: UnitResolution | undefined): string {
  return resolution && resolution.state === 'recognized' ? resolution.unit : '';
}

/**
 * The single source column an expression is provably a function of, or `null`.
 *
 * Walks the AST and answers "does the whole expression preserve this ONE column's unit?".
 * Anything the walk does not recognise as preserving returns `null` from the start — the
 * caller then inherits nothing.
 */
/**
 * The column a node stands for when its only operation is a sign flip: `col` or `-col`.
 *
 * Deliberately narrow — anything with a real operation (`col*2`, `ABS(col)`) is NOT a bare
 * column here, which is what keeps `col * ABS(col)` out of the preserving shapes.
 */
function bareColumn(node: ASTNode): { column: number; name: string } | null {
  if (node.kind === 'column') return { column: node.index, name: node.name };
  if (node.kind === 'unary' && node.op === '-' && node.operand.kind === 'column') {
    return { column: node.operand.index, name: node.operand.name };
  }
  return null;
}

function preservingColumn(node: ASTNode): { column: number; name: string } | null {
  switch (node.kind) {
    // A bare column is the identity: the result IS that quantity.
    case 'column':
      return { column: node.index, name: node.name };

    // `col * 2`, `2 * col`, `col / 2` — the numeric literal is dimensionless, so a single
    // multiplication/division by it rescales but never re-dimensions. Only the documented
    // shapes are accepted: `col + num`, `num / col` and `col * col` all change the unit
    // algebra (`num / col` inverts it, `col * col` squares it beyond prefix-rescaling).
    case 'binary': {
      // `-col` is still the same quantity (a scale by −1), so the operand is unwrapped
      // before the shape is judged: `-col * 2` is `col` scaled twice, not a second column.
      const operandLeft = bareColumn(node.left);
      const operandRight = bareColumn(node.right);
      if (node.op === '*') {
        if (operandLeft && node.right.kind === 'number') return operandLeft;
        if (operandRight && node.left.kind === 'number') return operandRight;
        return null;
      }
      if (node.op === '/') {
        if (operandLeft && node.right.kind === 'number') return operandLeft;
        return null;
      }
      return null;
    }

    // Unary minus is the dimensionless scaling by -1: it preserves the unit.
    case 'unary': {
      if (node.op !== '-') return null;
      return preservingColumn(node.operand);
    }

    case 'call': {
      if (!UNIT_PRESERVING_FUNCTIONS.has(node.name)) return null;
      const [first, ...rest] = node.args;
      if (!first) return null;
      // Every other argument must be a numeric literal: `MOV(col, 5)`'s window, `EMA(col,
      // 0.2)`'s alpha, `QUANTILE(col, 0.5)`'s q, `ROUND(col, 2)`'s digit count. A second
      // COLUMN or a nested expression would make the result depend on more than one quantity,
      // and `ROUND(col, d_col)` is not unit-preserving in any sentenceable sense either.
      for (const argument of rest) {
        if (argument.kind !== 'number') return null;
      }
      return preservingColumn(first);
    }

    // A literal alone is dimensionless; it has no source column to inherit.
    case 'number':
      return null;
  }
}

/**
 * The unit an output should INHERIT from its source table, or `null`.
 *
 * `sourceResolutions` is one `UnitResolution` per column of the table the formula reads,
 * already resolved through the ordinary chain (constants → confirmation → pre-confirmation →
 * parse). The referenced column must state exactly one unit: `ambiguous`, `unknown`, `'none'`
 * and non-scalar units (`°C`, `dB`, `AU` — no multiplicative algebra) inherit nothing.
 *
 * Never throws: an unparseable expression simply inherits nothing (the card already shows the
 * parser's own error elsewhere, and inheritance must not become a second error channel).
 */
export function inferInheritedUnit(
  expression: string,
  sourceResolutions: readonly UnitResolution[],
  columnNames?: readonly string[],
): InheritedUnit | null {
  if (sourceResolutions.length === 0) return null;
  const names =
    columnNames && columnNames.length === sourceResolutions.length
      ? [...columnNames]
      : sourceResolutions.map((_, index) => `Pos.${index + 1}`);

  let shape: { column: number; name: string } | null;
  try {
    shape = preservingColumn(parseExpression(expression, names));
  } catch {
    // An expression that does not parse has no unit to claim.
    return null;
  }
  if (!shape) return null;

  const resolution = sourceResolutions[shape.column];
  const unit = declaredUnit(resolution);
  if (!resolution || resolution.state !== 'recognized' || !resolution.scalar || unit === '') {
    return null;
  }
  // Same guard every other writer applies: only a registry unit is ever handed on.
  if (!candidateByUnit(unit)) return null;
  return { column: shape.column, name: shape.name, unit };
}

/**
 * Session-scoped derived memory: result column-unit signature → column index → inherited unit.
 *
 * Kept deliberately apart from `UnitConfirmations` (the USER's answers): this map is
 * recomputed from the formulas + the source table on every result pull, is never saved, and
 * never travels into a snapshot — so a stale derivation can never masquerade as an assertion.
 */
export type InheritedUnits = Readonly<Record<string, Readonly<Record<number, string>>>>;

/** True when `index` of `signature` inherited its unit (and can therefore be labelled 继承). */
export function inheritedUnitAt(
  inherited: InheritedUnits | undefined,
  signature: string,
  index: number,
): string | undefined {
  return inherited?.[signature]?.[index];
}