/**
 * Workspace store.
 *
 * Holds everything the Qt `MainWindow` + `CardRegistry` used to own: the set of
 * cards, their geometry and stacking order, the parsed matrices behind each matrix
 * card, the dependency graph, and the transient status line.
 *
 * Two invariants carry over from the C++ implementation:
 *   1. A matrix card whose matrix still has dependents cannot be closed
 *      (`DependencyGraph::hasDependents`) — the UI blinks the offending lines.
 *   2. Switching the active file inside a matrix card pushes fresh column data into
 *      every dependent chart; if the column no longer exists the line keeps its old
 *      data rather than disappearing.
 */
import { create } from 'zustand';
// The script card's rename rule is "rewrite IDENTIFIER nodes only" (strings and comments
// keep their text), which is a syntax-tree question, not a regex one. Parsing with the very
// grammar the editor highlights with is what keeps the preview and the edit in agreement.
import { parser as pythonParser } from '@lezer/python';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  canvasSize,
  getCanvasZoom,
  viewportRectInWorld,
} from './cardMetrics.ts';
import { DependencyGraph } from '../core/DependencyGraph.ts';
import { MatrixData } from '../core/MatrixData.ts';
import {
  NO_UNIT,
  candidateByUnit,
  normalizeUnitToken,
  resolveConfirmed,
  unitSignature,
  type UnitConfirmations,
  type UnitConstant,
  type UnitConstants,
  type UnitResolutionContext,
} from '../core/units.ts';
import { DEFAULT_SMOOTHING, type SmoothingOptions } from '../core/Smoothing.ts';
import { defaultChartConfig, type ChartConfig, type ChartSource } from '../charts/chartModel.ts';
import { chartTypeDef, minimumColumns, type ChartTypeId } from '../charts/chartTypes.ts';
import { lineColor } from '../charts/palette.ts';
// Backend-owned compute (docs/decisions/2026-10-17-backend-owns-compute.md): no numeric compute lives in
// the browser any more. `core/expression.ts` is NOT imported here — parsing, compiling and
// evaluating formulas are the backend's job; the frontend only ships formula *text*.
import {
  PINNED_WORKSPACE_ENV,
  PYTHON_SIGNATURE,
  cloneWorkspaceEnv,
  identityKey,
  isChartCard,
  isFormulaCard,
  isMatrixCard,
  isScriptCard,
  scriptParams,
  workspaceEnvIsPinned,
  workspaceEnvPackageVersion,
  type CardModel,
  type ChartCardModel,
  type FunctionCardModel,
  type MatrixCardModel,
  type MatrixEntry,
  type MatrixSnapshot,
  type FileIdentity,
  type NodeStatus,
  type OutputBinding,
  type PortConnection,
  type WorkspaceEnv,
  type WorkspaceSnapshot,
} from './types.ts';
import {
  CHART_PORT_X,
  EXPRESSION_COLUMNS_SIGNATURE,
  INPUT_PORT_SOURCE,
  REGRESSION_SIGNATURE,
  UNIT_CONVERT_SIGNATURE,
  chartPortId,
} from './migrate.ts';
import {
  SOURCE_PORT,
  portBindingsFor,
  REGRESSION_PORT_X,
  REGRESSION_PORT_Y,
} from './bindings.ts';
import { translatorFor, detectLocale, type Locale } from './i18n.ts';
import { initialTrust, scriptTrusted, type WorkspaceTrust } from './workspaceTrust.ts';
// Application-level settings (units L1a): the GLOBAL layer of the three scope layers. The
// store reads it live through `effectiveUnitPolicy` instead of copying it, so a settings
// change applies to the open workspace without a reload.
import { getGlobalSettings, type UnitPolicy } from './globalSettings.ts';
import { detectUnitDrift, type UnitDrift } from './unitDrift.ts';
// Type-only: the store owns *whether* the reference is open, the content module owns what
// is in it. Importing the type alone keeps the catalogue out of the store's runtime.
import type { HelpSection } from './formulaHelp.ts';
import {
  BackendClient,
  REQUIRED_CAPABILITIES,
  normalizeUnitWarnings,
  type DirtyReasonName,
  type NodeEvent,
  type NodeStateName,
  type SignatureDto,
} from '../backend/client.ts';

export { lineColor };

/**
 * Compute-backend availability. Unreachable is a VISIBLE state with a reason —
 * the UI renders a banner from this; nothing ever falls back to local compute silently.
 */
export interface BackendStatus {
  state: 'unknown' | 'online' | 'offline' | 'mismatch';
  build?: string;
  protocol?: number;
  /** Structured detail for the banner (code-style, not user prose). */
  error?: string;
}

/**
 * Statistic catalog of `builtin:summary`, in the backend's `summaryStatCatalog()` order
 * (`backend/src/signature.cpp`) — the order IS the output row order
 * (docs/decisions/2026-10-27-summary-builtin.md §一).
 *
 * The ids are stable identities: never renamed, never translated, never reordered. The
 * panel prints them verbatim as row labels because the transport has no row-label channel;
 * inventing Chinese names here would split row identity in two.
 */
export const SUMMARY_STATS = [
  'n',
  'nan',
  'mean',
  'sd',
  'var',
  'min',
  'q1',
  'median',
  'q3',
  'max',
  'iqr',
  'sem',
] as const;

export type SummaryStatId = (typeof SUMMARY_STATS)[number];

/** The signature behind the 摘要 panel. Published id — frozen, like every signature id. */
export const SUMMARY_SIGNATURE = 'builtin:summary';

/**
 * One entry of `params.targets` on a unit-conversion card.
 *
 * `from` is NOT optional here even though the wire contract makes it optional: the backend
 * re-parses the annotation when it is absent, and a column the user confirmed on the data
 * card (`current_a` → A) still parses `ambiguous` — only an explicit `from` carries that
 * confirmation across the card boundary (decision §四).
 */
export interface UnitConvertTarget {
  /** 0-based column index in the source table. */
  column: number;
  /** The derived (and possibly user-confirmed) source unit. Always sent. */
  from: string;
  /** Target unit; must share `from`'s dimension. */
  to: string;
}

/**
 * Session state of one unit-conversion card.
 *
 * Deliberately NOT on the card model: `targets` is on the card (it is the signature's
 * parameter and survives a save), while the lamp, the last error and the local clock are
 * observations of one compute on this machine — restoring them would present a stale run as
 * the current one. Same rule as the 摘要 panel's entry and the script card's run state.
 */
export interface UnitConvertRunState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** Structured error identity from the backend (i18n renders it; never server prose). */
  code: string | null;
  /** The backend's structured error params (`column`/`from`/`to`/`unit`/`token`/`name`). */
  params: Record<string, unknown> | null;
  /** When the last successful conversion finished (browser clock, labelled as such). */
  computedAt: number | null;
}

function emptyUnitConvertRun(): UnitConvertRunState {
  return { status: 'idle', code: null, params: null, computedAt: null };
}

/**
 * Is this card the unit-conversion card?
 *
 * A plain boolean, NOT a type predicate, on purpose: `isScriptCard` and `isFormulaCard` both
 * narrow to `FunctionCardModel`, so a third predicate over that same type collapses the
 * render dispatch's if/else chain into `never`. The card is a `FunctionCardModel` like every
 * function card, and each call site narrows with `isFormulaCard` first.
 */
export function isUnitConvertCard(card: CardModel): boolean {
  return card.kind === 'formula' && card.signatureId === UNIT_CONVERT_SIGNATURE;
}

/**
 * The `targets` parameter as the wire expects it.
 *
 * Reads the card rather than a component's draft, so the array that travels is exactly the
 * one the user can see on the card. Malformed entries (a hand-edited workspace file) are
 * dropped instead of being forwarded: the backend answers `badSignatureParams` for those,
 * and "an entry with no target" is the same thing the UI calls "keep as-is".
 */
export function unitConvertTargets(card: FunctionCardModel): UnitConvertTarget[] {
  const raw = card.params.targets;
  if (!Array.isArray(raw)) return [];
  const out: UnitConvertTarget[] = [];
  for (const entry of raw) {
    const record = entry as { column?: unknown; from?: unknown; to?: unknown };
    const column = typeof record?.column === 'number' ? record.column : null;
    const from = typeof record?.from === 'string' ? record.from : null;
    const to = typeof record?.to === 'string' ? record.to : null;
    if (column === null || from === null || to === null || from === '' || to === '') continue;
    out.push({ column, from, to });
  }
  return out;
}

/** One summary table exactly as the backend returned it. */
export interface SummaryResultTable {
  /** Column labels: the selected input variables, in the source table's column order. */
  columns: string[];
  /** Row identity, catalog order: row `r` ⇔ `stats[r]`. */
  stats: SummaryStatId[];
  /** `rows[r][c]` — one value per (statistic, variable). No arithmetic happens here. */
  rows: number[][];
}

/**
 * Session-only state of one card's 摘要 panel.
 *
 * Deliberately NOT a card-model field: adding one would bump the card schema
 * (docs/decisions/2026-10-26-card-schema-v2.md) plus migration plus fixtures for what is
 * pure view state. The node id lives here too (lifecycle plan A: created on the first
 * 计算), so nothing about the panel travels in the workspace snapshot.
 */
export interface SummaryPanelEntry {
  /** Whether the panel is expanded on this card (independent of the chart's column dock). */
  open: boolean;
  /** Chosen subset of the catalog: always canonical (catalog order) and never empty. */
  stats: SummaryStatId[];
  /** The ONE backend node behind this panel; `null` until the first 计算. */
  nodeId: number | null;
  /** Local matrix the node is bound to; a new source means a new binding. */
  boundMatrixId: number | null;
  /** `idle` = no node yet; otherwise the backend's own state name. */
  status: 'idle' | NodeStateName;
  /** Present while `status === 'dirty'`: the backend's reason for it. */
  reason?: DirtyReasonName;
  /** Structured error identity, present while `status === 'error'`. */
  code?: string;
  /** Local wall-clock time of the last successful compute (no protocol field exists). */
  computedAt: number | null;
  /** The cached table; dropped whenever the backend says the numbers are stale. */
  result: SummaryResultTable | null;
}

/**
 * Display label for a column: the file's annotation when present, otherwise `Pos.N`.
 * Shared by every place that materialises a `ChartSource`.
 */
function columnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? `${column.posName} ${column.annotation}` : column.posName;
}

/**
 * Minimum card footprint, in px.
 *
 * The height is not arbitrary: a chart card stacks a 31px toolbar, a 48px plot floor and a
 * footer that measures 65px at comfortable widths but **117px** once the chip and smoothing
 * rows wrap at the 280px minimum width, plus a 31px title bar and borders — 227px in the
 * worst case. At the old 180px the smoothing row landed 80px *below* the card edge with no
 * way to reach it; 240px leaves the plot ~59px in that worst case.
 */
export const MIN_CARD_WIDTH = 280;
export const MIN_CARD_HEIGHT = 240;

/** Deliberately coarse epsilon: float noise from drag/resize must not re-render. */
const GEOM_EPSILON = 0.01;

/** Keep a new card at least this far from the origin of the card plane. */
const CARD_MARGIN = 8;

/** Down-right step used while the preferred spot is taken. */
const CARD_CASCADE_STEP = 28;
const CARD_CASCADE_TRIES = 24;

/**
 * Place a new card near `preferred`, on the unbounded card plane.
 *
 * The previous version clamped into the *viewport*, which is precisely why a workflow
 * could never grow past one screenful: a chart opened from a table parked near the right
 * edge was folded back on top of its parent (and the Qt-era bug it guarded against —
 * a card created off-plane while the status bar announced success — is now impossible,
 * because the plane grows with the cards instead of ending at the window edge).
 *
 * A spot the user cannot see is *not* pulled back into view: folding a chart away from
 * the table it was opened from would stretch its connection line across the plane and
 * destroy the spatial story the canvas is telling. The view is moved instead (see
 * `revealView`), which is what "create something, then look at it" means everywhere else.
 * `occupied` lets the position cascade while it overlaps an existing card, so a burst of
 * new cards never stacks invisibly at one point.
 */
function placeOnPlane(
  preferred: { x: number; y: number },
  size: { width: number; height: number },
  occupied: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number } {
  let x = preferred.x;
  let y = preferred.y;

  const overlaps = (cx: number, cy: number) =>
    occupied.some(
      (c) =>
        cx < c.x + c.width + CARD_MARGIN &&
        cx + size.width + CARD_MARGIN > c.x &&
        cy < c.y + c.height + CARD_MARGIN &&
        cy + size.height + CARD_MARGIN > c.y,
    );

  for (let i = 0; i < CARD_CASCADE_TRIES && overlaps(x, y); i += 1) {
    x += CARD_CASCADE_STEP;
    y += CARD_CASCADE_STEP;
  }

  // The plane extends without bound right and down, but not into negative space: cards
  // are laid out from the origin and react-rnd's `bounds="parent"` keeps them there.
  return { x: Math.max(CARD_MARGIN, x), y: Math.max(CARD_MARGIN, y) };
}

/**
 * Where the view has to move for `bounds` to be fully visible, given the current pan.
 *
 * Panning rather than repositioning keeps new cards next to their parent — the whole
 * point of drawing connections at all. Returns `current` unchanged when the card is
 * already in sight, or when nothing can be measured (SSR, unit tests without a DOM).
 */
function revealView(
  bounds: { x: number; y: number; width: number; height: number },
  current: { x: number; y: number; zoom: number },
): { x: number; y: number; zoom: number } {
  const visible = viewportRectInWorld();
  if (visible.width <= 0 || visible.height <= 0) return current;

  const margin = 24;
  let dx = 0;
  let dy = 0;
  if (bounds.x < visible.left + margin) {
    dx = bounds.x - margin - visible.left;
  } else if (bounds.x + bounds.width > visible.left + visible.width - margin) {
    dx = bounds.x + bounds.width + margin - (visible.left + visible.width);
  }
  if (bounds.y < visible.top + margin) {
    dy = bounds.y - margin - visible.top;
  } else if (bounds.y + bounds.height > visible.top + visible.height - margin) {
    dy = bounds.y + bounds.height + margin - (visible.top + visible.height);
  }
  if (dx === 0 && dy === 0) return current;
  // The plane delta is in plane px; `view` is stored in screen px (the translate runs after
  // the scale), so it has to be multiplied by the zoom.
  return {
    x: Math.max(0, current.x + dx * current.zoom),
    y: Math.max(0, current.y + dy * current.zoom),
    zoom: current.zoom,
  };
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

/**
 * The policy tier that applies to THIS workspace (units L1a §1).
 *
 * Precedence is card > workspace > global per the decision §二; L1a implements the lower two
 * layers, so this is `workspace.unitPolicyOverride ?? global.unitPolicy`. The global tier is
 * read through `getGlobalSettings()` — the store never caches it, because the settings panel
 * (L1b) may change it while a workspace is open and a cached copy would win over the user.
 */
export function effectiveUnitPolicy(
  state: Pick<WorkspaceState, 'unitPolicyOverride'>,
): UnitPolicy {
  return state.unitPolicyOverride ?? getGlobalSettings().unitPolicy;
}

/**
 * The resolution context every unit consumer in this workspace must pass (units L1b §B2).
 *
 * Two layers, combined in the one direction the decision names (workspace > global):
 *   - `constants` — this workspace's manual definitions (`g → acceleration 9.80665`). They are
 *     workspace-private and travel with the snapshot; nothing here merges another workspace's.
 *   - `preconfirm` — the GLOBAL pre-confirmation, read live from the settings layer rather
 *     than copied into the store, so editing the 「单位」 dialog applies immediately.
 *
 * Derived at CALL time (never cached): a component that subscribes to `unitConstants` and
 * the settings re-derives its chips, axis and targets from the same chain.
 */
export function unitResolutionContext(
  state: Pick<WorkspaceState, 'unitConstants'>,
): UnitResolutionContext {
  return { constants: state.unitConstants, preconfirm: getGlobalSettings().unitPreconfirm };
}

/**
 * A pending re-point offer.
 *
 * v2 froze a function card's input to one explicit matrix, which means switching a table's
 * active file does NOT silently re-point it. That is the correct model, but it needs a
 * cheap path back: the store offers the switch as a **one-click, explicit** graph edit and
 * the card shows it as a pending banner. Nothing changes until the user confirms — the
 * difference from v1 is that the edit is announced instead of happening behind their back.
 */

// ── script card (`builtin:python`) ────────────────────────────────────────────────────
//
// The script card is ONE ordinary `FunctionCardModel` with `signatureId === 'builtin:python'`
// (docs/decisions/2026-11-15-python-script-card.md). Nothing below invents a second card
// model or a second graph: the ports are `inputs[]`, the outputs are `outputs[]`, the node is
// the card's one node. What is genuinely signature-specific — the DECLARATION (variable
// names, output identities), the two run modes and the rename rules — lives here, and only
// here, so the generic layer (DependencyGraph, rebuildDependencies, close protection,
// bindings, migrate, cardMetrics, connectionGeometry) stays signature-blind (decision §十).

/**
 * Environment stamp of the PINNED runtime.
 *
 * DERIVED from `PINNED_WORKSPACE_ENV` (types.ts) so the pinned toolchain exists exactly once
 * in the repo — the numbers come from `scripts/fetch-python-runtime.sh`. It is the fallback
 * for "this workspace carries no stamp of its own"; a loaded workspace's own block wins
 * (`workspaceEnv` below), because it describes the machine the file was saved on.
 */
export const PYTHON_RUNTIME_STAMP = {
  python: PINNED_WORKSPACE_ENV.python,
  numpy: workspaceEnvPackageVersion(PINNED_WORKSPACE_ENV, 'numpy'),
} as const;

/** Rows of each output the panel shows without opening the table. */
export const SCRIPT_PREVIEW_ROWS = 5;

/** One declared output's last read, keyed by `outputId` (never by position or name). */
export interface ScriptPreview {
  /** Rows the stored matrix holds; 0 while the node is dirty or errored (the id survives). */
  rows: number;
  cols: number;
  /** Column labels of the stored matrix (the backend's annotations). */
  columns: string[];
  /** First `SCRIPT_PREVIEW_ROWS` rows, row-major. */
  head: number[][];
}

/**
 * Session state of one script card's last run.
 *
 * Deliberately NOT on the card model: the card is persisted, and a traceback, a duration and
 * a set of previews are observations of one run on this machine — restoring them from a
 * save file would present a stale run as the current one. Same rule as the 摘要 panel's entry.
 */
export interface ScriptRunState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** Which button produced this state; `null` before the first run. */
  mode: 'clean' | 'debug' | null;
  previews: Record<string, ScriptPreview>;
  /** Wall clock of the last run (the "耗时" half of the environment stamp). */
  elapsedMs: number | null;
  /** When the last run finished (local clock, like the 摘要 panel's `computedAt`). */
  computedAt: number | null;
  /** Structured error identity from the backend (i18n renders it; never server prose). */
  code: string | null;
  /** The backend's structured error params — `stderr` carries the traceback verbatim. */
  params: Record<string, unknown> | null;
}

/** A fresh, never-run entry. */
export function emptyScriptRun(): ScriptRunState {
  return {
    status: 'idle',
    mode: null,
    previews: {},
    elapsedMs: null,
    computedAt: null,
    code: null,
    params: null,
  };
}

/** Which side of the card a variable name is declared on (they share one namespace). */
export type ScriptNamePanel = 'port' | 'output';

/** Outcome of a script rename: the card either changed, or said exactly why it did not. */
export type ScriptRenameResult =
  | { ok: true; warning: ScriptNameProblem | null; replaced: number }
  | { ok: false; error: ScriptNameProblem };

/**
 * Outcome of removing a declared output.
 *
 * `bound` carries the reading card ids so the panel can name them — "下游卡片 3 正在读它" is
 * actionable, "无法删除" is not. Both refusals are the store's existing protection
 * vocabulary (`blockCard` blink included), not a second mechanism.
 */
export type ScriptOutputRemoval =
  | { ok: true }
  | { ok: false; code: 'bound'; readers: number[] }
  | { ok: false; code: 'displayOutput' }
  | { ok: false; code: 'notFound' };

/**
 * Why a proposed variable name cannot be used, or what is merely suspicious about it.
 *
 * `duplicate` carries the panel the clash is on so the sentence can name the conflict
 * ("already the name of output `result`") instead of repeating itself.
 */
export type ScriptNameProblem =
  | { code: 'empty' }
  | { code: 'notIdentifier'; name: string }
  | { code: 'reserved'; name: string }
  | { code: 'duplicate'; panel: ScriptNamePanel; name: string }
  | { code: 'caseTwin'; name: string }
  | { code: 'keyword'; name: string }
  /** The card or the declared port/output the caller named does not exist. */
  | { code: 'notFound' };

export interface ScriptNameCheck {
  /** Blocking problem — the rename must not be applied. */
  error: ScriptNameProblem | null;
  /** Non-blocking finding: allowed, but the user is warned. */
  warning: ScriptNameProblem | null;
}

/** ASCII identifier rule the runner injects under (backend `isPythonIdentifier`). */
const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the runner owns: `A` also brings `names_a` / `shape_a`, and `meta` is its own. */
const RESERVED_NAME_PREFIXES = ['names_', 'shape_'] as const;
const RESERVED_NAMES = new Set(['meta']);

/**
 * Python keywords. The backend does not reject them, but a script cannot reference a name it
 * cannot spell (`result` is fine, `for` is not), so the UI warns instead of failing later.
 */
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
]);

/** Is `name` reserved by the runner's injected namespace? */
export function isReservedScriptName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Judge a proposed variable name against everything else the card declares.
 *
 * The rules are the decision's §二, in one place so the live preview, the store action and
 * the pre-flight run check can never disagree:
 *   - exact same name on the other panel → refuse (one namespace, two declarations);
 *   - same panel duplicate → refuse;
 *   - reserved (`names_*` / `shape_*` / `meta`) → refuse;
 *   - not an ASCII Python identifier → refuse;
 *   - `A` vs `a` and Python keywords → WARN, never refuse (they are legal, merely confusing).
 *
 * The caller passes the OTHER names of the card (the one being replaced excluded), so
 * re-typing the current name — or only changing its case — cannot collide with itself.
 */
export function checkScriptName(input: {
  name: string;
  panel: ScriptNamePanel;
  /** Every other port name on the card (this port excluded). */
  portNames: readonly string[];
  /** Every other output name on the card (this output excluded). */
  outputNames: readonly string[];
}): ScriptNameCheck {
  const name = input.name;
  if (name.length === 0) return { error: { code: 'empty' }, warning: null };
  if (!PYTHON_IDENTIFIER.test(name)) return { error: { code: 'notIdentifier', name }, warning: null };
  if (isReservedScriptName(name)) return { error: { code: 'reserved', name }, warning: null };

  const samePanel = input.panel === 'port' ? input.portNames : input.outputNames;
  const otherPanel = input.panel === 'port' ? input.outputNames : input.portNames;
  const otherPanelName: ScriptNamePanel = input.panel === 'port' ? 'output' : 'port';
  if (samePanel.includes(name)) return { error: { code: 'duplicate', panel: input.panel, name }, warning: null };
  if (otherPanel.includes(name)) {
    return { error: { code: 'duplicate', panel: otherPanelName, name }, warning: null };
  }

  // Legal but easy to misread. A warning, never a refusal: refusing `A` because `a` exists
  // would make the tool arbitrate a naming taste it cannot prove wrong.
  const twin = [...samePanel, ...otherPanel].find(
    (other) => other.toLowerCase() === name.toLowerCase(),
  );
  if (twin !== undefined) return { error: null, warning: { code: 'caseTwin', name: twin } };
  if (PYTHON_KEYWORDS.has(name)) return { error: null, warning: { code: 'keyword', name } };
  return { error: null, warning: null };
}

/**
 * Every IDENTIFIER occurrence of `name` in `script`.
 *
 * Only `VariableName` nodes count, which is exactly the rule the decision asks for: a
 * comment, a string literal or an attribute (`df.A`) is not a reference to the injected
 * variable, so renaming must leave all three alone. Positions come from the same grammar
 * CodeMirror highlights with, so "将替换 N 处" and the edit cannot drift apart.
 */
export function scriptOccurrences(script: string, name: string): Array<{ from: number; to: number }> {
  if (name.length === 0) return [];
  const found: Array<{ from: number; to: number }> = [];
  pythonParser.parse(script).iterate({
    enter(node) {
      if (node.name !== 'VariableName') return;
      if (script.slice(node.from, node.to) !== name) return;
      found.push({ from: node.from, to: node.to });
    },
  });
  return found;
}

/** How many identifier occurrences a rename of `name` would rewrite (the live preview). */
export function countScriptOccurrences(script: string, name: string): number {
  return scriptOccurrences(script, name).length;
}

/** Rewrite the identifier occurrences of `from` into `to`, leaving every other byte alone. */
export function renameInScript(script: string, from: string, to: string): string {
  if (from === to || from.length === 0) return script;
  const occurrences = scriptOccurrences(script, from);
  if (occurrences.length === 0) return script;
  let text = script;
  // Right to left, so earlier offsets stay valid while the text grows or shrinks.
  for (const occurrence of occurrences.reverse()) {
    text = text.slice(0, occurrence.from) + to + text.slice(occurrence.to);
  }
  return text;
}

/** `A`, `B`, … `Z`, then `A1`, `B1`, … — a birth-binding name, not a user-facing limit. */
export function scriptPortLetter(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  const round = Math.floor(index / 26);
  return round === 0 ? letter : `${letter}${round}`;
}

/** The first birth-binding name that nothing declares yet. */
export function nextScriptVarName(taken: readonly string[]): string {
  for (let index = 0; index < 26 * 10; index += 1) {
    const candidate = scriptPortLetter(index);
    if (!taken.includes(candidate)) return candidate;
  }
  return `P${taken.length + 1}`;
}

/**
 * The next free OUTPUT name: `result`, then `result2`, `result3`, …
 *
 * Outputs read as "results", so they get a word rather than a letter — a card whose ports are
 * already `A`, `B` must not grow an output called `C`, which reads like a third input.
 */
export function nextScriptOutputName(taken: readonly string[]): string {
  if (!taken.includes('result')) return 'result';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `result${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `out${taken.length + 1}`;
}

/**
 * Allocate one stable edge identity (`out:N` / `in:N`).
 *
 * Rules from the decision (fact A), in order of importance: an existing id is NEVER
 * renumbered when a row is removed, and a new id never collides with a surviving one. Beyond
 * that the id is `max(existing) + 1`, which may revisit the slot a removed row left behind —
 * safe precisely because a row that a dependent reads cannot be removed at all (the removal
 * guard refuses it), so no live edge can point at a name that is about to mean something
 * else. Holes are never filled while a survivor with a higher id exists, which keeps the
 * declaration's order readable.
 */
function nextOrdinalId(prefix: string, ids: readonly string[]): string {
  const pattern = new RegExp(`^${prefix}:(\\d+)$`);
  let max = -1;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}:${max + 1}`;
}

/** Next output identity of a script card (`out:N`). */
export function nextOutputId(outputs: readonly OutputBinding[]): string {
  return nextOrdinalId('out', outputs.map((output) => output.outputId));
}

/** Next input port identity of a script card (`in:N`). */
export function nextInputPortId(inputs: readonly PortConnection[]): string {
  return nextOrdinalId('in', inputs.map((input) => input.portId));
}

/**
 * Why the card's declaration cannot be sent to the backend, or `null` when it can.
 *
 * Mirrors `validatePythonParams` (backend/src/nodes.cpp) so a typo never becomes a red node
 * carrying a server-side `invalidParams`: unfilled/short `portNames`, a non-identifier or
 * duplicate port name, an empty or duplicated output declaration. The return value is the
 * FIELD NAME the backend would blame, which is also what the panel points at.
 */
export function scriptDeclarationError(card: FunctionCardModel): string | null {
  const { portNames, outputs } = scriptParams(card);
  if (portNames.length !== card.inputs.length) return 'portNames';
  const ports = new Set<string>();
  for (const name of portNames) {
    if (!PYTHON_IDENTIFIER.test(name)) return 'portNames';
    if (ports.has(name)) return 'portNames';
    ports.add(name);
  }
  if (outputs.length === 0) return 'outputs';
  const declared = new Set<string>();
  for (const name of outputs) {
    if (name.length === 0) return 'outputs';
    if (declared.has(name)) return 'outputs';
    declared.add(name);
  }
  return null;
}

/**
 * Script skeleton for a fresh card: a comment naming the ports, then one assignable output.
 *
 * It is a STARTING POINT that already satisfies the declaration (one output, assigned), so
 * the first 净室运行 either proves the plumbing or fails for a reason the user caused.
 */
function scriptTemplate(portNames: readonly string[]): string {
  const header = portNames.length === 0
    ? '# no input ports: the output still has to be a float64 matrix\n'
    : portNames
        .map(
          (name) =>
            `# ${name}: float64 matrix (column names in names_${name.toLowerCase()}, shape in shape_${name.toLowerCase()})\n`,
        )
        .join('');
  const expression = portNames.length === 0 ? 'np.zeros((1, 1))' : `${portNames[0]} * 1.0`;
  return `import numpy as np\n${header}\nresult = ${expression}\n`;
}

/**
 * The extra fields a `builtin:python` compute answer carries beyond the typed client.
 *
 * `extraOutputs` (declared outputs 1..K-1, each with its stored matrix id) and the error
 * `params` (whose `stderr` is the traceback the panel renders) are already on the wire —
 * `backend/src/http_server.cpp` sets both — but `BackendClient.computeNode`'s declared
 * return type names neither. Reading them through this local narrowing keeps the transport
 * module untouched; folding the two fields into `client.ts` is the follow-up, not a second
 * source of truth.
 */
interface ScriptComputeAnswer {
  extraOutputs?: Array<{ name: string; matrixId: number; rows: number; cols: number }>;
  params?: Record<string, unknown>;
}

/** Cards with a run on the wire: a second click must not spawn a second interpreter. */
const scriptRunsInFlight = new Set<number>();
/** Last declaration successfully pushed per card, so an identical re-push is a no-op. */
const lastPushedSignature = new Map<number, string>();
/** An automatic rerun was requested while a run was already in flight. */
const autoRunQueued = new Set<number>();

/** Patch one card's session run state (never persisted, never on the card model). */
function patchScriptRun(cardId: number, patch: Partial<ScriptRunState>): void {
  useWorkspace.setState((state) => ({
    scriptRuns: {
      ...state.scriptRuns,
      [cardId]: { ...(state.scriptRuns[cardId] ?? emptyScriptRun()), ...patch },
    },
  }));
}

/**
 * A definition edit: the card goes dirty/`definitionChanged` and NOTHING runs.
 *
 * Reuse, not a new mechanism: the backend's own `updateParams` does exactly this (`dirty` +
 * `DefinitionChanged`, nodes.cpp) and the PATCH the caller sends afterwards makes the two
 * agree. The local mirror just turns the lamp grey before the next event arrives.
 */
function markScriptDefinitionChanged(cardId: number): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) =>
      card.id === cardId && isFormulaCard(card)
        ? { ...card, node: card.node ? { nodeId: card.node.nodeId, state: 'dirty' } : null }
        : card,
    ),
    // The previews describe the previous declaration; the ids they came from stay valid.
    scriptRuns: state.scriptRuns[cardId]
      ? { ...state.scriptRuns, [cardId]: { ...state.scriptRuns[cardId], previews: {} } }
      : state.scriptRuns,
  }));
}

/**
 * Drop the numbers a failed or cancelled node no longer owns, keeping every id.
 *
 * Mirrors fact C: on `dirty`/`error`/cancel the backend zeroes the stored outputs while the
 * matrix ids survive. A stale table under a red lamp (or under a just-cleared declaration)
 * is the exact lie the backend already refuses to tell.
 */
function clearScriptResults(cardId: number): void {
  useWorkspace.setState((state) => {
    const card = state.cards.find((entry) => entry.id === cardId);
    if (!card || !isFormulaCard(card)) return {};
    const slots = [
      card.displayMatrixId,
      ...card.outputs
        .map((output) => output.localMatrixId)
        .filter((id): id is number => typeof id === 'number'),
    ];
    const matrices = new Map(state.matrices);
    let touched = false;
    for (const slot of slots) {
      if (!matrices.has(slot)) continue;
      matrices.set(slot, new MatrixData());
      touched = true;
    }
    const run = state.scriptRuns[cardId];
    return {
      ...(touched ? { matrices } : {}),
      cards: state.cards.map((entry) =>
        entry.id === cardId && isFormulaCard(entry) ? { ...entry, result: null } : entry,
      ),
      ...(run ? { scriptRuns: { ...state.scriptRuns, [cardId]: { ...run, previews: {} } } } : {}),
    };
  });
}

/**
 * Record the stored matrix behind every declared output.
 *
 * Output 0 comes from `resultMatrixIds[0]` (the display matrix, unchanged path); outputs
 * 1..K-1 come from `extraOutputs`, in declaration order. Only ids are written here — the
 * backend allocates them once and a run only fills them (decision §三).
 */
function applyScriptOutputIds(
  cardId: number,
  primaryIds: readonly number[],
  extras: ReadonlyArray<{ matrixId: number }>,
): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const outputs = card.outputs.map((output, index) => {
        if (index === 0) {
          return { ...output, resultMatrixId: primaryIds[0] ?? output.resultMatrixId };
        }
        const extra = extras[index - 1];
        return extra ? { ...output, resultMatrixId: extra.matrixId } : output;
      });
      return { ...card, outputs };
    }),
  }));
}

/** A fresh, empty preview (never shared: a panel may mutate what it owns). */
function emptyPreview(): ScriptPreview {
  return { rows: 0, cols: 0, columns: [], head: [] };
}

/** Read just the first rows of one stored output matrix (never the whole table). */
async function readScriptPreview(matrixId: number): Promise<ScriptPreview | null> {
  const frame = await backendClient.window(matrixId, 0, SCRIPT_PREVIEW_ROWS);
  if (!frame.ok) return null;
  const columns = frame.data ?? [];
  const rows = frame.rows ?? 0;
  const head: number[][] = [];
  for (let row = 0; row < Math.min(rows, SCRIPT_PREVIEW_ROWS); ++row) {
    head.push(columns.map((column) => column[row] ?? NaN));
  }
  return {
    rows: frame.totalRows ?? rows,
    cols: frame.totalCols ?? columns.length,
    columns: frame.names ?? [],
    head,
  };
}

/** Previews for every declared output, keyed by the identity a dependent would bind. */
async function collectScriptPreviews(cardId: number): Promise<Record<string, ScriptPreview>> {
  const card = useWorkspace.getState().cards.find((entry) => entry.id === cardId);
  if (!card || !isFormulaCard(card)) return {};
  const previews: Record<string, ScriptPreview> = {};
  for (const output of card.outputs) {
    previews[output.outputId] =
      output.resultMatrixId < 0
        ? emptyPreview()
        : (await readScriptPreview(output.resultMatrixId)) ?? emptyPreview();
  }
  return previews;
}

/** Is `card` still the card this run started for, in the workspace it started in? */
function scriptCardStillCurrent(cardId: number, epoch: number): boolean {
  return (
    workspaceEpoch === epoch &&
    useWorkspace.getState().cards.some((card) => card.id === cardId && isScriptCard(card))
  );
}

type ScriptNodeOutcome = { nodeId: number } | { aborted: true } | { code: string };

/**
 * Make sure the card has a node carrying the CURRENT declaration, and hand back its id.
 *
 * Creating the node is not running anything: `builtin:python` is an `explicitCompute`
 * signature, so the node is born `dirty` / `notRequested` (fact C). That is what lets a card
 * own a node from the moment it exists while nobody's code has executed.
 */
async function ensureScriptNode(
  card: FunctionCardModel,
  bindings: NonNullable<ReturnType<typeof portBindingsFor>>,
  epoch: number,
): Promise<ScriptNodeOutcome> {
  const params = wireParams(card);
  const existing = card.node;
  const result = existing && existing.nodeId > 0
    ? await backendClient.patchNode(existing.nodeId, { params, inputs: bindings })
    : await backendClient.createNode(bindings, { signatureId: card.signatureId, params });
  if (!result.ok) {
    if (result.code === 'backendUnavailable') {
      useWorkspace.setState({ backend: { state: 'offline', error: result.code } });
    } else {
      markNodeError(card.id, result.code ?? 'internalError', {});
    }
    return { code: result.code ?? 'internalError' };
  }
  const nodeId = result.nodeId!;
  if (!scriptCardStillCurrent(card.id, epoch)) {
    // The card (or the whole workspace) went away while the request was in flight; a node
    // nobody mirrors would leak server-side, so the newer intent wins.
    if (!existing) void backendClient.deleteNode(nodeId);
    return { aborted: true };
  }
  if (!existing) {
    applyNodeSnapshot(card.id, {
      nodeId,
      state: result.state ?? 'dirty',
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    });
    const ids =
      result.resultMatrixIds ?? (result.resultMatrixId !== undefined ? [result.resultMatrixId] : []);
    if (ids.length > 0) applyScriptOutputIds(card.id, ids, []);
  }
  return { nodeId };
}

/**
 * One run, clean or debug.
 *
 * Both modes go through the same backend call (v1 has no session kernel); what differs is
 * where the answer is allowed to land. 净室运行 publishes: display cache, `card.result`, and
 * therefore every dependent chart and chained card. 调试运行 keeps the answer inside this
 * card's panel — no display-cache write, no dependent refresh — so "debugging" can never
 * push half-finished numbers into the graph (decision §六, fixed on day one).
 */
async function runScriptCardNow(cardId: number, mode: 'clean' | 'debug'): Promise<void> {
  const state = useWorkspace.getState();
  const card = state.cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) return;
  // Nothing from an unconfirmed file executes, not even through a direct call. The button is
  // already gated; this is the same rule at the seam that actually spawns the interpreter.
  if (!scriptTrusted(state.trust, cardId)) {
    patchScriptRun(cardId, { status: 'idle', mode, code: 'untrusted', elapsedMs: null });
    return;
  }
  // One run per card at a time: two overlapping clicks would spawn two interpreters and
  // race their answers into the same panel.
  if (scriptRunsInFlight.has(cardId)) return;

  // Local pre-flight: the backend answers 400 `invalidParams` for a declaration it cannot
  // use, and a typo deserves the panel pointing at the field, not a red lamp.
  const declaration = scriptDeclarationError(card);
  if (declaration !== null) {
    patchScriptRun(cardId, {
      status: 'error',
      mode,
      code: 'invalidParams',
      params: { name: declaration },
      elapsedMs: null,
    });
    return;
  }

  scriptRunsInFlight.add(cardId);
  const epoch = workspaceEpoch;
  const startedAt = Date.now();
  patchScriptRun(cardId, { status: 'running', mode, code: null, params: null });
  try {
    const bindings = portBindingsFor(card, backendMatrixIdFor);
    if (!bindings) {
      // A source matrix has no server id yet (still uploading, or an upstream card with no
      // result). Nothing authoritative to bind to — say so instead of running on air.
      patchScriptRun(cardId, { status: 'idle', mode, code: 'upstreamPending', elapsedMs: null });
      return;
    }

    const node = await ensureScriptNode(card, bindings, epoch);
    if ('aborted' in node) return;
    if ('code' in node) {
      patchScriptRun(cardId, {
        status: 'error',
        mode,
        code: node.code,
        params: null,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    // The one trigger for an explicit-compute signature (the 摘要 panel's rule, reused).
    const computed = await backendClient.computeNode(node.nodeId);
    if (!scriptCardStillCurrent(cardId, epoch)) return;
    const answer = computed as typeof computed & ScriptComputeAnswer;
    const elapsedMs = Date.now() - startedAt;

    if (!computed.ok) {
      if (computed.code === 'backendUnavailable') {
        useWorkspace.setState({ backend: { state: 'offline', error: computed.code } });
      }
      patchScriptRun(cardId, {
        status: 'error',
        mode,
        code: computed.code ?? 'internalError',
        params: null,
        elapsedMs,
      });
      return;
    }

    if (computed.state === 'error') {
      const code = computed.code ?? 'internalError';
      markNodeError(cardId, code, answer.params ?? {});
      clearScriptResults(cardId);
      patchScriptRun(cardId, {
        status: 'error',
        mode,
        code,
        params: answer.params ?? {},
        elapsedMs,
        computedAt: Date.now(),
      });
      return;
    }

    if (computed.state !== 'done') {
      // Cancelled (`/cancel`) or declined: the node went back to "not computed yet", which
      // is not a failure — no red lamp (fact C: 取消≠失败).
      applyNodeSnapshot(cardId, { nodeId: node.nodeId, state: computed.state ?? 'dirty' });
      clearScriptResults(cardId);
      patchScriptRun(cardId, { status: 'idle', mode, code: null, params: null, elapsedMs });
      return;
    }

    applyNodeSnapshot(cardId, {
      nodeId: node.nodeId,
      state: 'done',
      ...(computed.warnings !== undefined ? { warnings: computed.warnings } : {}),
    });
    applyScriptOutputIds(
      cardId,
      computed.resultMatrixIds ?? [],
      answer.extraOutputs ?? [],
    );
    const previews = await collectScriptPreviews(cardId);
    if (!scriptCardStillCurrent(cardId, epoch)) return;
    // A clean run publishes: pull the result into the display cache BEFORE reporting done.
    // The run bar's light, the card badge and every dependent read this cache, so a `done`
    // reported while the numbers are still in flight is exactly the reported "green light
    // before it finished". Debug deliberately does not publish, so it skips this.
    if (mode === 'clean') await pullResultIntoCache(cardId);
    if (!scriptCardStillCurrent(cardId, epoch)) return;
    patchScriptRun(cardId, {
      status: 'done',
      mode,
      code: null,
      params: null,
      elapsedMs,
      computedAt: Date.now(),
      previews,
    });
    if (mode === 'clean') {
      // A successful clean run is the user's consent for automatic reruns. `undefined` only:
      // an explicit "off" must survive the next manual run, otherwise the toggle would be
      // decorative.
      if (card.autoRun === undefined) {
        useWorkspace.setState((state) => ({
          cards: state.cards.map((entry) =>
            entry.id === cardId && isFormulaCard(entry) ? { ...entry, autoRun: true } : entry,
          ),
        }));
      }
      // The ordinary result-cache path: display matrix + `card.result` + every dependent
      // refreshed. Debug deliberately skips this whole line.
      await pullResultIntoCache(cardId);
    }
  } finally {
    scriptRunsInFlight.delete(cardId);
  }
}

/**
 * Automatic rerun of an armed script card.
 *
 * The trigger is exactly the signal a formula card gets from the backend: a dirty node. That
 * one condition covers a definition PATCH, an input rebind, an upstream change (the backend
 * marks the node stale and pushes the event) and a restored workspace (the node is created
 * dirty). There is deliberately no timer here: the 200 ms settle belongs to the user's edit,
 * and once it fired the graph must advance immediately — an automatic rerun must not add a
 * second wait of its own.
 */
function maybeAutoRunScript(cardId: number, retrigger = false): void {
  const state = useWorkspace.getState();
  const card = state.cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) return;
  // `true` only: never-armed (`undefined`) waits for the first manual run, and an explicit
  // "off" stays off even across later manual runs.
  if (card.autoRun !== true) return;
  if (state.propagationFrozen) return;
  // The same permission gates the run path enforces, checked before anything is scheduled.
  if (!scriptTrusted(state.trust, cardId)) return;
  if (!workspaceEnvIsPinned(state.workspaceEnv)) return;
  const previous = state.scriptRuns[cardId];
  if (previous && previous.code === 'runtimeMissing') return;
  if (scriptRunsInFlight.has(cardId)) {
    // A run is already under way; remember that another change landed so completion runs
    // again instead of silently dropping it.
    autoRunQueued.add(cardId);
    return;
  }
  if (!card.node) return;
  // A normal trigger only fires on a dirty node. A RETRIGGER is different: a change arrived
  // while the previous run was computing, and that run ends by writing `done` — the node is
  // no longer dirty even though the change may postdate the numbers it computed (a heavy
  // script is exactly when a user swaps the input). Gating the retrigger on `dirty` would
  // silently lose the swap, so it runs once regardless; the queued flag is cleared, so this
  // cannot loop.
  if (!retrigger && card.node.state !== 'dirty') return;
  void runScriptCardNow(cardId, 'clean').finally(() => {
    if (autoRunQueued.delete(cardId)) maybeAutoRunScript(cardId, true);
  });
}

/**
 * Ask every armed script card with a waiting node to catch up.
 *
 * Automatic reruns are gated (workspace trust, environment, blockers), and a trigger that
 * arrives while a gate is shut is *dropped*, not queued — that is what froze propagation in
 * the first place. Reopening a file is exactly such a case: the restore pushes its nodes
 * (dirty) before the trust answer exists, so without this replay an armed card of a
 * file-backed workspace would silently never rerun again. Called whenever a gate opens.
 */
function resumeAutoRuns(): void {
  const state = useWorkspace.getState();
  for (const card of state.cards) {
    if (!isScriptCard(card) || card.autoRun !== true) continue;
    if (!card.node || card.node.state !== 'dirty') continue;
    maybeAutoRunScript(card.id);
  }
}

/**
 * Blocking conditions (2026-11-17): an environment/structure problem that makes the graph
 * unable to advance. A COMPUTE error is deliberately NOT one of these — a syntax mistake in
 * one card must not freeze the workspace; it stays a red card with a diagnostics panel.
 */
export type BlockerKind =
  | 'envMismatch'
  | 'runtimeMissing'
  | 'backendOffline'
  | 'backendMismatch'
  | 'cycle'
  | 'columnContract';

export interface Blocker {
  kind: BlockerKind;
  /** Node-level blockers carry the card; environment/backend ones do not (no red outline). */
  cardId?: number;
  /** Backend error code or transport detail, for the modal's second line. */
  detail?: string;
}

interface WorkspaceState {
  cards: CardModel[];
  /** Parsed matrices by id. Kept outside the cards so charts can share them. */
  matrices: Map<number, MatrixData>;
  /**
   * Byte identity (`size:lastModified`) -> matrix id, so re-opening the *same bytes*
   * reuses a parse. Keyed on content, never on file name: two different files routinely
   * share a name (`export.csv` overwritten daily), and returning the older parse for the
   * newer bytes would silently plot stale measurements.
   */
  matrixIdByIdentity: Map<string, number>;
  selectedId: number | null;
  dependencies: DependencyGraph;
  /** Card that should blink because a close was blocked. */
  blockedCardId: number | null;
  /**
   * Increments on every refused close. The blink animation keys off this so that
   * blocking the same card twice in a row restarts the flash.
   */
  blockNonce: number;
  toast: Toast | null;
  locale: Locale;
  /**
   * The environment stamp this workspace was saved against.
   *
   * Loaded verbatim from the file and written back unchanged: a workspace saved on another
   * machine must keep saying so. `workspaceEnvIsPinned` is what turns the difference into
   * the global banner — this field is never "fixed up" on load, because a mismatch is
   * information, not a defect to hide.
   */
  workspaceEnv: WorkspaceEnv;
  /**
   * True once the user pressed 「以当前环境重算」 on the mismatch banner.
   *
   * Session state on purpose: it closes the banner for THIS load only. Neither value runs,
   * rewrites the stamp, nor blocks a manual run — the scripts were never going to run by
   * themselves.
   */
  envMismatchAcknowledged: boolean;
  /**
   * One-time notice after loading a workspace that contains user scripts.
   *
   * How many script cards the loaded file holds, or `null` when there are none / the notice
   * was dismissed. Deliberately a COUNT for the whole workspace rather than a per-card flag:
   * "N 段用户脚本，首次成功后才自动重跑" is one sentence, once, and nothing is executed to
   * produce it.
   */
  scriptNotice: number | null;
  nextCardId: number;
  nextMatrixId: number;
  /**
   * View of the infinite canvas: pan in **screen** px plus a zoom factor. The world layer
   * is drawn at `translate(-view.x, -view.y) scale(view.zoom)` — pan is applied *after*
   * the scale, which is why it stays in screen px while every card coordinate is in plane
   * px. The plane itself is unbounded (it grows with the cards), so this is the only piece
   * of view state that has to be remembered; clamping against the plane/viewport sizes
   * happens in `CardCanvas`, the only place that can measure them.
   */
  view: { x: number; y: number; zoom: number };

  // ── card lifecycle ──────────────────────────────────────────────────
  addMatrixCard: (
    entries: Array<{ name: string; matrix: MatrixData; identity?: FileIdentity }>,
  ) => number;
  /**
   * Replace a data card's file(s) without touching the card itself.
   *
   * `index` replaces ONE source slot — the card's「替换文件…」control, which always acts on
   * the active file. Omitted, the entries become the card's whole file set (a drop).
   *
   * This is a DATA change, not a view change (`setActiveSource` is the view change, and the
   * two must not be conflated). Charts are views and follow the new numbers. Function cards
   * are frozen to explicit matrices (v2), so their input is rewritten to the corresponding
   * new matrix of the same card in the same step: "this table now holds these numbers" is
   * exactly what the user asked for, and the cell-edit cascade (PATCH → recompute) is the
   * precedent — the column contract still stops a shape drift with a visible error.
   *
   * Returns false for a non-data card or invalid arguments; a partial parse must be
   * aborted by the caller, never applied here.
   */
  replaceCardSources: (cardId: number, entries: MatrixEntry[], index?: number) => boolean;
  /**
   * Draw a chart from one column of `matrixCardId`.
   *
   * `outputId` picks which declared output the chart reads (`out:1`, …). Omitted, the
   * long-standing default applies: a data card's active file, or a function card's display
   * output. A data card declares no outputs, so naming one there is refused.
   */
  addChartCard: (
    matrixCardId: number,
    columnIndex: number,
    chartType?: ChartTypeId,
    outputId?: string,
  ) => number | null;
  removeCard: (id: number) => boolean;
  closeAllCards: () => void;
  setBounds: (id: number, bounds: { x: number; y: number; width: number; height: number }) => void;
  bringToFront: (id: number) => void;
  select: (id: number | null) => void;
  /** Move the canvas view by a screen-px delta (already clamped by the caller). */
  panBy: (dx: number, dy: number) => void;
  setView: (view: { x: number; y: number; zoom: number }) => void;
  /** Frame every card again — the escape hatch after panning off into empty space. */
  resetView: () => void;

  // ── matrix card behaviour ───────────────────────────────────────────
  setActiveSource: (cardId: number, index: number) => void;
  /** Edit a single cell in the active matrix of a matrix card. */
  editCell: (cardId: number, row: number, col: number, value: number) => void;
  /** Mark a matrix card as editable (non-file-backed cards). */
  setEditable: (cardId: number, editable: boolean) => void;

  // ── chart card behaviour ────────────────────────────────────────────
  setSmoothing: (cardId: number, options: SmoothingOptions) => void;
  /** Change the chart type, growing the source list if the new type needs more columns. */
  setChartType: (cardId: number, type: ChartTypeId) => void;
  /** Patch presentation options (log axis, dual axis, fit line, bins, …). */
  setChartConfig: (cardId: number, patch: Partial<ChartConfig>) => void;
  addChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;
  removeChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;
  /** Persist the column-dock open state on a chart card. */
  setChartColumnPanel: (cardId: number, open: boolean) => void;
  /**
   * Expand/collapse one declaration column of a function card.
   *
   * Presentation only: nothing is pushed to the backend and no edge changes. The collapsed
   * rail still renders the card's ports, which is what keeps the wires anchored on the port
   * (see docs/decisions/2026-11-17-port-anchored-connections.md).
   */
  setFunctionPanelOpen: (cardId: number, panel: 'inputs' | 'outputs', open: boolean) => void;
  /** Arm / disarm the automatic rerun of a script card (tri-state, see `FunctionCardModel`). */
  setScriptAutoRun: (cardId: number, on: boolean) => void;
  /**
   * Automatic execution is suspended while a blocking problem is open (Phase D fills this):
   * a blocked workspace keeps every result and lets manual actions through, but nothing new
   * runs on its own.
   */
  propagationFrozen: boolean;
  /** Currently open blocking conditions; empty means propagation may run. */
  blockers: Blocker[];
  /**
   * Workspace trust (2026-11-17): which scripts of the opened FILE may execute.
   *
   * The hash of the file's bytes is the key; the backend owns the record, the client owns the
   * session's confirmations. `beginWorkspaceTrust` is called once, right after a file is
   * restored; a workspace with no file stays `hash: null` and every script is the user's own.
   */
  trust: WorkspaceTrust;
  beginWorkspaceTrust: (hash: string, restoredScriptIds: number[]) => void;
  /**
   * The workspace was just saved: its new bytes are the user's own file, so every script in
   * it is trusted under the new hash. Session state follows, so the UI stops asking about a
   * workspace the user just wrote.
   */
  recordSavedWorkspace: (hash: string, scriptIds: number[]) => void;
  /** Answer the first-run question; a failed persist falls back to session-only. */
  setTrustPersistence: (persist: boolean) => void;
  confirmTrustedScript: (cardId: number) => void;
  /** The bulk action the UI only offers after the user confirmed three scripts by hand. */
  confirmAllTrustedScripts: () => void;
  revokeWorkspaceTrust: () => void;

  // ── function card behaviour ─────────────────────────────────────────
  /**
   * Create a function card reading ONE explicit matrix of `sourceCardId`.
   * Without `matrixId` the card's currently active file is captured — the reference is
   * frozen from this moment on (switching the table's file no longer re-points it).
   */
  addFormulaCard: (sourceCardId: number, matrixId?: number) => number | null;
  /**
   * Create a relation-enumeration card from two columns of the source's current table.
   *
   * Backed by `builtin:linear-regression` (the published signature id never changes; only
   * the human-facing name did). The second signature exists to prove the card model is not
   * expression-shaped: two declared ports (x, y), no formula parameters, an output whose
   * shape the signature fixes. It binds one COLUMN per port (`mode: 'cell'`), which is why
   * the cell port mode had to become real.
   *
   * The clicked column becomes `x` and its neighbour `y` (the previous one when the clicked
   * column is last) — a starting pair, not a restriction: both ports can be re-bound from
   * the card (`setPortColumn`), which is the "choose the columns" affordance the card was
   * missing when the pair was hard-wired at creation.
   */
  addRelationEnumCard: (sourceCardId: number, columnIndex: number) => number | null;
  /**
   * Re-bind ONE cell port of a function card to another column of the same matrix.
   *
   * Column choice is a BINDING, not a parameter: the parameter belongs to the signature
   * (`params` is empty for this signature), while "which column feeds port x" is data flow.
   * Same node, same dependency edge — only `columnIndex` changes, then one push re-computes.
   */
  setPortColumn: (cardId: number, portId: string, columnIndex: number) => void;
  /** Add or update a formula column. One node ⇒ one PATCH, whatever the column count. */
  setFormula: (cardId: number, index: number, name: string, expression: string) => void;
  /** Remove a formula column (keeps at least one; no node is created or deleted). */
  removeFormula: (cardId: number, index: number) => void;
  /** Re-send a function card's parameters + bindings to the backend. */
  recomputeFormula: (cardId: number) => void;
  /**
   * Pull the WHOLE result of a function card into the display cache ("show more").
   *
   * The card mirrors only `RESULT_PREVIEW_ROWS` rows after a compute; this is the explicit
   * user action that pays for the rest of a tall table.
   */
  loadFullResult: (cardId: number) => void;
  /**
   * Push a card's current matrices into every chart that reads them.
   *
   * Called when a data card switches files (charts re-point at the new file) and when a
   * function card's output arrives (charts re-read the new numbers).
   */
  refreshDependentsOf: (cardId: number) => void;
  /**
   * Pending offers to re-point a function card at the newly active file of its data card.
   * Rebuilt whenever a table switches files; empty once the user applies or dismisses.
   */
  /** Apply one offer: an explicit, undoable graph edit (re-pointing back is another edit). */
  /** Apply every offer that reads the same data card (batch confirm). */
  /** Keep the current input; the offer disappears until the next file switch. */
  /**
   * Name one output column. The first rename also creates the column contract: from then
   * on the output's width is promised, and a drift stops the flow (structured error).
   */
  renameOutputColumn: (cardId: number, index: number, name: string) => void;
  /** Extend/shrink the contract (the explicit way out of a self-edit violation). */
  setColumnContract: (cardId: number, columns: number | null) => void;

  // ── column units v1 (derived metadata; see decisions/2026-11-18-units-v1.md) ─────────
  /**
   * Confirmation memory, keyed by column-unit signature then column index. Persisted as an
   * optional snapshot field so identical headers are asked only once. The matrix itself
   * stores no unit — resolution is always `annotation + this memory`, derived at read time.
   */
  unitConfirmations: UnitConfirmations;
  /**
   * Confirm one ambiguous token for EVERY column of a matrix that carries it (group-level).
   * Returns the number of columns affected. The caller shows the affected-column list before
   * invoking this, so a batch is always visible; a recognised column is never re-asked.
   */
  confirmUnitGroup: (matrixId: number, token: string, unit: string) => number;
  /** Override or clear ONE column's unit (`NO_UNIT` clears). Writes the same signature memory. */
  setColumnUnit: (matrixId: number, columnIndex: number, unit: string) => void;
  /**
   * Workspace-level policy override (units L1a §1). `null`/`undefined` = inherit the global
   * tier; the value travels in the snapshot so a reopened workspace keeps its own answer.
   * Card-level overrides are a later slice and are deliberately absent here.
   */
  unitPolicyOverride?: UnitPolicy;
  /** Set or clear this workspace's policy override (persisted with the snapshot). */
  setUnitPolicyOverride: (policy: UnitPolicy | null) => void;
  /**
   * Manual unit constants of THIS workspace (units L1b §B2): header token → dimension/factor.
   *
   * The workspace-private half of the resolution chain (`g → {acceleration, 9.80665}`). They
   * travel in the snapshot and are never merged with another workspace's (nesting rule of the
   * decision §五), and they only ever EXTEND the reading of a header — no number is rewritten.
   */
  unitConstants: UnitConstants;
  /**
   * Define (or redefine) one manual constant. An unusable definition (empty token, empty
   * dimension, non-positive factor) is refused and the previous value is kept.
   */
  addUnitConstant: (token: string, constant: UnitConstant) => boolean;
  /** Remove one manual constant. Removing an absent token is a no-op. */
  removeUnitConstant: (token: string) => void;
  /**
   * Explicit OUTPUT unit of one formula column (units L1a §2).
   *
   * Stored in `params.formulas[i].unit` and re-asserted into the confirmation memory
   * after every result pull; `''` clears the assertion. Never a transform.
   */
  setFormulaUnit: (cardId: number, index: number, unit: string) => void;

  // ── summary panel (`builtin:summary`; session-only, plan A lazy node) ─
  /**
   * Per-card 摘要 state, keyed by card id. Never persisted and never on the card model:
   * the panel's open state, its statistic filter and its node id are all session state.
   */
  summaries: Record<number, SummaryPanelEntry>;
  /** Expand/collapse one card's 摘要 bar (its own state, not the column dock's). */
  setSummaryOpen: (cardId: number, open: boolean) => void;
  /**
   * Toggle one catalog id in the panel's filter.
   *
   * `params.stats` is a FILTER, never a reordering: the subset is re-canonicalised to
   * catalog order, an empty selection is refused (the backend answers `stats: []` with
   * `badSignatureParams`) and an existing node is told about the change with one PATCH,
   * which is what turns the panel into 待重算 / 参数已改.
   */
  toggleSummaryStat: (cardId: number, stat: SummaryStatId) => void;
  /**
   * The ONE trigger for `builtin:summary`: create this card's node on the first call,
   * then `POST /api/nodes/{id}/compute` and pull the result table from the backend.
   * There is no second entry point and no local arithmetic.
   */
  computeSummary: (cardId: number) => void;

  // ── unit conversion card (`builtin:unit-convert`; units v1 P2) ──────
  /**
   * Per-card conversion state, keyed by card id. Never persisted and never on the card
   * model (see `UnitConvertRunState`).
   */
  unitRuns: Record<number, UnitConvertRunState>;
  /**
   * Create a unit-conversion card from a source card.
   *
   * Modelled on `addRelationEnumCard`: ONE `src` matrix port, `outputs:[{outputId:'result'}]`,
   * `params:{targets:[]}`, a FRESH (empty) display cache and one dependency edge. Nothing is
   * converted here — the signature is `explicitCompute`, so the node is born
   * dirty/`notRequested` and only `convertUnits` asks for numbers.
   */
  addUnitConvertCard: (sourceCardId: number, matrixId?: number) => number | null;
  /**
   * The ONE trigger for `builtin:unit-convert`: store the targets, sync the node,
   * `POST /api/nodes/{id}/compute`, then pull the result table into the display cache.
   *
   * Explicit only. An upstream change marks the card stale (the backend's own event) and
   * never re-runs the conversion, because the numbers on screen must not change without the
   * user asking (decision §四).
   */
  convertUnits: (cardId: number, targets: readonly UnitConvertTarget[]) => void;

  // ── script card (`builtin:python`) ──────────────────────────────────
  /**
   * Per-card run state, keyed by card id. Never persisted and never on the card model: a
   * traceback and a duration describe ONE run on THIS machine.
   */
  scriptRuns: Record<number, ScriptRunState>;
  /**
   * Birth binding: create a script card reading the selected cards, in the given order.
   *
   * One port per selected source (`in:0`, `in:1`, … with injected names `A`, `B`, …), all in
   * matrix mode, wired through the ordinary `addDependency` — a script card's inputs are
   * edges like any other card's, so close protection and cycle detection come for free.
   * Data cards contribute their active file; function cards contribute their output, or the
   * output named by `outputId`.
   * Returns null when nothing selected can be read (a chart, an empty formula card) or the
   * edge would close a cycle.
   */
  addScriptCard: (seeds: Array<number | { cardId: number; outputId?: string }>) => number | null;
  /** Edit the script text. A definition change: the card goes dirty, the DAG is untouched. */
  setScriptText: (cardId: number, script: string) => void;
  /**
   * Rename one input port's injected variable (`A` → `x`).
   *
   * Rewrites the identifier occurrences in the script, `params.portNames[index]` and the
   * binding's `varName` — never the `in:N` portId, so the edge, the selection and the
   * dependency graph are all untouched.
   */
  renameScriptPort: (cardId: number, portId: string, varName: string) => ScriptRenameResult;
  /**
   * Rename one declared output (`result` → `residual`).
   *
   * Rewrites the script, `params.outputs[ordinal]` and therefore the label every dependent
   * shows; the edge keeps binding `out:N`, which never changes.
   */
  renameScriptOutput: (cardId: number, outputId: string, name: string) => ScriptRenameResult;
  /**
   * Declare one more output: `params.outputs` and `outputs[]` grow together, and the new
   * `out:N` exists (and is bindable) from this moment — the run only fills it.
   */
  addScriptOutput: (cardId: number) => string | null;
  /**
   * Remove one declared output.
   *
   * Refused while a dependent reads it (`code: 'bound'`) and while it is the card's display
   * output (`code: 'displayOutput'` — output 0 is what every existing chart and chained card
   * points at). A refusal reuses the existing blink (`blockCard`), never a new mechanism.
   */
  removeScriptOutput: (cardId: number, outputId: string) => ScriptOutputRemoval;
  /**
   * Declare one more input port, bound to the same source as the card's first port.
   *
   * v1 has no source picker inside the card (picking a NEW source is a canvas gesture that
   * already exists for every other card kind), so "+ 端口" grows the declaration on the
   * source the card already reads. Returns the new portId, or null when there is nothing to
   * bind to.
   */
  addScriptPort: (cardId: number) => string | null;
  /**
   * 净室运行: sync the declaration to the node, `POST .../compute`, then publish the result
   * into the display cache and the DAG (charts and chained cards follow).
   */
  runScriptCard: (cardId: number) => void;
  /**
   * 调试运行: the same backend call, but the result only reaches this card's panel.
   *
   * v1 runs the clean-room path (a session kernel is phase 1's next stage); the SEMANTIC
   * difference is already fixed: no display-cache write, no dependent refresh, so a debug run
   * can never leak half-finished numbers into the graph.
   */
  debugScriptCard: (cardId: number) => void;

  // ── view helpers ────────────────────────────────────────────────────
  tileCards: (viewportWidth: number, viewportHeight: number) => void;
  cascadeCards: () => void;

  // ── help dialog (帮助) ───────────────────────────────────────────────
  /**
   * The formula / function reference is a modal the app owns, not a card.
   *
   * It is reachable from two unrelated places — the top-left Help menu and the formula
   * card's `?` button — and the card gets no props from `CardCanvas` for it. Two openers,
   * one piece of state: that is what the store is for.
   */
  helpOpen: boolean;
  /** Section the opener asked the dialog to scroll to; `null` means "open at the top". */
  helpSection: HelpSection | null;
  openHelp: (section?: HelpSection) => void;
  closeHelp: () => void;

  // ── misc ────────────────────────────────────────────────────────────
  setLocale: (locale: Locale) => void;
  /** Flag a card as "cannot close", restarting the connection blink. */
  blockCard: (id: number) => void;
  showToast: (kind: Toast['kind'], message: string) => void;
  clearToast: () => void;

  // ── compute backend (docs/decisions/2026-10-17-backend-owns-compute.md) ──
  backend: BackendStatus;
  /** Function signatures the connected backend advertises (empty until a handshake). */
  signatures: SignatureDto[];
  /** Handshake with the compute backend; result is stored in `backend`, never silent. */
  connectBackend: () => Promise<void>;
  /** Register a freshly parsed matrix server-side; records the node/matrix id mapping. */
  registerMatrixWithBackend: (name: string, columns: MatrixSnapshot['columns']) => Promise<number | null>;
  /** Server matrix id for a local matrix id, once registered (null while offline). */
  backendMatrixId: (localMatrixId: number) => number | null;
  /** Apply one backend node event: update the indicator and refresh the display cache. */
  applyNodeEvent: (event: NodeEvent) => void;
  /**
   * Subscribe to the backend's long-poll event stream. Idempotent: re-arming replaces any
   * live subscription. Every formula card's four-state light and result table are driven
   * from these events — the browser performs no computation of its own.
   */
  startBackendEventLoop: () => void;
  /** Tear down the event subscription (used by tests and on shutdown). */
  stopBackendEventLoop: () => void;

  // ── persistence ─────────────────────────────────────────────────────
  toSnapshot: () => WorkspaceSnapshot;
  loadSnapshot: (snapshot: WorkspaceSnapshot) => void;
  /**
   * Close the environment-mismatch banner ("以当前环境重算").
   *
   * A notice, not an action: it neither rewrites `workspaceEnv` nor runs anything. Manual
   * runs were always available; the button only acknowledges that the user has read why the
   * stamp differs.
   */
  acknowledgeEnvMismatch: () => void;
  /** Dismiss the one-time "this workspace contains N scripts" notice. */
  dismissScriptNotice: () => void;
  /** Return the store to its initial state (used by tests and "close all"). */
  reset: () => void;
}

let toastCounter = 0;

/** Singleton transport client + local→server matrix id map (backend registration). */
const backendClient = new BackendClient();
const backendMatrixIds = new Map<number, number>();
/**
 * Uploads already on their way, by local matrix id.
 *
 * Two paths legitimately race: a file load registers its parse, and a reconnect registers
 * everything still missing. Without this map both would POST the same table and the loser's
 * server copy would leak — the same coalescing `syncingCards` does for function nodes.
 */
const matrixUploads = new Map<number, Promise<number | null>>();

/** Highest backend event `seq` already applied; the long-poll resumes after it. */
let lastEventSeq = 0;
/** The single live event subscription. Re-armed whenever the backend comes back online. */
let eventLoopAbort: AbortController | null = null;

/** Cancel any live event subscription (module-level so store actions can call it). */
function stopEventLoop(): void {
  if (eventLoopAbort) {
    eventLoopAbort.abort();
    eventLoopAbort = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < GEOM_EPSILON;
}

/**
 * Column label the backend resolves a formula identifier against.
 *
 * The C++ engine matches identifiers case-insensitively on the column's *label* — the
 * annotation when present, otherwise `Pos.N` (`Matrix::label`) — so this mirrors exactly
 * what the old local evaluator used as its variable names. It is not compute: it only
 * tells the store which source columns a formula actually mentions, so each node binds
 * precisely those ports instead of the whole table under an arbitrary alias.
 */
function sourceColumnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? column.annotation : column.posName;
}

/**
 * Characters the expression grammar treats as structure, mirrored from the tokenizer
 * (`backend/src/expression.cpp` / `core/expression.ts`). A name containing one of these is
 * only reachable through `[列名]`.
 */
const STRUCTURAL_IN_NAME = /[\s+\-*/^%<>=!,()[\]（）［］【】，、×÷＋－＊／％＾＝＞＜≠　]/;

/**
 * The spelling a generated default formula should use for a column.
 *
 * The friendly annotation is preferred — it is what the user reads in the table — but only
 * when the tokenizer can actually read it back. `地面速度_μm/s` cannot (`/` is division),
 * and a label that *starts* with a digit or `.` cannot either: the tokenizer opens a number
 * literal there, so `2号测点` reads as `2` followed by a stray identifier. Both fall back to
 * `Pos.N`, which always resolves (`buildColumnMap` registers it for every column).
 */
function formulaReference(column: { posName: string; annotation: string }): string {
  const label = sourceColumnLabel(column);
  // A leading digit/dot is the lexer's rule (number literals win), not just a fully numeric
  // label: "2号测点" is unspellable bare while "2" alone is merely a literal.
  if (label === '' || STRUCTURAL_IN_NAME.test(label) || /^[\d.]/.test(label)) {
    return column.posName;
  }
  return label;
}

/**
 * A snapshot's workspace policy override, or `undefined` when it is absent/unreadable.
 *
 * The field is data from a file, so it is validated like every other restored value: an
 * unknown string is dropped (inherit the global tier) instead of being forwarded into a
 * comparison that would then quietly treat "strict" as "anything else".
 */
function normalizeUnitPolicyOverride(raw: unknown): UnitPolicy | undefined {
  return raw === 'strict' || raw === 'auto' || raw === 'free' ? raw : undefined;
}

/**
 * One drift, worded (units L1a §3).
 *
 * Both callers — the file replacement and the restore — speak the same sentence through the
 * same channel, so the wording lives here instead of being assembled twice. `?` states "the
 * header is ambiguous" and `—` states "no unit", which is what the user needs to see before
 * opening the header to answer.
 */
function unitDriftMessage(locale: Locale, drift: readonly UnitDrift[]): string {
  const first = drift[0];
  const before = first.before.unit !== '' ? first.before.unit : first.before.ambiguous ? '?' : '—';
  const after = first.after.unit !== '' ? first.after.unit : first.after.ambiguous ? '?' : '—';
  return translatorFor(locale)('unit.driftToast', {
    n: drift.length,
    column: first.after.name,
    before,
    after,
  });
}

/**
 * Say something when a same-name column's derived unit changed across a file switch or a
 * workspace restore (units L1a §3).
 *
 * Two gates, in this order, because both are requirements rather than optimisations:
 *   1. `effectiveUnitPolicy(state) === 'strict'`. auto/free never prompt — that is the whole
 *      difference between the tiers, and L1a must not invent behaviour for the other two.
 *   2. The old and the new table must both exist and carry the same column names.
 *
 * The drift itself is `detectUnitDrift`'s decision (a pure function with its own tests); this
 * only pairs the tables up and words the result. The wording goes through the existing toast
 * channel: it is a statement of fact about the file that just arrived, and the next action
 * (confirm each column in the header) is already one click away — L1b adds the dedicated
 * `warnings` channel, and nothing here pre-empts it.
 */
function reportUnitDrift(
  previousCards: readonly CardModel[],
  previousMatrices: ReadonlyMap<number, MatrixData>,
  previousConfirmations: UnitConfirmations,
  previousContext: UnitResolutionContext,
  restoredCards: readonly CardModel[],
  restoredMatrices: ReadonlyMap<number, MatrixData>,
  read: () => WorkspaceState,
): void {
  if (effectiveUnitPolicy(read()) !== 'strict') return;

  const collected: UnitDrift[] = [];
  const seen = new Set<string>();
  for (const card of restoredCards) {
    if (!isMatrixCard(card)) continue;
    const before = previousCards.find((entry) => entry.id === card.id);
    if (!before || !isMatrixCard(before)) continue;
    for (const source of card.sources) {
      const next = restoredMatrices.get(source.matrixId);
      if (!next) continue;
      // The matching OLD table: the same file name in the same card. Pairing by name (not by
      // slot index) is what makes a restored file comparison meaningful — a save leaves the
      // sources in the same order, but a dropped/added file does not have to.
      const oldSource = before.sources.find((entry) => entry.name === source.name);
      const old = oldSource ? previousMatrices.get(oldSource.matrixId) : undefined;
      if (!old) continue;
      for (const drift of detectUnitDrift(
        { columns: old.columns(), confirmations: previousConfirmations, context: previousContext },
        {
          columns: next.columns(),
          confirmations: read().unitConfirmations,
          context: unitResolutionContext(read()),
        },
      )) {
        // Two files of one card can share a quantity name; the same drift is reported once.
        const key = `${card.id}:${source.name}:${drift.stem}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(drift);
      }
    }
  }
  if (collected.length === 0) return;
  const state = read();
  state.showToast('info', unitDriftMessage(state.locale, collected));
}

/**
 * Sanitise unit-confirmation memory read from a save file.
 *
 * A hand-edited (or older) snapshot must not hand the resolver a unit it does not know:
 * only a registered unit or the explicit `none` survives, and only against a numeric column
 * index under a string signature. Anything else is dropped rather than guessed — the same
 * "never invent data" rule the loaders use for unparseable cells.
 */
function sanitizeUnitConfirmations(raw: unknown): UnitConfirmations {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Record<number, string>> = {};
  for (const [signature, perColumn] of Object.entries(raw as Record<string, unknown>)) {
    if (!perColumn || typeof perColumn !== 'object') continue;
    const columns: Record<number, string> = {};
    for (const [indexKey, unit] of Object.entries(perColumn as Record<string, unknown>)) {
      const index = Number(indexKey);
      if (!Number.isInteger(index) || index < 0) continue;
      if (typeof unit !== 'string') continue;
      if (unit !== NO_UNIT && !candidateByUnit(unit)) continue;
      columns[index] = unit;
    }
    if (Object.keys(columns).length > 0) out[signature] = columns;
  }
  return out;
}

/**
 * Sanitise the manual unit constants of a save file (units L1b §B2).
 *
 * Same rule as every other restored value: validate, never guess. A token must be a
 * non-empty string, the dimension a non-empty string and the factor a positive finite
 * number — anything else is DROPPED rather than repaired, because a constant is the user
 * telling the resolver what a spelling means and a repaired one would say something they
 * never wrote. A legacy file without the block restores to `{}` (no definitions).
 */
function sanitizeUnitConstants(raw: unknown): UnitConstants {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, UnitConstant> = {};
  for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
    if (token.trim() === '') continue;
    if (!value || typeof value !== 'object') continue;
    const record = value as { dimension?: unknown; factor?: unknown };
    if (typeof record.dimension !== 'string' || record.dimension.trim() === '') continue;
    if (typeof record.factor !== 'number' || !Number.isFinite(record.factor) || record.factor <= 0) {
      continue;
    }
    out[token] = { dimension: record.dimension.trim(), factor: record.factor };
  }
  return out;
}

/**
 * Make restored cards safe for the backend-owned model.
 *
 * A restored function card has no live node (the backend was restarted, or the file
 * predates node registration), so it comes back with `node: null` and its output id
 * reset — `loadSnapshot` then re-registers every card once, which is what restores the
 * four-state light and the numbers. Chart cards saved before the column dock existed lack
 * `columnPanelOpen`; it is normalised to `false`. Matrix cards pass through untouched.
 */
function normalizeRestoredCards(cards: CardModel[]): CardModel[] {
  return cards.map((card) => {
    if (isFormulaCard(card)) {
      return {
        ...card,
        node: null,
        // Presentation survives a save file; a card written before the fold existed opens
        // expanded, which is what it looked like when it was written.
        inputsPanelOpen: card.inputsPanelOpen ?? true,
        outputsPanelOpen: card.outputsPanelOpen ?? true,
        outputs: card.outputs.map((output) => ({ ...output, resultMatrixId: -1 })),
        // Preserve every other parameter: the column contract is a promise the user made,
        // and silently dropping it on restore would un-lock the widths behind their back.
        params: { ...card.params, formulas: card.params.formulas ?? [] },
      };
    }
    if (isChartCard(card)) {
      return { ...card, columnPanelOpen: card.columnPanelOpen ?? false };
    }
    return card;
  });
}

/**
 * Local display-cache matrix id of one declared output, or `null` when it has none.
 *
 * Output 0 is the card's `displayMatrixId` — the slot every chart and every chained card
 * has always pointed at. Outputs beyond ordinal 0 carry their own slot
 * (`OutputBinding.localMatrixId`), which is what makes a declared `out:N` something a
 * dependent can reference at all. The rule is signature-blind on purpose: a card that
 * declares one output behaves exactly as it did before K > 1 existed.
 */
function outputLocalMatrixId(card: FunctionCardModel, index: number): number | null {
  if (index === 0) return card.displayMatrixId;
  return card.outputs[index]?.localMatrixId ?? null;
}

/**
 * Local matrix id of one declared output, addressed by its stable `outputId`.
 *
 * Exported for the component layer, which addresses an output by id (`out:1`) but needs the
 * local slot id to attach a chart or a chained card to it. That mapping is the store's rule
 * to keep: a component deriving it itself would have to know the "ordinal 0 IS
 * `displayMatrixId`" exception, and would be wrong the day that exception moves.
 */
export function outputMatrixId(card: FunctionCardModel, outputId: string): number | null {
  const index = card.outputs.findIndex((output) => output.outputId === outputId);
  if (index < 0) return null;
  return outputLocalMatrixId(card, index);
}

/** One matrix a card publishes, as a picker has to address it. */
export interface PublishedMatrix {
  matrixId: number;
  /** `null` for an uploaded data file; the stable output identity otherwise. */
  outputId: string | null;
  /** The name the card declares for this output (`params.outputs[i]` / formula name). */
  outputName: string | null;
  /** File name, for a data file. */
  fileName: string | null;
}

/**
 * The name a function card declares for one output, or `null` when it declares none.
 *
 * Both spellings live in the parameter bag alone — `outputs` for a script card, `formulas`
 * for an expression card — so this reads params instead of asking which signature the card
 * runs. That is what gives a future signature labelled outputs for free, and it is also why
 * an unnamed output stays `null` rather than borrowing a generic "Output N" string: the
 * caller can then fall back to the identity (`out:1`), which is always true.
 */
function declaredOutputName(card: FunctionCardModel, index: number): string | null {
  const declared: unknown = card.params.outputs;
  if (Array.isArray(declared)) {
    const name: unknown = declared[index];
    if (typeof name === 'string' && name.trim() !== '') return name;
  }
  const formulas: unknown = card.params.formulas;
  if (Array.isArray(formulas)) {
    const name: unknown = (formulas[index] as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.trim() !== '') return name;
  }
  return null;
}

/**
 * Every matrix a card publishes, in the order a picker should list it.
 *
 * A picker addresses a matrix by id — that is what a chart's `config.sources` stores — and
 * which id stands behind a card's second output is a rule only the store knows (ordinal 0
 * IS `displayMatrixId`, the rest carry their own slot; see `outputLocalMatrixId`). Keeping
 * the enumeration here is the same reasoning as `outputMatrixId`: a component that derived
 * it itself would have to know the ordinal-0 exception, and would list the wrong slots the
 * day that exception moves.
 *
 * Kinds are not discriminated beyond what owning a matrix means. A data card publishes the
 * file it is showing (a specific file, not the card); a function card publishes one address
 * per declared output, whether or not that slot has been fed yet — a slot that is still
 * empty is a real source a chart may already point at.
 */
export function publishedMatrices(card: CardModel): PublishedMatrix[] {
  if (isMatrixCard(card)) {
    const file = card.sources[card.activeSource];
    if (!file) return [];
    return [{ matrixId: file.matrixId, outputId: null, outputName: null, fileName: file.name }];
  }
  if (isFormulaCard(card)) {
    const out: PublishedMatrix[] = [];
    for (let index = 0; index < card.outputs.length; ++index) {
      const matrixId = outputLocalMatrixId(card, index);
      // No slot means no dependent can name this output, so there is nothing to list.
      if (matrixId === null) continue;
      out.push({
        matrixId,
        outputId: card.outputs[index].outputId,
        outputName: declaredOutputName(card, index),
        fileName: null,
      });
    }
    return out;
  }
  return [];
}

/**
 * Server id for a local matrix — with a function card's display cache resolved through its
 * owning card.
 *
 * A formula card's output table exists in the browser only as a display cache
 * (`displayMatrixId`); the authoritative copy is the node's result matrix, whose id is
 * recorded on `outputs[]`. Nothing registers the display matrix itself — `backendMatrixIds`
 * deliberately holds uploaded tables only (see `loadSnapshot`'s derived-matrix exclusion) —
 * so the local→server map can never answer for it. Resolving through the owning card is
 * what lets a chart or a chained function card read a formula card's output; the backend
 * already accepts a result matrix as `sourceMatrixId`.
 *
 * Every declared output is resolved (not just ordinal 0): a script card's `out:2` is a
 * result matrix like any other, and the edge to it carries no rank — only this lookup.
 */
function backendMatrixIdFor(localMatrixId: number): number | null {
  const mapped = backendMatrixIds.get(localMatrixId);
  if (mapped !== undefined) return mapped;
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card)) continue;
    const index = card.outputs.findIndex((_, i) => outputLocalMatrixId(card, i) === localMatrixId);
    if (index < 0) continue;
    const serverId = card.outputs[index]?.resultMatrixId ?? -1;
    return serverId > 0 ? serverId : null;
  }
  return null;
}

/** Cards with a node push in flight, and cards asked again while that push ran. */
const syncingCards = new Set<number>();
const resyncRequested = new Set<number>();
/**
 * Workspace generation. Bumped by `reset` / `loadSnapshot`: card ids restart at 1 after a
 * reset, so a push that started in the previous workspace must not bind its node to the
 * card that happens to inherit the same id.
 */
let workspaceEpoch = 0;

/**
 * Register / patch the ONE backend node behind a function card.
 *
 * v2 (docs/decisions/2026-10-26-card-schema-v2.md): a card is one node with K outputs, so
 * editing an expression PATCHes one node and recomputes once — the v1 mapping needed N
 * nodes and evaluated the same input N times. The node binds the whole source table under
 * port `src` (matrix mode); `params` carries the expressions.
 *
 * Fire-and-forget like registration: never blocks the UI; a genuinely unreachable backend
 * flips the banner (contract 1 — 降级必须可见), it does not fall back to local compute.
 */
async function syncFunctionCard(cardId: number): Promise<void> {
  // One node per card: two overlapping pushes both read `node === null` and create two
  // nodes, and the loser is orphaned server-side (its result matrix is never released).
  // Coalesce rather than drop — the edit that arrived mid-flight must still land, so the
  // card is pushed once more with its latest state when the current push settles.
  if (syncingCards.has(cardId)) {
    resyncRequested.add(cardId);
    return;
  }
  syncingCards.add(cardId);
  try {
    await pushFunctionCard(cardId);
  } finally {
    syncingCards.delete(cardId);
    if (resyncRequested.delete(cardId)) void syncFunctionCard(cardId);
  }
}

/**
 * Wait until no card push is in flight or requested — i.e. the server's node bindings have
 * caught up with the store.
 *
 * Needed before releasing a server-side matrix: the backend refuses `DELETE /api/matrices`
 * while a node still reads it (`hasDependents`, HTTP 409), and a 409 is a failed request
 * the browser logs as a console error. Awaiting `syncFunctionCard` is not enough on its own
 * because a coalesced call returns immediately and schedules one more push. Bounded, so a
 * wedged backend cannot hang a caller; on timeout the caller keeps the server copy instead.
 */
async function waitForCardPushes(timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (syncingCards.size === 0 && resyncRequested.size === 0) return;
    await sleep(40);
  }
}

/**
 * Release a server-side matrix copy, ignoring a refusal.
 *
 * The backend refuses the delete while a node still reads the matrix; by the time this is
 * called the readers have been re-bound, so a refusal can only come from a failed PATCH.
 * The copy then leaks (invisible), instead of retrying behind the user's back.
 */
function releaseServerMatrix(serverId: number): void {
  void backendClient.deleteMatrix(serverId);
}

/**
 * The parameter bag as the node sees it.
 *
 * A parameter belongs to the SIGNATURE, not to the card
 * (docs/decisions/2026-10-27-card-contracts.md §二), so this push ships whatever the card
 * declares and knows nothing about which signature reads which key: a formula card sends
 * `formulas`, a script card sends its whole declaration (`script`/`portNames`/`outputs`),
 * and a signature with no parameters sends an empty bag. Picking keys by signature here
 * would be the card layer second-guessing the signature layer — and it is precisely why a
 * `builtin:python` card could not have worked through the generic push at all.
 */
function wireParams(card: FunctionCardModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card.params)) {
    // `undefined` is "the card has nothing to say about this parameter"; JSON would drop it
    // anyway, but an explicit skip keeps the object inspectable in tests.
    if (value === undefined) continue;
    out[key] = key === 'formulas' ? wireFormulas(value) : value;
  }
  return out;
}

/**
 * `params.formulas` as the backend accepts it.
 *
 * `formulas[].unit` is a CLIENT-side assertion (units L1a): the backend never reads it and
 * an older server validating its parameters would reject the extra key. Dropping it here —
 * at the single point where a card's parameters become a request — keeps the card model the
 * source of truth while the wire stays exactly what it was before the field existed.
 */
function wireFormulas(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { unit: _unit, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
}

async function pushFunctionCard(cardId: number): Promise<void> {
  const state = useWorkspace.getState();
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;

  // The node must read the *server-side* copies of the referenced matrices. A missing id
  // (offline, or not registered yet) is not an error: the card stays unbound and the
  // registration callback / upstream push retries it (syncUnbound* below), instead of
  // leaving it unusable forever.
  const bindings = portBindingsFor(card, backendMatrixIdFor);
  if (!bindings) return;
  const params = wireParams(card);
  const existing = card.node;

  // Identical (params, bindings) means the server already carries this declaration: a
  // restore legitimately pushes the same card twice while matrices register, and the second
  // PATCH would dirty the node again — which an armed script card would read as a new input
  // change and answer with a second interpreter. Skipping it is both cheaper and quieter.
  const pushSignature = JSON.stringify({ params, inputs: bindings });
  if (existing && lastPushedSignature.get(cardId) === pushSignature) return;

  // Identity of the card this push was started for: it can be closed (or the whole
  // workspace replaced) while the request is in flight, and a later card may reuse the id.
  const startedInEpoch = workspaceEpoch;
  const result = existing && existing.nodeId > 0
    ? await backendClient.patchNode(existing.nodeId, { params, inputs: bindings })
    : await backendClient.createNode(bindings, { signatureId: card.signatureId, params });

  if (!result.ok) {
    if (result.code === 'backendUnavailable') {
      useWorkspace.setState({ backend: { state: 'offline', error: result.code } });
    } else {
      // A structured refusal (e.g. cycle) is surfaced on the node so the light goes red
      // and the i18n message renders — visible, never silent.
      markNodeError(cardId, result.code ?? 'internalError', {});
    }
    return;
  }

  const nodeId = result.nodeId!;
  // Closing a card while its create is in flight cannot release a node that did not exist
  // yet, so the fresh node (and its result matrices) would leak server-side forever. The
  // close is the newer intent, so the node is the thing that goes.
  const stillCurrent =
    workspaceEpoch === startedInEpoch &&
    useWorkspace.getState().cards.some((entry) => entry.id === cardId && isFormulaCard(entry));
  if (!stillCurrent) {
    if (!existing) void backendClient.deleteNode(nodeId);
    return;
  }
  // A PATCH response carries no output ids (only nodeId + state), so an empty list must
  // not overwrite the ids recorded at creation — outputs[] keeps the previous values.
  const resultMatrixIds = result.resultMatrixIds ?? (result.resultMatrixId !== undefined ? [result.resultMatrixId] : []);
  applyNodeSnapshot(cardId, {
    nodeId,
    state: result.state ?? 'dirty',
    // Advice about the numbers this answer published (units L1b / B1). Absent when the
    // answer left the node dirty/uncomputed, which clears the previous result's advice.
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
  });
  lastPushedSignature.set(cardId, pushSignature);
  if (resultMatrixIds.length > 0) applyOutputIds(cardId, resultMatrixIds);
  // A downstream card may have been created before this card had a node or a result id;
  // now that it has one, the binding can be completed.
  syncUnboundDependents(cardId);
  if (result.state === 'done') void pullResultIntoCache(cardId);
  // A definition push or an input rebind left the node dirty: for an armed script card that
  // is the same signal a formula card gets from the backend, so it runs in the same wave.
  if ((result.state ?? 'dirty') === 'dirty') maybeAutoRunScript(cardId);
}

/**
 * Re-attempt binding for unbound formula cards that read `ownerCardId`'s output.
 *
 * The chain is built from the upstream card's result menu, and that card may still be
 * computing (or have no node yet). Nothing else retries the binding, so without this an
 * unbound downstream card used to stay "No result yet" forever.
 */
function syncUnboundDependents(ownerCardId: number): void {
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card) || card.node !== null) continue;
    if (card.inputs.some((input) => input.target.cardId === ownerCardId)) {
      void syncFunctionCard(card.id);
    }
  }
}

/** Same retry for a matrix that finished registering after the card was created. */
function syncUnboundReadersOfMatrix(localMatrixId: number): void {
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card) || card.node !== null) continue;
    if (card.inputs.some((input) => input.target.matrixId === localMatrixId)) {
      void syncFunctionCard(card.id);
    }
  }
}

/**
 * Does this node state still describe published numbers? (units L1b / B1)
 *
 * The backend clears its warnings whenever it drops the result (`dirty`, `error`, cancel), so
 * the mirror keeps the same rule: `done`/`computing` may carry advice about the result, every
 * other state means the result is gone and so is the advice. Keeping a sentence about numbers
 * nobody can see is the same lie the backend already refuses to tell.
 */
function warningsSurvive(state: NodeStatus['state']): boolean {
  return state === 'done' || state === 'computing';
}

/**
 * Record a node's state on its card (drives the four-state light).
 *
 * Unit warnings ride along (units L1b / B1) and are SESSION state: they are attached to the
 * in-memory card only, filtered by `warningsSurvive`, and deliberately never written to a
 * snapshot — they describe one result of one server node, and a restored workspace has
 * neither. A caller that has nothing to say about warnings (`undefined`) CLEARS them, which is
 * what every path without a fresh DTO (create, PATCH, a push) actually means.
 */
function applyNodeSnapshot(cardId: number, status: NodeStatus): void {
  const warnings = status.warnings === undefined || !warningsSurvive(status.state)
    ? []
    : normalizeUnitWarnings(status.warnings);
  const next: NodeStatus = warnings.length > 0 ? { ...status, warnings } : { ...status };
  if (warnings.length === 0) delete next.warnings;
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) =>
      card.id === cardId && isFormulaCard(card) ? { ...card, node: next } : card,
    ),
  }));
}

/** Record the server result matrices behind a node's declared outputs. */
function applyOutputIds(cardId: number, resultMatrixIds: number[]): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const outputs = card.outputs.map((output, index) => ({
        ...output,
        resultMatrixId: resultMatrixIds[index] ?? output.resultMatrixId,
      }));
      return { ...card, outputs };
    }),
  }));
}

/** Mark a card's node as errored with a structured code (no result pull attempted). */
function markNodeError(cardId: number, code: string, params: Record<string, unknown>): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const prev = card.node;
      return {
        ...card,
        node: {
          nodeId: prev?.nodeId ?? -1,
          state: 'error',
          code,
          params,
        },
      };
    }),
  }));
}

/** Find the card a node id belongs to (one node per card in v2). */
function locateCardByNode(nodeId: number): number | null {
  for (const card of useWorkspace.getState().cards) {
    if (isFormulaCard(card) && card.node && card.node.nodeId === nodeId) return card.id;
  }
  return null;
}

// ── summary panel (`builtin:summary`) ───────────────────────────────────────────────
//
// The panel is the frontend for a signature that computes NOTHING on creation: it is the
// first `explicitCompute` signature, and `POST /api/nodes/{id}/compute` is its only
// trigger (docs/decisions/2026-10-27-summary-builtin.md §四). Everything below is
// plumbing around that single call — no number is ever produced in the browser.

/** A fresh, empty panel entry (the whole catalog selected, closed, no node). */
function emptySummaryEntry(): SummaryPanelEntry {
  return {
    open: false,
    stats: [...SUMMARY_STATS],
    nodeId: null,
    boundMatrixId: null,
    status: 'idle',
    computedAt: null,
    result: null,
  };
}

/**
 * Canonicalise a requested statistic subset.
 *
 * Unknown ids are dropped and the survivors snap back to CATALOG order — `params.stats`
 * filters, it never reorders (row order is the row identity, decision §一). An empty
 * selection would be `badSignatureParams` on the wire, so the whole catalog is the
 * fallback rather than "0 rows".
 */
export function canonicalSummaryStats(requested: readonly string[]): SummaryStatId[] {
  const wanted = new Set(requested.map((id) => id.toLowerCase()));
  const ordered = SUMMARY_STATS.filter((id) => wanted.has(id));
  return ordered.length > 0 ? [...ordered] : [...SUMMARY_STATS];
}

/**
 * Parameters a summary node is created/patched with.
 *
 * `columns` is deliberately absent: the backend reads a missing `columns` as "every input
 * column", which is the only column set this panel offers (决策 §五). `stats` always
 * travels, because the row set the panel prints IS this filter — canonical and never empty.
 */
function summaryParams(stats: readonly SummaryStatId[]): Record<string, unknown> {
  return { stats: [...stats] };
}

/** Merge one patch into a card's panel entry, creating it on first touch. */
function patchSummary(cardId: number, patch: Partial<SummaryPanelEntry>): void {
  useWorkspace.setState((state) => {
    const card = state.cards.find((entry) => entry.id === cardId);
    // The card can be closed while a compute is in flight; a card created later must never
    // inherit the numbers of the one that died with the same id.
    if (!card || (!isMatrixCard(card) && !isFormulaCard(card))) return {};
    return {
      summaries: {
        ...state.summaries,
        [cardId]: { ...emptySummaryEntry(), ...state.summaries[cardId], ...patch },
      },
    };
  });
}

/** The matrix a card's panel summarises (data card: active file; function card: result). */
interface SummarySource {
  /** Local matrix id — the identity the panel's node binding is checked against. */
  localMatrixId: number;
  /** Name used for the exported file (a file name, or the signature's slug). */
  name: string;
  /** Server-side copy, `null` while it has no id yet (upload pending / never uploaded). */
  serverMatrixId: number | null;
}

function summarySourceOf(card: CardModel): SummarySource | null {
  if (isMatrixCard(card)) {
    const source = card.sources[card.activeSource];
    if (!source) return null;
    return {
      localMatrixId: source.matrixId,
      name: source.name,
      serverMatrixId: backendMatrixIdFor(source.matrixId),
    };
  }
  if (isFormulaCard(card)) {
    // A function card's table exists in the browser only as a display cache; the server id
    // is the node's result matrix, which is exactly what `backendMatrixIdFor` resolves.
    if (card.displayMatrixId < 0) return null;
    return {
      localMatrixId: card.displayMatrixId,
      name: card.signatureId.replace(/^builtin:/, ''),
      serverMatrixId:
        card.node?.state === 'done' ? backendMatrixIdFor(card.displayMatrixId) : null,
    };
  }
  return null;
}

/** The card whose panel owns `nodeId`, if any (the reverse of `SummaryPanelEntry.nodeId`). */
function locateSummaryCardByNode(nodeId: number): number | null {
  for (const [key, entry] of Object.entries(useWorkspace.getState().summaries)) {
    if (entry.nodeId === nodeId) return Number(key);
  }
  return null;
}

/** True while the panel still describes the data it started computing over. */
function summaryStillCurrent(cardId: number, localMatrixId: number): boolean {
  const state = useWorkspace.getState();
  const card = state.cards.find((entry) => entry.id === cardId);
  if (!card) return false;
  const source = summarySourceOf(card);
  return source !== null && source.localMatrixId === localMatrixId;
}

/** Computes in flight per card: 计算 + 重算 pressed twice must not create two nodes. */
const summaryComputing = new Set<number>();

/**
 * Read a summary node's result table.
 *
 * The node's authoritative status names the matrix (`GET /api/nodes/{id}`), so the panel
 * never has to remember an id and a re-created node is simply re-read. The frame is
 * column-major — one array per VARIABLE — and the rows are the catalog filter the backend
 * applied, so this is a transpose, not arithmetic.
 */
async function fetchSummaryTable(
  nodeId: number,
  stats: readonly SummaryStatId[],
): Promise<SummaryResultTable | null> {
  const status = await backendClient.getNode(nodeId);
  if (!status || status.state !== 'done' || status.resultMatrixId < 0) return null;
  const frame = await backendClient.window(status.resultMatrixId, 0, SUMMARY_STATS.length);
  if (!frame.ok) return null;
  const rows = frame.rows ?? 0;
  const columns = frame.columns ?? 0;
  const data = frame.data ?? [];
  const table: number[][] = [];
  for (let r = 0; r < rows; ++r) {
    table.push(data.map((column) => (r < column.length ? column[r] : NaN)));
  }
  return {
    stats: stats.slice(0, rows),
    // Column labels inherit the source columns verbatim (`Pos.1 A`, `Pos.7`).
    columns: (frame.names ?? []).slice(0, columns),
    rows: table,
  };
}

/**
 * Drop the node behind one panel and go back to 未请求.
 *
 * A node reads exactly ONE matrix. When the data under the panel is swapped (a file
 * switch, a file replacement) or the card closes, keeping the node would leave it reading
 * a matrix the store is about to release — which the backend refuses with 409, leaving the
 * copy behind — and the next 计算 would summarise the wrong table. The returned promise
 * resolves once the server let go, so callers that also release the matrix can order it.
 */
function releaseSummaryNode(cardId: number): Promise<void> | null {
  const entry = useWorkspace.getState().summaries[cardId];
  if (!entry) return null;
  patchSummary(cardId, {
    nodeId: null,
    boundMatrixId: null,
    status: 'idle',
    reason: undefined,
    code: undefined,
    computedAt: null,
    result: null,
  });
  if (entry.nodeId === null || entry.nodeId <= 0) return null;
  return backendClient.deleteNode(entry.nodeId).then((result) => {
    if (!result.ok && result.code === 'backendUnavailable') {
      useWorkspace.setState({ backend: { state: 'offline', error: result.code } });
    }
  });
}

/** Release a panel's node if it has one (source change / card close). */
function summarySourceChanged(cardId: number): Promise<void> | null {
  const entry = useWorkspace.getState().summaries[cardId];
  if (!entry || (entry.nodeId === null && entry.result === null && entry.status === 'idle')) {
    return null;
  }
  return releaseSummaryNode(cardId);
}

/**
 * Mirror one backend node event onto a card's panel.
 *
 * This is the ONLY way the panel learns that the numbers went stale: the backend marks the
 * node `dirty` with a `reason` (and has already emptied the result matrix), so the cached
 * table is dropped in the same step. A client-side diff would be a second opinion on a
 * question the backend already answered.
 */
function applySummaryEvent(
  cardId: number,
  stateName: NodeStateName,
  reason: DirtyReasonName | undefined,
  code: string | undefined,
): void {
  if (stateName === 'dirty') {
    patchSummary(cardId, {
      status: 'dirty',
      reason: reason ?? 'upstreamChanged',
      code: undefined,
      result: null,
    });
    return;
  }
  if (stateName === 'error') {
    patchSummary(cardId, { status: 'error', code: code ?? 'internalError', result: null });
    return;
  }
  if (stateName === 'computing') {
    patchSummary(cardId, { status: 'computing', reason: undefined, code: undefined });
    return;
  }
  patchSummary(cardId, { status: 'done', reason: undefined, code: undefined });
  pullSummaryResult(cardId);
}

/**
 * Pull a panel's table after a `done` event.
 *
 * Skipped when the panel already holds the numbers for this compute (the explicit path
 * fetched them); any recompute passes through `dirty` first, which clears the cache, so
 * "no cached table" is the exact condition under which a pull is needed.
 */
function pullSummaryResult(cardId: number): void {
  const entry = useWorkspace.getState().summaries[cardId];
  if (!entry || entry.nodeId === null || entry.result !== null) return;
  const nodeId = entry.nodeId;
  const stats = entry.stats;
  void fetchSummaryTable(nodeId, stats).then((table) => {
    const current = useWorkspace.getState().summaries[cardId];
    if (!current || current.nodeId !== nodeId) return;
    if (!table) {
      // A `done` node whose table cannot be read is an error, never an empty table.
      patchSummary(cardId, { status: 'error', code: 'internalError', result: null });
      return;
    }
    patchSummary(cardId, {
      status: 'done',
      reason: undefined,
      code: undefined,
      computedAt: Date.now(),
      result: table,
    });
  });
}

// ── unit conversion card (`builtin:unit-convert`) ────────────────────────────────────
//
// The second `explicitCompute` signature, and it is explicit for a stronger reason than the
// summary panel: converting REWRITES numbers (in a new table — the source is untouched).
// Creating the card therefore binds a node and computes nothing; the only trigger is
// `convertUnits`. Everything downstream of that call is the ordinary function-card path
// (`pullResultIntoCache` → display cache → dependents), so no number is produced here.

/** Cards with a conversion on the wire: a second click must not race the first. */
const unitConvertsInFlight = new Set<number>();

/** Merge one patch into a card's conversion state, creating it on first touch. */
function patchUnitRun(cardId: number, patch: Partial<UnitConvertRunState>): void {
  useWorkspace.setState((state) => {
    // The card can be closed while a compute is in flight; the ids restart, so a later card
    // must never inherit the state of the one that died with the same id.
    if (!state.cards.some((entry) => entry.id === cardId)) return {};
    return {
      unitRuns: {
        ...state.unitRuns,
        [cardId]: { ...(state.unitRuns[cardId] ?? emptyUnitConvertRun()), ...patch },
      },
    };
  });
}

/**
 * Forget a conversion's numbers when the parameters that produced them changed.
 *
 * The backend empties a result matrix the moment it marks a node dirty, and a stale table
 * under a stale lamp is the same lie the summary panel refuses to tell. The ids survive, so
 * only the cache and the card's `result` bookkeeping are dropped.
 */
function clearUnitConvertResult(cardId: number): void {
  useWorkspace.setState((state) => {
    const found = state.cards.find((entry) => entry.id === cardId);
    // `isFormulaCard` first, for the same narrowing reason as in `convertUnits`.
    if (!found || !isFormulaCard(found) || !isUnitConvertCard(found)) return {};
    const card = found;
    const matrices = new Map(state.matrices);
    matrices.set(card.displayMatrixId, new MatrixData());
    return {
      matrices,
      cards: state.cards.map((entry) =>
        entry.id === cardId && isFormulaCard(entry) ? { ...entry, result: null } : entry,
      ),
    };
  });
}

/**
 * Mirror one backend node event onto a unit-conversion card.
 *
 * The backend is the only authority on staleness: an upstream change arrives as `dirty` +
 * `upstreamChanged`, and the numbers go with it (never a client-side diff). A `done` event
 * that this card did not ask for still refreshes the cache — the backend never converts on
 * its own, so a `done` here can only be the answer to a conversion already requested.
 */
function applyUnitConvertEvent(
  cardId: number,
  stateName: NodeStateName,
  code: string | undefined,
  params: Record<string, unknown> | undefined,
): void {
  if (stateName === 'dirty') {
    clearUnitConvertResult(cardId);
    patchUnitRun(cardId, { status: 'idle', code: null, params: null });
    return;
  }
  if (stateName === 'error') {
    clearUnitConvertResult(cardId);
    patchUnitRun(cardId, { status: 'error', code: code ?? 'internalError', params: params ?? null });
    return;
  }
  if (stateName === 'computing') {
    patchUnitRun(cardId, { status: 'running' });
    return;
  }
  // `done`: the numbers are pulled by the event handler itself (it calls the ordinary
  // `pullResultIntoCache`), and the lamp is set when that pull lands.
}


/** The server clamps one window request to this many rows (`maxWindowRows`). */
const WINDOW_ROWS = 5000;
/**
 * Upper bound on how many result rows are ever cached in the browser.
 *
 * A result table is a *display cache*; the authoritative copy stays server-side. 200 000
 * rows covers the 10⁵-row measurements this tool targets with room to spare (≈1.6 MB per
 * column) while keeping a pathological result from exhausting the tab. Above it the read
 * stops and says so — truncation is never silent.
 */
const MAX_CACHE_ROWS = 200_000;
/**
 * Rows a function card shows by default.
 *
 * A 165 000-row result used to be paged down in full before the card could paint: 34
 * window requests at ~40 ms each, three times over, i.e. seconds of waiting for numbers
 * the first screenful already proved correct. The card now mirrors this many rows and the
 * "show more" action fetches the rest — the dense-matrix frame carries the total shape, so
 * the card can say "100 of 165 000" without downloading the table.
 */
const RESULT_PREVIEW_ROWS = 100;

/**
 * How much of each output slot beyond ordinal 0 the browser currently holds.
 *
 * Ordinal 0 keeps its bookkeeping on the card (`card.result`) because that is where the
 * user's "show more" choice lives. Every other declared output has no such field — and must
 * not grow one on the persisted card model — so completeness is tracked here, keyed by the
 * local matrix id the slot owns. Without it a K-output card cannot tell "out:2 is complete"
 * from "out:2 was never pulled".
 */
const outputSlotCache = new Map<
  number,
  { shownRows: number; totalRows: number; complete: boolean }
>();

/**
 * Pulls of one slot that are still on the wire, keyed by the local matrix id they fill.
 *
 * A chart asks for the same slot from several paths (`ensureChartData` per refresh, the
 * preview pull, "show more"), and a full-table pull takes many window reads. Without this,
 * the refresh that follows one pull starts a second pull of the same slot while the first
 * is still paging, and each duplicate ends by refreshing again.
 */
const outputSlotPulls = new Map<number, Promise<boolean>>();

/**
 * The form of one card that belongs in a save file (units L1b / B1).
 *
 * `node` is the session's mirror of a SERVER node, and its `warnings` are advice about the
 * numbers that particular node published. A save file stores cards, matrices and the
 * workspace's unit layers — never a live node state — so a restored card starts from "no
 * node" and re-registers (the same reason its `result` is rebuilt from a fresh pull). Advice
 * written into the file would then describe numbers nobody has and outlive its own subject.
 * Only that one field is removed: the rest of the node mirror (id, state) is unchanged and
 * has been part of the file shape all along.
 */
function persistedCard(card: CardModel): CardModel {
  if (!('node' in card) || !card.node || card.node.warnings === undefined) return card;
  const node: NodeStatus = { ...card.node };
  delete node.warnings;
  return { ...card, node };
}

interface ResultFetch {
  matrix: MatrixData;
  /** Rows mirrored into the cache (= matrix.rowCount()). */
  shownRows: number;
  /** Rows of the stored result matrix, from the frame's shape header. */
  totalRows: number;
  /** The cache stopped at `MAX_CACHE_ROWS` instead of the end of the data. */
  truncated: boolean;
}

/**
 * Page through a result matrix' windows and assemble up to `rowBudget` rows.
 *
 * `rowBudget` is what separates "first screenful" (`RESULT_PREVIEW_ROWS`) from "the whole
 * result" (`loadFullResult`). Paging is server-side cheap (binary frames) and the stop at
 * `MAX_CACHE_ROWS` is reported to the user.
 */
async function fetchResultRows(resultMatrixId: number, rowBudget: number): Promise<ResultFetch | null> {
  const budget = Math.min(rowBudget, MAX_CACHE_ROWS);
  const columns: number[][] = [];
  let names: string[] = [];
  let fetched = 0;
  let totalRows = 0;
  let truncated = false;

  for (;;) {
    const limit = Math.min(WINDOW_ROWS, budget - fetched);
    if (limit <= 0) {
      // Budget exhausted. Only call it truncation when the matrix is genuinely taller than
      // what the cache is allowed to hold (a 100-row preview of 100 rows is complete).
      truncated = totalRows > fetched && budget >= MAX_CACHE_ROWS;
      break;
    }
    const frame = await backendClient.window(resultMatrixId, fetched, limit);
    if (!frame.ok) {
      if (frame.code === 'backendUnavailable') {
        useWorkspace.setState({ backend: { state: 'offline', error: frame.code } });
      }
      return null;
    }
    const rows = frame.rows ?? 0;
    const data = frame.data ?? [];
    // The frame carries the stored matrix' shape (DCM2); a legacy DCM1 frame has none, and
    // there the window WAS the whole matrix.
    totalRows = frame.totalRows ?? rows;
    // An empty result matrix is a legitimate state (an erroring node clears its output);
    // reading past it must stop, not spin the row counter forward.
    if (data.length === 0) break;
    if (fetched === 0) names = frame.names ?? [];
    for (let c = 0; c < data.length; ++c) {
      const chunk = Array.from(data[c]);
      if (columns[c]) columns[c].push(...chunk);
      else columns[c] = chunk;
    }
    fetched += rows;
    if (rows < limit) break;
  }

  const matrix = new MatrixData();
  for (let c = 0; c < columns.length; ++c) {
    const label = names[c] ?? `Pos.${c + 1}`;
    const space = label.startsWith('Pos.') ? label.indexOf(' ') : -1;
    const posName = space > 0 ? label.slice(0, space) : label;
    const annotation = space > 0 ? label.slice(space + 1) : '';
    matrix.appendColumn(posName, columns[c]);
    matrix.setColumnAnnotation(matrix.columnCount() - 1, annotation);
  }
  return { matrix, shownRows: fetched, totalRows: Math.max(totalRows, fetched), truncated };
}

/**
 * Remember the user's explicit OUTPUT units for the table that just arrived (units L1a §2).
 *
 * This is the ONE line that carries the assertion downstream: the confirmation memory is
 * keyed by column-unit signature, and every consumer (header chips, chart axis, the convert
 * card) already derives its unit through `columnUnitResolutions`, so writing
 * `unitConfirmations[resultSignature][i] = formulas[i].unit` is what makes the asserted unit
 * visible everywhere — no new wire channel, no DCM2 change, no annotation rewrite.
 *
 * Called after EVERY pull (§2 "re-assert after recompute"): a recompute can change the column
 * NAMES, which changes the signature, so the answer has to be written under the new key. The
 * key is the signature of the result's own annotations — the same expression the card's chips
 * compute — so the two can never disagree about which table the assertion belongs to.
 *
 * Nothing is written for an empty assertion, and nothing is ever removed: `params.formulas[]`
 * stays the source of truth, so clearing the picker only stops future assertions.
 */
function assertFormulaUnits(cardId: number): void {
  const state = useWorkspace.getState();
  const card = state.cards.find((entry) => entry.id === cardId);
  if (!card || !isFormulaCard(card)) return;
  const formulas = card.params.formulas;
  const matrix = state.matrices.get(card.displayMatrixId);
  if (!formulas || !matrix || matrix.columnCount() === 0) return;
  const annotations = matrix.columns().map((column) => column.annotation);
  const signature = unitSignature(annotations);
  const existing = state.unitConfirmations[signature] ?? {};
  const next: Record<number, string> = { ...existing };
  let changed = false;
  formulas.forEach((formula, index) => {
    const unit = typeof formula.unit === 'string' ? formula.unit.trim() : '';
    if (unit === '') return;
    // Same guard as every other writer of this memory: an unregistered unit is never
    // remembered (the picker cannot produce one, a hand-edited file can).
    if (!candidateByUnit(unit)) return;
    if (index >= annotations.length) return;
    if (next[index] === unit) return;
    next[index] = unit;
    changed = true;
  });
  if (!changed) return;
  useWorkspace.setState((current) => ({
    unitConfirmations: { ...current.unitConfirmations, [signature]: next },
  }));
  // The numbers are unchanged, but the axis/chip labels of every dependent are derived from
  // this memory — so a chart reading the output must re-derive its axis unit now.
  useWorkspace.getState().refreshDependentsOf(cardId);
}

/** Store a fetched result in the card's display cache and record how much of it we hold. */
function applyResultCache(cardId: number, result: ResultFetch): void {
  useWorkspace.setState((state) => {
    const current = state.cards.find((c) => c.id === cardId);
    if (!current || !isFormulaCard(current)) return {};
    const matrices = new Map(state.matrices);
    matrices.set(current.displayMatrixId, result.matrix);
    const cards = state.cards.map((card) =>
      card.id === cardId && isFormulaCard(card)
        ? {
            ...card,
            result: {
              totalRows: result.totalRows,
              shownRows: result.shownRows,
              complete: result.shownRows >= result.totalRows,
              truncated: result.truncated,
            },
          }
        : card,
    );
    return { matrices, cards };
  });
  // The user's explicit output units are re-asserted against the table that just arrived
  // (units L1a §2) — before the dependents are refreshed, so a chart re-derives the axis
  // unit from the assertion in the same wave that gives it the numbers.
  assertFormulaUnits(cardId);
  // A chart drawn from this output must show the numbers that just arrived — the same
  // "dependents follow their source" rule a data card's file switch follows.
  useWorkspace.getState().refreshDependentsOf(cardId);
  if (result.truncated) {
    useWorkspace
      .getState()
      .showToast(
        'error',
        translatorFor(useWorkspace.getState().locale)('status.resultTruncated', {
          n: MAX_CACHE_ROWS,
        }),
      );
  }
}

/**
 * Whether the browser already holds every row of one declared output.
 *
 * Ordinal 0 answers from the card (`card.result`), every other output from the slot cache:
 * the two are filled by different writers, so "the card is complete" is a per-slot question,
 * not a per-card one.
 */
function outputSlotComplete(card: FunctionCardModel, index: number): boolean {
  // A result taller than MAX_CACHE_ROWS never satisfies "shown == total", so a truncated one
  // is as complete as it can ever get. Answering only `complete` here would make every
  // refresh re-download the capped table, forever.
  if (index === 0) return card.result?.complete === true || card.result?.truncated === true;
  const localMatrixId = outputLocalMatrixId(card, index);
  // No slot means no dependent can name this output, so there is nothing left to fetch.
  if (localMatrixId === null) return true;
  return outputSlotCache.get(localMatrixId)?.complete === true;
}

/** Every local matrix a function card publishes: its display slot plus each extra output. */
function ownedOutputMatrixIds(card: FunctionCardModel): number[] {
  const ids = [card.displayMatrixId];
  for (let index = 1; index < card.outputs.length; ++index) {
    const localMatrixId = outputLocalMatrixId(card, index);
    if (localMatrixId !== null && !ids.includes(localMatrixId)) ids.push(localMatrixId);
  }
  return ids;
}

/**
 * Mirror one declared output beyond ordinal 0 into the local slot that output owns.
 *
 * Ordinal 0 is `applyResultCache`'s job (it carries `card.result` and the "show more"
 * choice). Every other output used to keep an empty slot forever, so a chart or a chained
 * card could bind to `out:N` and read nothing. Dependents are NOT refreshed here: the
 * caller refreshes once after it has filled every slot, because a K-output card is still
 * one card's worth of change.
 */
async function pullOutputSlot(
  card: FunctionCardModel,
  index: number,
  rowBudget: number,
): Promise<boolean> {
  const output = card.outputs[index];
  if (!output || output.resultMatrixId < 0) return false;
  const localMatrixId = outputLocalMatrixId(card, index);
  if (localMatrixId === null) return false;
  // The slot is a fixed identity, so a pull already filling it answers a second request too:
  // a full table is dozens of window reads, and a refresh landing mid-pull used to start a
  // duplicate of all of them.
  const running = outputSlotPulls.get(localMatrixId);
  if (running) return running;
  const epoch = workspaceEpoch;
  const task = (async () => {
    const result = await fetchResultRows(output.resultMatrixId, rowBudget);
    if (!result) return false;
    // A reset / restore while the read was on the wire: local ids restart, so this answer
    // has no reader (the same epoch rule every other async write follows).
    if (epoch !== workspaceEpoch) return false;
    // The declaration can be withdrawn during the same await: `removeScriptOutput` drops the
    // local slot a pull was filling, and an unguarded write would leave a matrix behind that
    // no card owns — nothing would ever release it. Re-read the card and re-derive the slot
    // instead of trusting the pre-await copy.
    const owner = useWorkspace.getState().cards.find((entry) => entry.id === card.id);
    if (!owner || !isFormulaCard(owner) || outputLocalMatrixId(owner, index) !== localMatrixId) {
      return false;
    }
    // The same slot may still hold a NEWER run's result: a rerun rewrites
    // `outputs[index].resultMatrixId` while this read was in flight, and writing now would
    // put the previous run's numbers into the slot that already points at the current one.
    if (owner.outputs[index]?.resultMatrixId !== output.resultMatrixId) return false;
    useWorkspace.setState((state) => {
      const matrices = new Map(state.matrices);
      matrices.set(localMatrixId, result.matrix);
      return { matrices };
    });
    outputSlotCache.set(localMatrixId, {
      shownRows: result.shownRows,
      totalRows: result.totalRows,
      // `truncated` is `fetchResultRows` stopping at MAX_CACHE_ROWS: the rows past the cap are
      // out of reach by design, and asking again would only re-read the same capped window.
      // So the cache holds all it will ever hold, and another pull cannot change that.
      complete: result.shownRows >= result.totalRows || result.truncated,
    });
    return true;
  })().finally(() => outputSlotPulls.delete(localMatrixId));
  outputSlotPulls.set(localMatrixId, task);
  return task;
}

/**
 * Concurrent pulls of the same card are collapsed: create + event + PATCH used to trigger
 * three identical full-table downloads of the same result.
 */
const pullsInFlight = new Map<number, Promise<void>>();

async function pullPreviewIntoCache(cardId: number): Promise<void> {
  const card = useWorkspace.getState().cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;
  const output = card.outputs[0];
  if (!output || output.resultMatrixId < 0) return;

  // A `done` event means the numbers may have changed, so the cache is always refreshed —
  // but how much is refreshed follows the user's last choice: a card the user expanded with
  // "show more" keeps mirroring the whole table instead of collapsing back to the preview.
  const budget = card.result?.complete ? MAX_CACHE_ROWS : RESULT_PREVIEW_ROWS;
  // Which result this read belongs to. A rerun (automatic or not) reassigns the output to a
  // new server matrix while this read is on the wire; writing such an answer would place the
  // PREVIOUS run's numbers under the current one — the "chart shows the old table after a
  // switch" race. The run that superseded it has its own pull.
  const targetMatrixId = output.resultMatrixId;
  const result = await fetchResultRows(targetMatrixId, budget);
  if (!result) return;
  const now = useWorkspace.getState().cards.find((entry) => entry.id === cardId);
  if (!now || !isFormulaCard(now) || now.outputs[0]?.resultMatrixId !== targetMatrixId) return;
  applyResultCache(cardId, result);

  // Ordinal 0 is done above; every further declared output has a slot of its own that only
  // a pull can fill. A slot already expanded keeps its full budget, like the display cache.
  let wrote = false;
  for (let index = 1; index < card.outputs.length; ++index) {
    const localMatrixId = outputLocalMatrixId(card, index);
    const held = localMatrixId === null ? undefined : outputSlotCache.get(localMatrixId);
    const slotBudget = held?.complete ? MAX_CACHE_ROWS : RESULT_PREVIEW_ROWS;
    if (await pullOutputSlot(card, index, slotBudget)) wrote = true;
  }
  // One refresh for the whole card, after every slot holds its numbers: doing it per slot
  // would re-derive the same chart's edges once per declared output.
  if (wrote) useWorkspace.getState().refreshDependentsOf(cardId);
}

/**
 * Pull a done node's result into the card's display cache (first screenful).
 *
 * The backend returns the whole wide table (one column per expression) with the expression
 * names attached as annotations, so the browser-side per-column merge and its cache slots
 * are gone. I/O is paged (see `fetchResultRows`); this function only decides where it goes.
 */
async function pullResultIntoCache(cardId: number): Promise<void> {
  const inflight = pullsInFlight.get(cardId);
  if (inflight) return inflight;
  const task = pullPreviewIntoCache(cardId).finally(() => {
    pullsInFlight.delete(cardId);
    // A chart may have asked for the full column while the preview was in flight.
    ensureChartData(cardId);
  });
  pullsInFlight.set(cardId, task);
  return task;
}

/** Fetch the WHOLE result into the display cache ("show more"). */
async function loadFullResultIntoCache(cardId: number): Promise<void> {
  const inflight = pullsInFlight.get(cardId);
  if (inflight) return inflight;
  const task = (async () => {
    const card = useWorkspace.getState().cards.find((c) => c.id === cardId);
    if (!card || !isFormulaCard(card)) return;
    // "Complete" is a property of every slot, not of ordinal 0: a card whose display cache
    // was already expanded still owes a chart reading `out:2` the rest of that table.
    const allComplete = card.outputs.every((_, index) => outputSlotComplete(card, index));
    if (allComplete) return;

    const output = card.outputs[0];
    if (output && output.resultMatrixId >= 0 && !outputSlotComplete(card, 0)) {
      const result = await fetchResultRows(output.resultMatrixId, MAX_CACHE_ROWS);
      if (result) applyResultCache(cardId, result);
    }

    let wrote = false;
    for (let index = 1; index < card.outputs.length; ++index) {
      if (await pullOutputSlot(card, index, MAX_CACHE_ROWS)) wrote = true;
    }
    if (wrote) useWorkspace.getState().refreshDependentsOf(cardId);
  })().finally(() => pullsInFlight.delete(cardId));
  pullsInFlight.set(cardId, task);
  return task;
}

/**
 * Charts need the whole column — a curve drawn from a 100-row preview would silently show
 * a fraction of the data. So a chart dependent pulls the full result instead of the preview.
 * (An explicit user action — "open a chart from this output" — is what makes paying for the
 * whole table correct.)
 *
 * Which matrix the chart reads is part of the question: a function card publishes one slot
 * per declared output, so filling only ordinal 0 leaves a chart bound to `out:1` holding the
 * preview forever. Only the slots a chart actually names are filled.
 */
function ensureChartData(ownerCardId: number): void {
  const state = useWorkspace.getState();
  const owner = state.cards.find((c) => c.id === ownerCardId);
  if (!owner || !isFormulaCard(owner)) return;

  // The slots a dependent chart actually reads: every attached column plus the explicit X
  // axis, which is a second, independent reference to one of them.
  const wanted = new Set<number>();
  for (const dependentId of state.dependencies.getDependents(ownerCardId)) {
    const card = state.cards.find((entry) => entry.id === dependentId);
    if (!card || !isChartCard(card)) continue;
    for (const source of card.config.sources) wanted.add(source.matrixId);
    if (card.config.xAxisSource) wanted.add(card.config.xAxisSource.matrixId);
  }
  if (wanted.size === 0) return;

  const pending: Array<Promise<boolean>> = [];
  for (let index = 0; index < owner.outputs.length; ++index) {
    const localMatrixId = outputLocalMatrixId(owner, index);
    if (localMatrixId === null || !wanted.has(localMatrixId)) continue;
    if (outputSlotComplete(owner, index)) continue;
    if (index === 0) {
      void loadFullResultIntoCache(ownerCardId);
    } else {
      pending.push(pullOutputSlot(owner, index, MAX_CACHE_ROWS));
    }
  }
  // One refresh after the loop: the freshly pulled rows have to reach the chart's `raw`, and
  // refreshing per slot would walk the dependents once per declared output.
  if (pending.length === 0) return;
  void Promise.all(pending).then((wrote) => {
    if (wrote.some(Boolean)) useWorkspace.getState().refreshDependentsOf(ownerCardId);
  });
}

/**
 * The card that owns a local matrix id.
 *
 * Two kinds can own one: a data card (one per loaded file) and a function card (its
 * output's display cache). Charts, close protection and the edge derivation all need the
 * same answer, so the rule lives in one place — which is also what lets a chart be drawn
 * from a function card's output exactly like from a table (the audit's "公式列无法绘图" gap).
 */
function ownerCardOfMatrix(cards: CardModel[], matrixId: number): CardModel | null {
  for (const card of cards) {
    if (isMatrixCard(card)) {
      if (card.sources.some((source) => source.matrixId === matrixId)) return card;
    } else if (isFormulaCard(card)) {
      // Every declared output slot belongs to the card, not only ordinal 0 — a chart or a
      // chained card reading `out:2` must resolve back to the card that publishes it.
      const owns = card.outputs.some(
        (_, index) => outputLocalMatrixId(card, index) === matrixId,
      );
      if (owns) return card;
    }
  }
  return null;
}

/**
 * Does anything in the workspace still read this matrix?
 *
 * The one rule behind every "is it safe to drop this parse" decision: a source slot, a
 * chart column, a function card's frozen input, or a function card's display cache. The
 * identity cache is deliberately *not* a reference — it is a parse accelerator, and keeping
 * a matrix alive for it would leak one parse per replaced file.
 */
function isMatrixReferenced(cards: CardModel[], matrixId: number): boolean {
  for (const card of cards) {
    if (isMatrixCard(card)) {
      if (card.sources.some((source) => source.matrixId === matrixId)) return true;
    } else if (isChartCard(card)) {
      if (card.config.sources.some((source) => source.matrixId === matrixId)) return true;
      if (card.config.xAxisSource?.matrixId === matrixId) return true;
    } else if (isFormulaCard(card)) {
      if (card.displayMatrixId === matrixId) return true;
      if (card.inputs.some((input) => input.target.matrixId === matrixId)) return true;
    }
  }
  return false;
}

/**
 * Rebuild a chart card's `inputs[]` from its display config.
 *
 * Charts are the one kind whose dependency *edges* are per-column, and the column dock can
 * change them at any moment. Deriving the port list from `config.sources` keeps the two
 * representations in step with a single rule; the graph and the close-protection logic only
 * ever read `inputs`, so a config edit can never leave an edge behind.
 */
function chartInputsFromConfig(card: ChartCardModel, cards: CardModel[]): PortConnection[] {
  const inputs: PortConnection[] = [];
  const ownerIdOf = (matrixId: number): number | undefined =>
    ownerCardOfMatrix(cards, matrixId)?.id;
  for (const source of card.config.sources) {
    const cardId = ownerIdOf(source.matrixId);
    if (cardId === undefined) continue;
    inputs.push({
      portId: chartPortId(source.matrixId, source.columnIndex),
      target: {
        type: 'cell',
        cardId,
        matrixId: source.matrixId,
        column: source.columnIndex,
      },
    });
  }
  const x = card.config.xAxisSource;
  if (x) {
    const cardId = ownerIdOf(x.matrixId);
    if (cardId !== undefined) {
      inputs.push({
        portId: CHART_PORT_X,
        target: { type: 'cell', cardId, matrixId: x.matrixId, column: x.columnIndex },
      });
    }
  }
  return inputs;
}

/**
 * Replace the store's dependency graph with one derived purely from `inputs[]`.
 *
 * This is the whole point of the v2 schema: rebuilding dependencies is one pass with zero
 * per-kind knowledge, so a card kind that forgets to register its edges is impossible
 * rather than merely unlikely (the v1 code rebuilt from chart cards only, which is how
 * formula dependencies used to vanish on reload).
 */
function rebuildDependencies(cards: CardModel[]): {
  dependencies: DependencyGraph;
  droppedEdges: number;
} {
  const dependencies = new DependencyGraph();
  const known = new Set(cards.map((card) => card.id));
  let droppedEdges = 0;
  for (const card of cards) {
    for (const input of card.inputs) {
      const target = input.target.cardId;
      // Skip dangling references and self-loops: a hand-edited file must not corrupt the
      // close-protection invariant.
      if (target === card.id || !known.has(target)) {
        droppedEdges += 1;
        continue;
      }
      // The port id travels with the edge: it is the identity the connection layer
      // anchors on, and it is already on the envelope — no per-kind knowledge needed.
      if (dependencies.addDependency(card.id, target, input.portId)) droppedEdges += 1;
    }
  }
  return { dependencies, droppedEdges };
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Highest z currently in use, so new cards land on top. */
  const topZ = (): number =>
    get().cards.reduce((max, card) => Math.max(max, card.z), 0);

  /**
   * Bring a freshly created card into view by panning, not by moving the card.
   *
   * Split out of the placement helpers because only the store may write the view, and
   * because every "new card" path (table, chart, formula) wants the same follow-up.
   */
  const revealCard = (bounds: { x: number; y: number; width: number; height: number }): void => {
    const current = get().view;
    const next = revealView(bounds, current);
    if (next.x !== current.x || next.y !== current.y) set({ view: next });
  };

  /**
   * Push fresh column data into every chart that reads data from `matrixCardId`.
   *
   * Dependencies are registered against the *card* (chart → matrix card) rather than
   * the parsed matrix id, because a matrix card owns several matrices when it holds
   * several files. Switching the active file therefore re-points each dependent line
   * at the newly active matrix — the behaviour the Qt frontend wanted but could not
   * express, since its `SourceRef` captured a matrix id.
   *
   * A line keeps its previous data when the new file no longer has that column.
   *
   * `retiredMatrixIds` covers file *replacement*: the old matrix is no longer one of the
   * card's slots, but a chart may still hold it, and that chart must follow the new file
   * exactly like a switch does. Only this card's dependents are visited, so a matrix that
   * is also a source of another card is never re-pointed behind that card's back.
   */
  const refreshDependentsOf = (
    ownerCardId: number,
    retiredMatrixIds: readonly number[] = [],
  ): void => {
    const state = get();
    const owner = state.cards.find((c) => c.id === ownerCardId);
    if (!owner) return;

    // A formula card's display cache may hold only the first screenful; charts read the
    // whole column, so a chart dependent upgrades the cache before it re-points.
    if (isFormulaCard(owner)) ensureChartData(ownerCardId);

    // A data card re-points dependents at its newly active file; a function card's outputs
    // are fixed slots, so each dependent keeps the slot its binding names and only re-reads
    // the values (see `refreshSource`).
    let activeMatrixId: number | undefined;
    let matrixIds: Set<number>;
    if (isMatrixCard(owner)) {
      activeMatrixId = owner.sources[owner.activeSource]?.matrixId;
      matrixIds = new Set(owner.sources.map((source) => source.matrixId));
      for (const retired of retiredMatrixIds) matrixIds.add(retired);
    } else if (isFormulaCard(owner)) {
      activeMatrixId = owner.displayMatrixId;
      matrixIds = new Set(ownedOutputMatrixIds(owner));
    } else {
      return;
    }
    if (activeMatrixId === undefined) return;
    const activeId = activeMatrixId;
    const activeMatrix = state.matrices.get(activeId);
    if (!activeMatrix) return;

    const dependentIds = new Set(state.dependencies.getDependents(ownerCardId));
    if (dependentIds.size === 0) return;

    /**
     * The matrix a source bound to `matrixId` reads after this refresh, or `null` when that
     * slot holds nothing yet (the curve keeps its previous values).
     *
     * A data card has ONE address — its newly active file — so every dependent follows it.
     * A function card has a slot per declared output, and the id a dependent carries is the
     * port it bound to: it survives the refresh and only that slot's values are re-read.
     * Collapsing it onto `displayMatrixId` is what made every output beyond ordinal 0
     * unfeedable — a chart on `out:1` would silently plot output 0 instead.
     */
    const refreshSource = (matrixId: number): { id: number; matrix: MatrixData } | null => {
      const id = isMatrixCard(owner) || !matrixIds.has(matrixId) ? activeId : matrixId;
      const matrix = state.matrices.get(id);
      return matrix ? { id, matrix } : null;
    };

    /**
     * Re-point one attached column at the matrix it should be showing.
     *
     * A column that vanished keeps its previous values so the curve does not silently
     * disappear — the behaviour the Qt frontend settled on.
     */
    const rePoint = (
      source: ChartSource,
      target: { id: number; matrix: MatrixData },
    ): ChartSource => {
      if (source.columnIndex >= target.matrix.columnCount()) {
        return { ...source, matrixId: target.id };
      }
      const column = target.matrix.column(source.columnIndex);
      const raw = column.data.slice();
      return {
        ...source,
        matrixId: target.id,
        raw,
        label: columnLabel(column),
      };
    };

    set(() => {
      const cards = state.cards.map((card) => {
        if (!dependentIds.has(card.id)) return card;

        if (isChartCard(card)) {
          /**
           * A chart may only be re-read from a slot the browser actually holds in full.
           *
           * A function card's result lands in two steps: a 100-row preview (what the card's
           * own table shows) and then the whole column, which a chart needs. Handing the
           * chart the preview in between draws a curve of the first 100 rows — the reported
           * "the chart gets a matrix that is not computed yet". Keeping the previous values
           * until the slot is complete is both honest (the curve is stale, not truncated)
           * and stable; the completion pull refreshes it.
           */
          const slotComplete = (matrixId: number): boolean => {
            if (!isFormulaCard(owner)) return true;
            const index = owner.outputs.findIndex(
              (_, i) => outputLocalMatrixId(owner, i) === matrixId,
            );
            if (index < 0) return true; // not this card's slot: nothing of ours to gate
            return outputSlotComplete(owner, index);
          };
          let changed = false;
          const sources = card.config.sources.map((source) => {
            // Only sources that actually read this card's data are re-pointed.
            if (!matrixIds.has(source.matrixId)) return source;
            if (!slotComplete(source.matrixId)) return source;
            const target = refreshSource(source.matrixId);
            if (!target) return source;
            changed = true;
            return rePoint(source, target);
          });

          // The explicit X axis is a second, independent reference to a column of this
          // card's matrix. Leaving it alone made a file switch plot the *new* Y values
          // against the *previous* file's X values.
          let xAxisSource = card.config.xAxisSource;
          if (xAxisSource && matrixIds.has(xAxisSource.matrixId) && slotComplete(xAxisSource.matrixId)) {
            const target = refreshSource(xAxisSource.matrixId);
            if (target) {
              changed = true;
              // A vanished X column falls back to the row index rather than keeping stale
              // values: the dropdown's label and the drawn axis must not disagree.
              xAxisSource =
                xAxisSource.columnIndex >= target.matrix.columnCount()
                  ? null
                  : rePoint(xAxisSource, target);
            }
          }

          if (!changed) return card;
          const next: ChartCardModel = {
            ...card,
            config: { ...card.config, sources, xAxisSource },
          };
          // Charts follow the new file by design (a chart is a *view*), so their
          // authoritative edges are re-derived from the re-pointed config in the same
          // pass — an edge can never describe a matrix the chart no longer shows.
          next.inputs = chartInputsFromConfig(next, state.cards);
          return next;
        }

        // A function card does NOT follow: v2 freezes its input to one explicit matrix, so
        // switching a table's active file leaves its numbers alone until the user
        // explicitly re-points it (docs/decisions/2026-10-26-card-schema-v2.md §迁移).
        return card;
      });

      return { cards };
    });
  };

  /**
   * The matrix a chart should read from `card`: a data card's active file, or a function
   * card's output table. `null` when the owner has nothing to show yet.
   */
  const chartSourceMatrixId = (card: CardModel): number | null => {
    if (isMatrixCard(card)) {
      return card.sources[card.activeSource]?.matrixId ?? null;
    }
    if (isFormulaCard(card)) {
      const matrix = get().matrices.get(card.displayMatrixId);
      return matrix ? card.displayMatrixId : null;
    }
    return null;
  };

  /**
   * Resolve local matrix ids for freshly parsed files.
   *
   * The byte-identity cache is reused rather than re-parsed (the same bytes opened twice
   * share one matrix), but sharing is always *read-only*: a later replacement hands the
   * changed card a fresh id instead of writing through the alias. That is what makes
   * `replaceCardSources` safe with two cards that happen to hold the same file.
   */
  const allocateMatrices = (
    entries: MatrixEntry[],
  ): {
    matrices: Map<number, MatrixData>;
    matrixIdByIdentity: Map<string, number>;
    nextMatrixId: number;
    ids: number[];
  } => {
    const state = get();
    const matrices = new Map(state.matrices);
    const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
    let nextMatrixId = state.nextMatrixId;
    const ids: number[] = [];

    for (const entry of entries) {
      const key = entry.identity ? identityKey(entry.identity) : null;
      const existing = key !== null ? matrixIdByIdentity.get(key) : undefined;
      if (existing !== undefined && matrices.has(existing)) {
        ids.push(existing);
        continue;
      }
      const matrixId = nextMatrixId++;
      matrices.set(matrixId, entry.matrix);
      if (key !== null) matrixIdByIdentity.set(key, matrixId);
      ids.push(matrixId);
    }

    return { matrices, matrixIdByIdentity, nextMatrixId, ids };
  };

  /**
   * Upload one local table to the backend, coalescing concurrent attempts.
   *
   * Fire-and-forget like the original inline block: a file load must never wait on the
   * network, and a failure flips the banner (`registerMatrixWithBackend` does that). The
   * workspace generation is captured so an upload that started before a `reset` /
   * `loadSnapshot` cannot bind its server id to an id that now names different bytes —
   * the server copy is released instead.
   */
  const registerUploadedMatrix = (
    matrixId: number,
    name: string,
    matrix: MatrixData,
  ): Promise<number | null> => {
    const inFlight = matrixUploads.get(matrixId);
    if (inFlight) return inFlight;

    const epoch = workspaceEpoch;
    const columns = matrix.columns().map((column) => ({
      posName: column.posName,
      annotation: column.annotation,
      data: column.data,
    }));
    const task = get()
      .registerMatrixWithBackend(name, columns)
      .then((serverId) => {
        if (serverId === null) return null;
        if (epoch !== workspaceEpoch || !get().matrices.has(matrixId)) {
          // The workspace was replaced while this upload ran: the local id now means
          // something else (or nothing), so the server copy has no reader.
          void backendClient.deleteMatrix(serverId);
          return null;
        }
        backendMatrixIds.set(matrixId, serverId);
        // A function card created while this table was still uploading has been waiting
        // for exactly this id; nothing else retries its binding.
        syncUnboundReadersOfMatrix(matrixId);
        return serverId;
      })
      .finally(() => {
        matrixUploads.delete(matrixId);
      });
    matrixUploads.set(matrixId, task);
    return task;
  };

  /**
   * Drop a local matrix once nothing reads it, including its server-side copy.
   *
   * Called after every operation that can orphan a parse (file replacement, a function
   * card applying a re-point). The guard is `isMatrixReferenced`, so a matrix that is
   * still a source slot, a chart column, or a frozen function input survives — including
   * the shared-parse case, where another card still points at the same id.
   */
  const pruneMatrixIfUnreferenced = (matrixId: number): void => {
    const state = get();
    if (!state.matrices.has(matrixId)) return;
    if (isMatrixReferenced(state.cards, matrixId)) return;

    const matrices = new Map(state.matrices);
    matrices.delete(matrixId);
    const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
    for (const [key, id] of matrixIdByIdentity) {
      if (id === matrixId) matrixIdByIdentity.delete(key);
    }
    // Release the server-side copy too, otherwise the backend grows without bound as a
    // template is re-filled with fresh data. The id is dropped first so a later reconnect
    // cannot hand out an id the server no longer has.
    const backendId = backendMatrixIds.get(matrixId);
    if (backendId !== undefined) {
      backendMatrixIds.delete(matrixId);
      void backendClient.deleteMatrix(backendId);
    }
    set({ matrices, matrixIdByIdentity });
  };

  /**
   * Re-point every function card that reads one of `oldToNew`'s keys.
   *
   * This is the *data* half of a file replacement: the card's input is frozen to an
   * explicit matrix (v2), so it must be rewritten when that matrix's bytes are replaced —
   * but it is rewritten to the corresponding new matrix of the *same card*, never to
   * "whatever it shows now". Returns the affected card ids so the caller can PATCH them
   * once the new matrices have server ids.
   */
  const repointReadersOf = (ownerCardId: number, oldToNew: Map<number, number>): number[] => {
    if (oldToNew.size === 0) return [];
    const state = get();
    const affected: number[] = [];
    const cards = state.cards.map((card) => {
      if (!isFormulaCard(card)) return card;
      let changed = false;
      const inputs = card.inputs.map((input) => {
        if (input.target.cardId !== ownerCardId) return input;
        const nextMatrixId = oldToNew.get(input.target.matrixId);
        if (nextMatrixId === undefined) return input;
        changed = true;
        return { ...input, target: { ...input.target, matrixId: nextMatrixId } };
      });
      if (!changed) return card;
      affected.push(card.id);
      return { ...card, inputs };
    });
    if (affected.length > 0) set({ cards });
    return affected;
  };

  /**
   * Register every uploaded table the server has not seen yet, then re-push function cards.
   *
   * Nothing else retries a registration that failed while the backend was down, so without
   * this a table loaded (or a file replaced) during an outage would leave its function
   * cards bound to the old numbers forever — with no banner once the connection is back.
   */
  const ensureUploadedMatricesRegistered = async (): Promise<void> => {
    const derivedIds = new Set(
      get()
        .cards.filter(isFormulaCard)
        .map((card) => card.displayMatrixId),
    );
    const ordered = [...get().matrices.entries()]
      .filter(([localId]) => !derivedIds.has(localId) && !backendMatrixIds.has(localId))
      .sort((a, b) => a[0] - b[0]);
    for (const [localId, matrix] of ordered) {
      await registerUploadedMatrix(localId, `#${localId}`, matrix);
    }
    for (const card of get().cards) {
      if (isFormulaCard(card)) void syncFunctionCard(card.id);
    }
  };

  /**
   * Build the re-point offers a file switch creates for function cards reading that table.
   *
   * Only cards whose input targets one of the switching card's matrices are offered, and a
   * card whose input already points at the newly active matrix is not (nothing to apply).
   * The column diff is what decides whether the offer is a plain confirm or needs the
   * "apply anyway" path: expressions reference columns BY NAME, so a changed header set is
   * the one difference that can silently change what the card computes.
   */

  /**
   * Commit a chart config change and keep `inputs[]` (the authoritative edges) in step.
   *
   * Every chart mutation funnels through here, so there is exactly one rule for "which
   * cards does this chart read?" and it is applied atomically: new owner edges are
   * validated for cycles BEFORE anything is written (a refused edit leaves the chart and
   * the graph untouched), stale edges are dropped afterwards.
   */
  const commitChartConfig = (
    cardId: number,
    mutate: (config: ChartConfig) => ChartConfig,
  ): boolean => {
    const state = get();
    const card = state.cards.find((c) => c.id === cardId);
    if (!card || !isChartCard(card)) return false;
    const nextConfig = mutate(card.config);
    if (nextConfig === card.config) return true;

    const cards = state.cards.map((entry) =>
      entry.id === cardId && isChartCard(entry) ? { ...entry, config: nextConfig } : entry,
    );
    const nextCard = cards.find((c) => c.id === cardId) as ChartCardModel;
    const nextInputs = chartInputsFromConfig(nextCard, cards);

    const beforeOwners = new Set(card.inputs.map((input) => input.target.cardId));
    const afterOwners = new Set(nextInputs.map((input) => input.target.cardId));
    const portsFor = (ownerId: number): string[] =>
      nextInputs.filter((input) => input.target.cardId === ownerId).map((input) => input.portId);
    for (const ownerId of afterOwners) {
      if (beforeOwners.has(ownerId)) continue;
      const cycle = state.dependencies.addDependency(cardId, ownerId, portsFor(ownerId));
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return false;
      }
    }
    for (const ownerId of beforeOwners) {
      if (!afterOwners.has(ownerId)) state.dependencies.removeDependency(cardId, ownerId);
    }
    // A surviving owner can still have its port set rewritten (a column was added to or
    // removed from the chart without changing who owns it), so re-sync the set instead of
    // only appending to it.
    for (const ownerId of afterOwners) {
      state.dependencies.removeDependency(cardId, ownerId);
      state.dependencies.addDependency(cardId, ownerId, portsFor(ownerId));
    }
    set({ cards: cards.map((entry) => (entry.id === cardId ? { ...nextCard, inputs: nextInputs } : entry)) });
    return true;
  };

  return {
    cards: [],
    matrices: new Map(),
    matrixIdByIdentity: new Map(),
    selectedId: null,
    dependencies: new DependencyGraph(),
    // No file yet: nothing to trust, and a session-authored script never waits.
    trust: initialTrust(),
    // No confirmations yet: every ambiguous header starts un-asked.
    unitConfirmations: {},
    // No override yet: a new workspace inherits the global tier.
    unitPolicyOverride: undefined,
    // No manual constants yet: every header is read by the registry alone.
    unitConstants: {},
    propagationFrozen: false,
    blockers: [],
    blockedCardId: null,
    blockNonce: 0,
    toast: null,
    helpOpen: false,
    helpSection: null,
    locale: detectLocale(),
    // A brand-new (never-saved) workspace carries the toolchain this build is pinned to;
    // `loadSnapshot` replaces it with whatever the file says.
    workspaceEnv: cloneWorkspaceEnv(PINNED_WORKSPACE_ENV),
    envMismatchAcknowledged: false,
    scriptNotice: null,
    nextCardId: 1,
    nextMatrixId: 1,
    view: { x: 0, y: 0, zoom: 1 },

    // ── card lifecycle ────────────────────────────────────────────────

    addMatrixCard(entries) {
      if (entries.length === 0) return -1;
      const state = get();
      const cardId = state.nextCardId;
      const z = topZ() + 1;

      // Reuse an already-parsed matrix only when the *bytes* match; allocate a new id
      // otherwise. An entry without an identity (a programmatically built table, or a
      // restored snapshot) is never shared — it gets its own matrix.
      const allocated = allocateMatrices(entries);
      const sources = allocated.ids.map((matrixId, index) => ({
        name: entries[index].name,
        matrixId,
      }));
      // Register server-side too: the backend holds the authoritative copy.
      // Fire-and-forget: file loading must never wait on the network; a failed
      // registration flips `backend` to offline and the banner appears.
      for (let index = 0; index < entries.length; ++index) {
        void registerUploadedMatrix(allocated.ids[index], entries[index].name, entries[index].matrix);
      }

      // Cascade placement, so stacked cards do not land exactly on top of each other.
      // Routed through placeOnPlane so a table opened while the view is panned away
      // still lands where the user is looking.
      const offset = (state.cards.length % 8) * 28;
      const matrixSize = { width: 640, height: 420 };
      const matrixSpot = placeOnPlane(
        { x: 24 + offset, y: 24 + offset },
        matrixSize,
        state.cards,
      );
      const card: MatrixCardModel = {
        kind: 'matrix',
        id: cardId,
        title: '',
        ...matrixSpot,
        width: matrixSize.width,
        height: matrixSize.height,
        z,
        createdAt: Date.now(),
        // A table is a data source: `sources[]` is content, never a dependency.
        inputs: [],
        sources,
        activeSource: 0,
        readOnly: true,
      };

      set({
        cards: [...state.cards, card],
        matrices: allocated.matrices,
        matrixIdByIdentity: allocated.matrixIdByIdentity,
        nextCardId: cardId + 1,
        nextMatrixId: allocated.nextMatrixId,
        selectedId: cardId,
      });
      revealCard({ ...matrixSpot, ...matrixSize });
      return cardId;
    },

    /**
     * A data card's file change — the operation the card never had.
     *
     * Deliberately NOT "mutate the matrix in place": two cards may share one parse
     * (`allocateMatrices`), and writing through that alias would change the other card's
     * numbers. Every replacement therefore allocates a new local id and moves this card's
     * own references onto it; the old matrix is released only once nothing reads it.
     */
    replaceCardSources(cardId, entries, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return false;
      if (entries.length === 0) return false;
      if (index !== undefined) {
        // The UI's「替换文件…」control always acts on the file the card is showing; a
        // replacement of a hidden slot would change numbers the user cannot see.
        if (index !== card.activeSource || index < 0 || index >= card.sources.length) {
          return false;
        }
        if (entries.length !== 1) return false;
      }

      const allocated = allocateMatrices(entries);
      const previous = card.sources;
      // What the replaced slot's columns resolved to BEFORE the swap — the other half of the
      // drift comparison below (units L1a §3). Read now: `pruneMatrixIfUnreferenced` can drop
      // the old parse before the function returns.
      const replacedSource = index !== undefined ? previous[index] : undefined;
      const beforeMatrix = replacedSource ? state.matrices.get(replacedSource.matrixId) : undefined;
      const beforeConfirmations = state.unitConfirmations;
      const beforeContext = unitResolutionContext(state);
      const nextSources =
        index === undefined
          ? entries.map((entry, entryIndex) => ({
              name: entry.name,
              matrixId: allocated.ids[entryIndex],
            }))
          : previous.map((source, sourceIndex) =>
              sourceIndex === index
                ? { name: entries[0].name, matrixId: allocated.ids[0] }
                : source,
            );

      // Old → new: which matrix each formula card's frozen input must move to. The button
      // path replaces one slot, so the pairing is explicit; a drop replaces the whole set,
      // so it pairs by slot order and sends any unpaired old slot to the new first file
      // (the card now holds this set of files and nothing else).
      const oldToNew = new Map<number, number>();
      if (index === undefined) {
        const activeId = allocated.ids[0];
        previous.forEach((source, sourceIndex) => {
          const target = allocated.ids[sourceIndex] ?? activeId;
          if (!oldToNew.has(source.matrixId) && source.matrixId !== target) {
            oldToNew.set(source.matrixId, target);
          }
        });
      } else if (previous[index].matrixId !== allocated.ids[0]) {
        oldToNew.set(previous[index].matrixId, allocated.ids[0]);
      }

      // Names stay unique inside one card, otherwise the file selector shows two identical
      // entries and the user cannot tell which file they are looking at.
      const taken = new Set<string>();
      const deduped = nextSources.map((source) => {
        let name = source.name;
        if (taken.has(name)) {
          const dot = source.name.lastIndexOf('.');
          let counter = 2;
          while (taken.has(name)) {
            name =
              dot > 0
                ? `${source.name.slice(0, dot)} (${counter})${source.name.slice(dot)}`
                : `${source.name} (${counter})`;
            counter += 1;
          }
        }
        taken.add(name);
        return { ...source, name };
      });

      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isMatrixCard(entry)
            ? {
                ...entry,
                sources: deduped,
                activeSource: index === undefined ? 0 : index,
              }
            : entry,
        ),
        matrices: allocated.matrices,
        matrixIdByIdentity: allocated.matrixIdByIdentity,
        nextMatrixId: allocated.nextMatrixId,
      });

      // A same-NAME, same-POSITION column whose derived unit changed (or became contested) is
      // worth one sentence in a strict workspace; clean data and auto/free stay silent.
      // Scoped to the「替换文件…」path (which always names the slot): a drop replaces the whole
      // file set, so there is no single "this table, new contents" pair to compare against.
      if (replacedSource && beforeMatrix && effectiveUnitPolicy(get()) === 'strict') {
        const afterMatrix = allocated.matrices.get(allocated.ids[0]);
        const drift = afterMatrix
          ? detectUnitDrift(
              {
                columns: beforeMatrix.columns(),
                confirmations: beforeConfirmations,
                context: beforeContext,
              },
              {
                columns: afterMatrix.columns(),
                confirmations: get().unitConfirmations,
                // This workspace's own constants/pre-confirmations: the swap did not change
                // them, so both sides are judged by the same chain.
                context: unitResolutionContext(get()),
              },
            )
          : [];
        if (drift.length > 0) get().showToast('info', unitDriftMessage(get().locale, drift));
      }

      // Charts are views: they follow the file the card now shows.
      refreshDependentsOf(cardId, [...oldToNew.keys()]);
      // The 摘要 panel is frozen to the matrix it was computed over, exactly like a function
      // card's input: the new numbers are a NEW table, so the panel goes back to 未请求 and
      // asks again. Its node has to go before the old server copy is released, or the
      // backend refuses that DELETE (409) because the node still reads it.
      const summaryRelease = summarySourceChanged(cardId);
      // Function cards are frozen references: re-point the ones that read the replaced
      // matrix, then push them once the new content has a server-side id.
      const readers = repointReadersOf(cardId, oldToNew);
      const uploads: Array<Promise<number | null>> = [];
      for (let entryIndex = 0; entryIndex < entries.length; ++entryIndex) {
        const matrixId = allocated.ids[entryIndex];
        if (backendMatrixIds.has(matrixId)) continue;
        uploads.push(registerUploadedMatrix(matrixId, entries[entryIndex].name, entries[entryIndex].matrix));
      }
      // The replaced matrices are already unreferenced *locally*, but their server copies
      // are still bound by the function nodes until the re-point PATCHes land — deleting
      // them now would be refused (409) and leave the copy behind anyway. So the local
      // parse goes immediately, and the server copy goes once the readers have re-bound.
      const retiredServerIds: number[] = [];
      for (const retiredId of oldToNew.keys()) {
        const serverId = backendMatrixIds.get(retiredId);
        if (serverId !== undefined) {
          backendMatrixIds.delete(retiredId);
          retiredServerIds.push(serverId);
        }
        // Nothing reads the replaced matrices any more unless a card elsewhere shared the
        // parse or a function card was left alone; in that case they stay alive.
        pruneMatrixIfUnreferenced(retiredId);
      }

      const syncReaders = async () => {
        await Promise.all(readers.map((readerId) => syncFunctionCard(readerId)));
        // The re-point must be ON THE SERVER before the old copy is released, otherwise
        // the backend refuses the delete (409) and the copy stays behind anyway.
        await waitForCardPushes();
        if (summaryRelease) await summaryRelease;
        for (const serverId of retiredServerIds) releaseServerMatrix(serverId);
      };
      if (uploads.length === 0) void syncReaders();
      else void Promise.all(uploads).then(() => syncReaders());
      return true;
    },

    addChartCard(ownerCardId, columnIndex, chartType, outputId) {
      const state = get();
      const ownerCard = state.cards.find((c) => c.id === ownerCardId);
      if (!ownerCard || isChartCard(ownerCard)) return null;

      // A table's active file, or a function card's output table — both are matrices the
      // chart can read, which is what makes a dataflow edge out of a function card. Naming
      // an output replaces that default: without it a function card only ever offered
      // ordinal 0, so the second table it declares could be seen but never plotted.
      let sourceMatrixId: number | null;
      if (outputId !== undefined) {
        if (!isFormulaCard(ownerCard)) return null;
        const index = ownerCard.outputs.findIndex((output) => output.outputId === outputId);
        if (index < 0) return null;
        sourceMatrixId = outputLocalMatrixId(ownerCard, index);
      } else {
        sourceMatrixId = chartSourceMatrixId(ownerCard);
      }
      if (sourceMatrixId === null) return null;
      const matrix = state.matrices.get(sourceMatrixId);
      if (!matrix) return null;
      if (columnIndex < 0 || columnIndex >= matrix.columnCount()) return null;

      const type: ChartTypeId = chartType ?? 'line';
      const def = chartTypeDef(type);

      // Attach the clicked column first, then as many following columns as the type
      // wants (a scatter needs an X and a Y, a heatmap wants a whole set).
      const wanted = Math.max(def.defaultColumnCount, minimumColumns(type));
      const sources: ChartSource[] = [];
      for (let offset = 0; offset < wanted; ++offset) {
        const index = columnIndex + offset;
        if (index >= matrix.columnCount()) break;
        const column = matrix.column(index);
        sources.push({
          matrixId: sourceMatrixId,
          columnIndex: index,
          label: columnLabel(column),
          raw: column.data.slice(),
        });
      }
      if (sources.length < minimumColumns(type)) return null;

      const cardId = state.nextCardId;
      const chartSize = { width: 560, height: 400 };
      // Beside the card it was opened from, so the connection line stays short.
      const chartSpot = placeOnPlane(
        { x: ownerCard.x + ownerCard.width + 32, y: ownerCard.y + 24 },
        chartSize,
        state.cards,
      );
      const config = defaultChartConfig(type, sources);
      const card: ChartCardModel = {
        kind: 'chart',
        id: cardId,
        title: '',
        // Offset from the source card so the new chart is visibly its child, clamped so it
        // always lands on the card plane.
        ...chartSpot,
        width: chartSize.width,
        height: chartSize.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs: [],
        config,
        smoothing: { ...DEFAULT_SMOOTHING },
        // The column dock starts closed; the user's toggle is persisted via
        // setChartColumnPanel.
        columnPanelOpen: false,
      };
      // Edges are derived from the display config (one rule for every config edit).
      card.inputs = chartInputsFromConfig(card, state.cards);
      const cardIds = card.inputs.map((input) => input.target.cardId);
      if (cardIds.length === 0) return null;

      // The chart depends on the matrix *card*: this is what makes "switch file in the
      // table, chart follows" work even though each file is a separate matrix.
      // Guarded against loops — once FunctionCard chains cards together, a chart could
      // otherwise end up depending on itself through a longer path.
      for (const ownerId of new Set(cardIds)) {
        const ports = card.inputs
          .filter((input) => input.target.cardId === ownerId)
          .map((input) => input.portId);
        const cycle = state.dependencies.addDependency(cardId, ownerId, ports);
        if (cycle) {
          get().showToast(
            'error',
            translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
          );
          return null;
        }
      }

      set({
        cards: [...state.cards, card],
        nextCardId: cardId + 1,
        selectedId: cardId,
      });
      revealCard({ ...chartSpot, ...chartSize });
      // A chart reads a whole column, so the slot it was just bound to may need the rest of
      // the table pulled in (the preview only carries the first screenful). Called after the
      // card is in the store: `ensureChartData` finds the chart through the dependency graph
      // and only then knows which slot is actually read.
      ensureChartData(ownerCardId);
      return cardId;
    },

    removeCard(id) {
      const state = get();
      const card = state.cards.find((c) => c.id === id);
      if (!card) return true;

      // A card that still feeds another card must not disappear under it. That used to be
      // a matrix-card-only rule; a function card's output can feed charts too, so the rule
      // is now stated once, for every card that can be a source.
      if (!isChartCard(card) && state.dependencies.hasDependents(id)) {
        set({
          blockedCardId: id,
          blockNonce: state.blockNonce + 1,
          selectedId: id,
        });
        return false;
      }

      const cards = state.cards.filter((c) => c.id !== id);
      const matrices = new Map(state.matrices);
      const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
      // One card owns at most one summary node (a data card as well as a function card).
      // It has to go, and a data card's server table must outlive that DELETE: the backend
      // refuses to drop a matrix a live node still reads (409).
      const summaryRelease = releaseSummaryNode(id);

      if (isMatrixCard(card)) {
        const releasedServerIds: number[] = [];
        for (const source of card.sources) {
          // Drop the parse only when no remaining card refers to it. The identity cache
          // is pruned by scanning it for the id that just died — keying on name would
          // delete the wrong entry whenever two files share a label.
          const stillUsed = cards.some(
            (c) => isMatrixCard(c) && c.sources.some((s) => s.matrixId === source.matrixId),
          );
          if (!stillUsed) {
            matrices.delete(source.matrixId);
            for (const [key, mid] of matrixIdByIdentity) {
              if (mid === source.matrixId) matrixIdByIdentity.delete(key);
            }
            // Release the server-side copy too, otherwise the backend grows without
            // bound as cards are opened and closed. The map entry is dropped first so a
            // later reconnect cannot hand out an id the server no longer has.
            const backendId = backendMatrixIds.get(source.matrixId);
            if (backendId !== undefined) {
              backendMatrixIds.delete(source.matrixId);
              releasedServerIds.push(backendId);
            }
          }
        }
        const releaseAll = () => {
          for (const backendId of releasedServerIds) void backendClient.deleteMatrix(backendId);
        };
        if (summaryRelease) void summaryRelease.then(releaseAll);
        else releaseAll();
      } else if (isFormulaCard(card)) {
        // A function card owns its display cache — and every declared output's own slot —
        // outright; no other card references them, so they must not be left behind.
        matrices.delete(card.displayMatrixId);
        for (const output of card.outputs) {
          if (output.localMatrixId !== undefined) matrices.delete(output.localMatrixId);
        }
        // The display cache is never a registered source, so a stale entry here could only
        // come from a future change; dropping it keeps the map honest either way.
        backendMatrixIds.delete(card.displayMatrixId);
        // Delete the one backing node server-side. `DELETE /api/nodes/{id}` also drops its
        // result matrices, which is what releases the compute graph on close.
        const nodeId = card.node?.nodeId ?? -1;
        if (nodeId > 0) {
          void backendClient.deleteNode(nodeId).then((result) => {
            if (!result.ok && result.code === 'backendUnavailable') {
              set({ backend: { state: 'offline', error: result.code } });
            }
          });
        }
      }

      state.dependencies.removeAllDependencies(id);

      set((current) => ({
        cards,
        matrices,
        matrixIdByIdentity,
        // The panel's node is gone with the card; the entry must not survive to describe
        // a card id that a later card could inherit. A script card's run state (traceback,
        // previews) describes a node that is being deleted for the same reason.
        summaries: Object.fromEntries(
          Object.entries(current.summaries).filter(([key]) => Number(key) !== id),
        ),
        scriptRuns: Object.fromEntries(
          Object.entries(current.scriptRuns).filter(([key]) => Number(key) !== id),
        ),
        // Same rule for a unit-conversion card's last conversion.
        unitRuns: Object.fromEntries(
          Object.entries(current.unitRuns).filter(([key]) => Number(key) !== id),
        ),
        // An offer names a card that no longer exists; keeping it would leave a banner
        selectedId: current.selectedId === id ? null : current.selectedId,
        blockedCardId: current.blockedCardId === id ? null : current.blockedCardId,
      }));
      return true;
    },

    closeAllCards() {
      const state = get();
      // The backend has no way to notice that the user closed a card, so "close all" has to
      // say so: release every node, then every uploaded table. Skipping this left the whole
      // compute graph behind, and a reopened workspace inherited nodes that still read the
      // old matrices — those leaks also refuse the `DELETE /api/matrices` a file
      // replacement needs. Nodes go first and are awaited: a matrix cannot be deleted while
      // one of them reads it.
      const nodeIds: number[] = [];
      const serverMatrixIds: number[] = [];
      // Every 摘要 panel owns a node too (lifecycle plan A), and it reads either an uploaded
      // table or a function card's result matrix — so it goes in the same "nodes first"
      // batch, or the matrix DELETEs below would be refused with 409.
      for (const entry of Object.values(state.summaries)) {
        if (entry.nodeId !== null && entry.nodeId > 0) nodeIds.push(entry.nodeId);
      }
      for (const card of state.cards) {
        if (isFormulaCard(card)) {
          const nodeId = card.node?.nodeId ?? -1;
          if (nodeId > 0) nodeIds.push(nodeId);
        } else if (isMatrixCard(card)) {
          for (const source of card.sources) {
            const serverId = backendMatrixIds.get(source.matrixId);
            if (serverId !== undefined) {
              backendMatrixIds.delete(source.matrixId);
              serverMatrixIds.push(serverId);
            }
          }
        }
      }
      matrixUploads.clear();
      void (async () => {
        // A push that started before the close may still create a node; it deletes its own
        // node when it notices the card is gone, so wait for it before releasing matrices.
        await waitForCardPushes();
        for (const nodeId of nodeIds) await backendClient.deleteNode(nodeId);
        for (const serverId of serverMatrixIds) releaseServerMatrix(serverId);
      })();
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        blockedCardId: null,
        blockNonce: state.blockNonce + 1,
        dependencies: new DependencyGraph(),
            // The panels' nodes were released above; their state goes with the cards.
        summaries: {},
        // Confirmations belonged to the matrices that were just released.
        unitConfirmations: {},
        // Same for each script card's last run: the nodes are gone with the cards.
        scriptRuns: {},
        // …and for a unit-conversion card's last conversion.
        unitRuns: {},
        // The sentence counted the scripts of the workspace that was just emptied; leaving
        // it up would state a fact about cards that no longer exist.
        scriptNotice: null,
      });
    },

    setBounds(id, bounds) {
      set((state) => {
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        const card = state.cards[index];
        const width = Math.max(MIN_CARD_WIDTH, bounds.width);
        const height = Math.max(MIN_CARD_HEIGHT, bounds.height);
        if (
          nearlyEqual(card.x, bounds.x) &&
          nearlyEqual(card.y, bounds.y) &&
          nearlyEqual(card.width, width) &&
          nearlyEqual(card.height, height)
        ) {
          return state; // unchanged — avoids a render loop with the drag handler
        }
        const next = state.cards.slice();
        next[index] = { ...card, x: bounds.x, y: bounds.y, width, height };
        return { ...state, cards: next };
      });
    },

    bringToFront(id) {
      set((state) => {
        const top = state.cards.reduce((max, c) => Math.max(max, c.z), 0);
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        // Already on top and already selected -> nothing to do.
        if (state.cards[index].z === top && state.selectedId === id) return state;
        const next = state.cards.slice();
        next[index] = { ...state.cards[index], z: top + 1 };
        return { ...state, cards: next, selectedId: id };
      });
    },

    select(id) {
      set({ selectedId: id });
    },

    // ── matrix card behaviour ─────────────────────────────────────────

    setActiveSource(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return;
      if (index < 0 || index >= card.sources.length || index === card.activeSource) return;
      const nextActiveMatrixId = card.sources[index].matrixId;

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isMatrixCard(c) ? { ...c, activeSource: index } : c,
        ),
      });

      // The 摘要 panel describes the ACTIVE file. A node reads one fixed matrix, so the
      // panel's node is released and the panel asks again — keeping it would summarise the
      // file the card no longer shows. (Switching file releases no matrix, so nothing here
      // needs the node's deletion to be awaited.)
      void summarySourceChanged(cardId);

      // Charts that read this card must pick up the new file's data.
      refreshDependentsOf(cardId);

      // Switching the file IS switching what this card holds (2026-11-17, correcting the
      // earlier "view change" reading): every function card that reads this table follows it
      // to the file it now shows, exactly like a replaced file. Charts already follow above;
      // a reader bound to another slot would leave the card and its input describing two
      // different files, which is the state this rule exists to prevent. The binding edit is
      // explicit here (not a hidden edit of the card), and the push makes the formula card
      // recompute / the armed script rerun; an unarmed script goes dirty and waits.
      const oldToNew = new Map<number, number>();
      for (const source of card.sources) {
        if (source.matrixId !== nextActiveMatrixId) {
          oldToNew.set(source.matrixId, nextActiveMatrixId);
        }
      }
      const readers = repointReadersOf(cardId, oldToNew);
      for (const readerId of readers) void syncFunctionCard(readerId);
    },

    editCell(cardId, row, col, value) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return;
      const source = card.sources[card.activeSource];
      if (!source) return;
      const matrix = state.matrices.get(source.matrixId);
      if (!matrix) return;
      matrix.setCell(row, col, value);
      // Mutating in place is intentional: MatrixData is a mutable model and charts read
      // from it directly. The store reference does not change, so React won't re-render
      // the table — but VirtualTable reads cell values on each render cycle triggered by
      // scroll or other interactions. For an immediate visual update we bump the card.
      set({
        cards: state.cards.map((c) =>
          c.id === cardId ? { ...c } : c,
        ),
      });
      refreshDependentsOf(cardId);

      // The backend holds the authoritative copy, so an edit must reach it.
      // Fire-and-forget like registration — editing never blocks on the network; only a
      // genuinely unreachable backend flips the banner.
      const backendId = backendMatrixIds.get(source.matrixId);
      if (backendId !== undefined) {
        void backendClient.patchCells(backendId, [{ row, col, value }]).then((result) => {
          if (!result.ok && result.code === 'backendUnavailable') {
            set({ backend: { state: 'offline', error: result.code } });
          }
        });
      }
    },

    setEditable(cardId, editable) {
      set((state) => ({
        cards: state.cards.map((c) =>
          c.id === cardId && isMatrixCard(c) ? { ...c, readOnly: !editable } : c,
        ),
      }));
    },

    // ── chart card behaviour ──────────────────────────────────────────

    setSmoothing(cardId, options) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card) ? { ...card, smoothing: options } : card,
        ),
      }));
    },

    setChartType(cardId, type) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;

      // Switching to a type that consumes more columns may require growing the source
      // list: pull further columns from the same matrix so the chart can draw at once.
      const def = chartTypeDef(type);
      const needed = Math.max(def.defaultColumnCount, minimumColumns(type));
      let sources = card.config.sources.slice();

      if (sources.length < needed) {
        const owner = state.cards.find(
          (c) =>
            isMatrixCard(c) &&
            c.sources.some((s) => s.matrixId === sources[0]?.matrixId),
        );
        if (owner && isMatrixCard(owner)) {
          const matrixId = sources[0]?.matrixId ?? owner.sources[owner.activeSource]?.matrixId;
          const matrix = matrixId !== undefined ? state.matrices.get(matrixId) : undefined;
          if (matrix) {
            // Continue from the columns already attached rather than restarting at 0:
            // for a `pairs` type the first source is the X axis, so pulling column 0 in
            // would silently make an unrelated column the Y of a chart the user built
            // from column 5.
            const used = new Set(sources.map((source) => source.columnIndex));
            const anchor = Math.min(...used);
            const append = (index: number) => {
              const column = matrix.column(index);
              sources.push({
                matrixId,
                columnIndex: index,
                label: columnLabel(column),
                raw: column.data.slice(),
              });
            };
            for (let index = anchor; index < matrix.columnCount() && sources.length < needed; ++index) {
              if (!used.has(index)) append(index);
            }
            // Only if the matrix ends before the requirement is met do we wrap around.
            for (let index = 0; index < anchor && sources.length < needed; ++index) {
              if (!used.has(index)) append(index);
            }
          }
        }
      }

      commitChartConfig(cardId, (config) => ({ ...config, type, sources }));
    },

    setChartConfig(cardId, patch) {
      commitChartConfig(cardId, (config) => ({ ...config, ...patch }));
    },

    addChartSource(cardId, matrixId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;
      // Never attach the same column twice.
      if (
        card.config.sources.some(
          (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
        )
      ) {
        return;
      }
      const matrix = state.matrices.get(matrixId);
      if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return;

      // The owner edge (chart → data or function card) is derived by commitChartConfig
      // from the new source list, so a cycle is refused there and nothing is attached.
      const column = matrix.column(columnIndex);
      const source: ChartSource = {
        matrixId,
        columnIndex,
        label: columnLabel(column),
        raw: column.data.slice(),
      };
      commitChartConfig(cardId, (config) => ({
        ...config,
        sources: [...config.sources, source],
      }));
    },

    removeChartSource(cardId, matrixId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;

      const sources = card.config.sources.filter(
        (source) => !(source.matrixId === matrixId && source.columnIndex === columnIndex),
      );
      // A chart with no columns has nothing to draw; keep at least one. Also refuse to
      // drop below what the *current type* needs: silently degrading a scatter to
      // "needs at least 2 columns" destroys work the user cannot undo.
      const floor = Math.max(1, minimumColumns(card.config.type));
      if (sources.length < floor) return;
      // The X axis may have pointed at the column just removed.
      const xAxisSource =
        card.config.xAxisSource &&
        card.config.xAxisSource.matrixId === matrixId &&
        card.config.xAxisSource.columnIndex === columnIndex
          ? null
          : card.config.xAxisSource;

      // The card-level edge disappears on its own when the recomputed inputs no longer
      // mention that owner — commitChartConfig diffs the owner set.
      commitChartConfig(cardId, (config) => ({ ...config, sources, xAxisSource }));
    },

    setChartColumnPanel(cardId, open) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card) ? { ...card, columnPanelOpen: open } : card,
        ),
      }));
    },

    setFunctionPanelOpen(cardId, panel, open) {
      set((state) => ({
        cards: state.cards.map((card) => {
          if (card.id !== cardId || !isFormulaCard(card)) return card;
          return {
            ...card,
            ...(panel === 'inputs' ? { inputsPanelOpen: open } : { outputsPanelOpen: open }),
          };
        }),
      }));
    },

    setScriptAutoRun(cardId, on) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isFormulaCard(card) ? { ...card, autoRun: on } : card,
        ),
      }));
      // Turning it back on is an explicit request: if the node is already waiting, run now.
      if (on) maybeAutoRunScript(cardId);
    },

    // ── workspace trust (2026-11-17) ───────────────────────────────────

    beginWorkspaceTrust(hash, restoredScriptIds) {
      const epoch = workspaceEpoch;
      set({ trust: { ...initialTrust(), hash, restoredScriptIds, loading: true } });
      void (async () => {
        const status = await backendClient.trustStatus();
        if (epoch !== workspaceEpoch) return;
        if (!status) {
          // An unreachable trust service is NOT permission: stay untrusted and say so.
          set((state) => ({
            trust: { ...state.trust, loading: false, error: 'backendUnavailable' },
          }));
          return;
        }
        const lookup = await backendClient.trustLookup(hash);
        if (epoch !== workspaceEpoch) return;
        set((state) => ({
          trust: {
            ...state.trust,
            persistence: status.persistence,
            location: status.location === '' ? null : status.location,
            envChanged: status.envChanged,
            confirmed:
              lookup && lookup.known
                ? lookup.scripts.map(Number).filter((id) => Number.isFinite(id))
                : [],
            loading: false,
            error: null,
          },
        }));
        // The restore's pushes were dropped while this lookup was in flight.
        resumeAutoRuns();
      })();
    },

    recordSavedWorkspace(hash, scriptIds) {
      const state = get();
      set({
        trust: {
          ...state.trust,
          hash,
          restoredScriptIds: scriptIds,
          confirmed: [...new Set([...state.trust.confirmed, ...scriptIds])],
        },
      });
      // Persist only after the user has decided to keep records; before that the save is
      // still trusted for this session, it just has nowhere to be written.
      if (state.trust.persistence === 'persistent' && scriptIds.length > 0) {
        void backendClient.trustRecord(hash, scriptIds.map(String));
      }
      resumeAutoRuns();
    },

    setTrustPersistence(persist) {
      const epoch = workspaceEpoch;
      const hash = get().trust.hash;
      void (async () => {
        let status = await backendClient.trustDecidePersistence(persist);
        if (!status && persist) {
          // Persistence was requested but cannot be provided (read-only install, foreign
          // environment): fall back to session-only instead of staying undecided, which
          // would keep every script unconfirmed forever.
          status = await backendClient.trustDecidePersistence(false);
        }
        if (epoch !== workspaceEpoch) return;
        set((state) => ({
          trust: {
            ...state.trust,
            persistence: status ? status.persistence : 'unavailable',
            location: status && status.location !== '' ? status.location : null,
            envChanged: status ? status.envChanged : false,
            error: status ? null : 'backendUnavailable',
          },
        }));
        if (hash === null) return;
        const lookup = await backendClient.trustLookup(hash);
        if (epoch !== workspaceEpoch || !lookup) return;
        set((state) => ({
          trust: {
            ...state.trust,
            confirmed: lookup.known
              ? lookup.scripts.map(Number).filter((id) => Number.isFinite(id))
              : [],
          },
        }));
        resumeAutoRuns();
      })();
    },

    confirmTrustedScript(cardId) {
      const state = get();
      const hash = state.trust.hash;
      if (hash === null) return;
      if (state.trust.confirmed.includes(cardId)) return;
      set({ trust: { ...state.trust, confirmed: [...state.trust.confirmed, cardId] } });
      void backendClient.trustRecord(hash, [String(cardId)]);
      // Confirming is a gate opening for this card: an armed one should catch up now.
      maybeAutoRunScript(cardId);
    },

    confirmAllTrustedScripts() {
      const state = get();
      const hash = state.trust.hash;
      if (hash === null) return;
      const remaining = state.trust.restoredScriptIds.filter(
        (id) => !state.trust.confirmed.includes(id),
      );
      if (remaining.length === 0) return;
      set({
        trust: { ...state.trust, confirmed: [...state.trust.confirmed, ...remaining] },
      });
      void backendClient.trustRecord(hash, remaining.map(String));
      resumeAutoRuns();
    },

    revokeWorkspaceTrust() {
      const state = get();
      const hash = state.trust.hash;
      if (hash === null) return;
      set({ trust: { ...state.trust, confirmed: [] } });
      void backendClient.trustRevoke(hash);
    },

    // ── function card behaviour ───────────────────────────────────────

    addFormulaCard(sourceCardId, matrixId) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      // A table or a function card's output can both feed a function card: the result of
      // one card is an ordinary matrix, which is what makes chains (A → B → C) a graph
      // rather than a fan-out from the tables. The backend already treats result matrices
      // as mid-edges, so a chain recomputes in one pass.
      if (!sourceCard || isChartCard(sourceCard)) return null;
      // v2: the reference is ONE explicit matrix. Without an explicit id the card captures
      // what the source shows right now — and keeps reading it afterwards.
      const targetMatrixId =
        matrixId ?? (isMatrixCard(sourceCard) ? sourceCard.sources[sourceCard.activeSource]?.matrixId : undefined) ??
        (isFormulaCard(sourceCard) ? sourceCard.displayMatrixId : undefined);
      if (targetMatrixId === undefined) return null;
      // A function card owns its display cache AND every declared output's own slot, so a
      // chained card can read `out:1` exactly like it reads the primary table. Written over
      // `outputs[]` rather than "the display matrix", which is what makes K > 1 usable
      // without a second kind of edge.
      const ownedMatrixIds = isMatrixCard(sourceCard)
        ? sourceCard.sources.map((entry) => entry.matrixId)
        : [
            sourceCard.displayMatrixId,
            ...sourceCard.outputs
              .map((output) => output.localMatrixId)
              .filter((id): id is number => typeof id === 'number'),
          ];
      if (!ownedMatrixIds.includes(targetMatrixId)) return null;
      const sourceMatrix = state.matrices.get(targetMatrixId);
      if (!sourceMatrix) return null;

      const cardId = state.nextCardId;
      const displayMatrixId = state.nextMatrixId;

      // Start with one expression referencing the first column. The identifier must be
      // the label the backend resolves against — annotation when present, else Pos.N — not
      // the raw posName: `Pos.1 * 2` fails on a table whose first column is annotated `A`.
      const firstColLabel =
        sourceMatrix.columnCount() > 0 ? sourceColumnLabel(sourceMatrix.column(0)) : 'A';
      // The label is what the user reads; the reference is what the engine can parse. They
      // differ for names containing `/` or spaces — the default must be a working formula,
      // not a demonstration of the failure.
      const firstColReference =
        sourceMatrix.columnCount() > 0 ? formulaReference(sourceMatrix.column(0)) : 'A';
      const formulas = [{ name: `${firstColLabel} × 2`, expression: `${firstColReference} * 2` }];

      // The display cache starts EMPTY. It is filled only once the backend reports the node
      // `done` and we pull its result window — the browser computes nothing
      // (docs/decisions/2026-10-17-backend-owns-compute.md).
      const matrices = new Map(state.matrices);
      matrices.set(displayMatrixId, new MatrixData());

      // Roomy on purpose: the three-zone card is the thing users cannot find their way
      // around, and at 520×380 the formula rows, the result grid and the help affordances
      // fought over ~350 px of body. 640×480 also gives the 可用列 rail a second column.
      // Three columns need more room than the old two-column card: the result grid must
      // keep a readable width between the two declaration columns.
      const formulaSize = { width: 760, height: 520 };
      const formulaSpot = placeOnPlane(
        { x: sourceCard.x + 40, y: sourceCard.y + sourceCard.height + 32 },
        formulaSize,
        state.cards,
      );
      const inputs: PortConnection[] = [
        {
          portId: INPUT_PORT_SOURCE,
          target: { type: 'matrix', cardId: sourceCardId, matrixId: targetMatrixId },
        },
      ];
      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...formulaSpot,
        width: formulaSize.width,
        height: formulaSize.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: EXPRESSION_COLUMNS_SIGNATURE,
        params: { formulas },
        outputs: [{ outputId: 'result', resultMatrixId: -1 }],
        node: null,
        result: null,
        displayMatrixId,
      };

      const cycle = state.dependencies.addDependency(
        cardId,
        sourceCardId,
        inputs.map((input) => input.portId),
      );
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }

      set({
        cards: [...state.cards, card],
        matrices,
        nextCardId: cardId + 1,
        nextMatrixId: displayMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...formulaSpot, ...formulaSize });

      void syncFunctionCard(cardId);
      return cardId;
    },

    setFormula(cardId, index, name, expression) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;

      const formulas = (card.params.formulas ?? []).slice();
      if (index >= 0 && index < formulas.length) {
        // The expression editor owns `name` + `expression` only. Rebuilding the row from
        // those two used to be indistinguishable from the row itself; since units L1a a row
        // also carries the user's explicit OUTPUT `unit`, which this edit must not drop —
        // an unrelated keystroke is not a reason to withdraw an assertion.
        const current = formulas[index];
        formulas[index] =
          current.unit === undefined
            ? { name, expression }
            : { name, expression, unit: current.unit };
      } else {
        formulas.push({ name, expression });
      }

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, params: { ...c.params, formulas } }
            : c,
        ),
      });

      // One card = one node, so an edit is ONE PATCH (v1 needed one per column, and each
      // of those re-evaluated the same input). Results arrive on the event stream.
      void syncFunctionCard(cardId);
    },

    removeFormula(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const current = card.params.formulas ?? [];
      if (current.length <= 1) return; // keep at least one

      const formulas = current.filter((_, i) => i !== index);

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, params: { ...c.params, formulas } }
            : c,
        ),
      });

      // No node to release: the node stays, it simply computes fewer columns next time.
      void syncFunctionCard(cardId);
    },

    addRelationEnumCard(sourceCardId, columnIndex) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      if (!sourceCard || isChartCard(sourceCard)) return null;
      const matrixId = chartSourceMatrixId(sourceCard);
      if (matrixId === null) return null;
      const matrix = state.matrices.get(matrixId);
      if (!matrix) return null;
      // A relation needs two columns to relate. The clicked column is `x`; `y` is its
      // neighbour (previous one at the right edge) — the card's own port selectors then
      // take over, so this default is a starting point rather than a rule.
      if (matrix.columnCount() < 2) return null;
      if (columnIndex < 0 || columnIndex >= matrix.columnCount()) return null;
      const yIndex = columnIndex + 1 < matrix.columnCount() ? columnIndex + 1 : columnIndex - 1;

      const inputs: PortConnection[] = [
        {
          portId: REGRESSION_PORT_X,
          target: { type: 'cell', cardId: sourceCardId, matrixId, column: columnIndex },
        },
        {
          portId: REGRESSION_PORT_Y,
          target: { type: 'cell', cardId: sourceCardId, matrixId, column: yIndex },
        },
      ];
      const cardId = state.nextCardId;
      const size = { width: 480, height: 320 };
      const spot = placeOnPlane(
        { x: sourceCard.x + sourceCard.width + 32, y: sourceCard.y + 40 },
        size,
        state.cards,
      );
      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...spot,
        width: size.width,
        height: size.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: REGRESSION_SIGNATURE,
        // Payload-free params: a regression has no expressions, which is exactly the case
        // the card UI must handle without showing a formula editor.
        params: {},
        outputs: [{ outputId: 'fit', resultMatrixId: -1 }],
        node: null,
        result: null,
        displayMatrixId: state.nextMatrixId,
      };
      const cycle = state.dependencies.addDependency(
        cardId,
        sourceCardId,
        inputs.map((input) => input.portId),
      );
      if (cycle) {
        // A regression reads two columns of its source, so the edge is the same shape as an
        // expression card's — and a refused edge must not leave a card with no dependency.
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }
      set({
        cards: [...state.cards, card],
        dependencies: state.dependencies,
        nextCardId: cardId + 1,
        nextMatrixId: state.nextMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...spot, ...size });
      void syncFunctionCard(cardId);
      return cardId;
    },

    addUnitConvertCard(sourceCardId, matrixId) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      if (!sourceCard || isChartCard(sourceCard)) return null;
      // v2: the reference is ONE explicit matrix — the caller may name an output, otherwise
      // the card captures what the source shows right now and keeps reading it.
      const targetMatrixId =
        matrixId ??
        (isMatrixCard(sourceCard)
          ? sourceCard.sources[sourceCard.activeSource]?.matrixId
          : undefined) ??
        (isFormulaCard(sourceCard) ? sourceCard.displayMatrixId : undefined);
      if (targetMatrixId === undefined) return null;
      const owned = isMatrixCard(sourceCard)
        ? sourceCard.sources.map((entry) => entry.matrixId)
        : [
            sourceCard.displayMatrixId,
            ...sourceCard.outputs
              .map((output) => output.localMatrixId)
              .filter((id): id is number => typeof id === 'number'),
          ];
      if (!owned.includes(targetMatrixId)) return null;
      const matrix = state.matrices.get(targetMatrixId);
      if (!matrix) return null;

      const cardId = state.nextCardId;
      const displayMatrixId = state.nextMatrixId;
      const inputs: PortConnection[] = [
        {
          portId: INPUT_PORT_SOURCE,
          target: { type: 'matrix', cardId: sourceCardId, matrixId: targetMatrixId },
        },
      ];
      // Roomy: the picker lists one row per input column (name + source unit + target).
      const size = { width: 560, height: 460 };
      const spot = placeOnPlane(
        { x: sourceCard.x + sourceCard.width + 32, y: sourceCard.y + 40 },
        size,
        state.cards,
      );
      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...spot,
        width: size.width,
        height: size.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: UNIT_CONVERT_SIGNATURE,
        // No column is converted until the user says so: `targets: []` is the whole
        // declaration, and the backend answers it with `badSignatureParams` rather than
        // copying the table on its own.
        params: { targets: [] },
        outputs: [{ outputId: 'result', resultMatrixId: -1 }],
        node: null,
        result: null,
        // The display cache starts EMPTY (the browser computes nothing).
        displayMatrixId,
      };

      const cycle = state.dependencies.addDependency(
        cardId,
        sourceCardId,
        inputs.map((input) => input.portId),
      );
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }
      const matrices = new Map(state.matrices);
      matrices.set(displayMatrixId, new MatrixData());
      set({
        cards: [...state.cards, card],
        matrices,
        dependencies: state.dependencies,
        nextCardId: cardId + 1,
        nextMatrixId: displayMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...spot, ...size });
      // Binds the node (born dirty/notRequested: explicitCompute) — never computes.
      void syncFunctionCard(cardId);
      return cardId;
    },

    setPortColumn(cardId, portId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const input = card.inputs.find((entry) => entry.portId === portId);
      if (!input || input.target.type !== 'cell') return;
      const matrix = state.matrices.get(input.target.matrixId);
      if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return;
      if (input.target.column === columnIndex) return;

      // Only the column changes: same card, same node, same edge. The column is a BINDING
      // (data flow), never a parameter — `params` stays empty for this signature.
      const inputs = card.inputs.map((entry): PortConnection => {
        if (entry.portId !== portId || entry.target.type !== 'cell') return entry;
        return {
          ...entry,
          target: {
            type: 'cell',
            cardId: entry.target.cardId,
            matrixId: entry.target.matrixId,
            column: columnIndex,
          },
        };
      });
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId ? { ...entry, inputs } : entry,
        ),
      });
      void syncFunctionCard(cardId);
    },

    refreshDependentsOf(cardId) {
      refreshDependentsOf(cardId);
    },

    loadFullResult(cardId) {
      void loadFullResultIntoCache(cardId);
    },

    recomputeFormula(cardId) {
      // "Recompute" means "re-send the parameters + binding to the backend"; the browser
      // never evaluates. The binding is the card's explicit matrix — it does not drift with
      // the table's active file (that is now an explicit re-point).
      void syncFunctionCard(cardId);
    },

    renameOutputColumn(cardId, index, name) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      // Only expression-shaped signatures name their columns positionally; a signature
      // that fixes its own output names has nothing to rename.
      const formulas = card.params.formulas?.slice();
      if (!formulas) return;
      if (index < 0 || index >= formulas.length) return;
      const current = formulas[index];
      if (current.name === name) return;
      formulas[index] = { ...current, name };
      // Naming a column IS the moment the output's width becomes a promise: the mapping is
      // position-based, so a width drift would silently move a user-given label onto a
      // different column. From here on the node refuses to publish a different width.
      const columnContract = card.params.columnContract ?? {
        outputId: card.outputs[0]?.outputId ?? 'result',
        columns: formulas.length,
      };
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, formulas, columnContract } }
            : entry,
        ),
      });
      void syncFunctionCard(cardId);
    },

    setColumnContract(cardId, columns) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const params: FunctionCardModel['params'] = { ...card.params };
      if (columns === null) {
        delete params.columnContract;
      } else {
        params.columnContract = {
          outputId: card.outputs[0]?.outputId ?? 'result',
          columns,
        };
      }
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry) ? { ...entry, params } : entry,
        ),
      });
      void syncFunctionCard(cardId);
    },

    // ── column units v1 ───────────────────────────────────────────────

    confirmUnitGroup(matrixId, token, unit) {
      const state = get();
      const matrix = state.matrices.get(matrixId);
      if (!matrix) return 0;
      // Only a registered unit (or an explicit "no unit") may be remembered; anything else
      // would invent a unit the convert card could not act on.
      if (unit !== NO_UNIT && !candidateByUnit(unit)) return 0;
      const annotations = matrix.columns().map((col) => col.annotation);
      const signature = unitSignature(annotations);
      const target = normalizeUnitToken(token).toLowerCase();
      const existing = state.unitConfirmations[signature] ?? {};
      const affected: number[] = [];
      annotations.forEach((annotation, index) => {
        // Read the CONFIRMED resolution: a column that already carries an answer is no
        // longer "un-asked", so a repeated group confirm touches nothing (idempotent).
        const resolution = resolveConfirmed(annotation, existing[index]);
        if (
          resolution.state === 'ambiguous' &&
          normalizeUnitToken(resolution.token).toLowerCase() === target
        ) {
          affected.push(index);
        }
      });
      if (affected.length === 0) return 0;
      const next = { ...existing };
      for (const index of affected) next[index] = unit;
      set({ unitConfirmations: { ...state.unitConfirmations, [signature]: next } });
      return affected.length;
    },

    setColumnUnit(matrixId, columnIndex, unit) {
      const state = get();
      const matrix = state.matrices.get(matrixId);
      if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return;
      if (unit !== NO_UNIT && !candidateByUnit(unit)) return;
      const signature = unitSignature(matrix.columns().map((col) => col.annotation));
      const next = { ...(state.unitConfirmations[signature] ?? {}), [columnIndex]: unit };
      set({ unitConfirmations: { ...state.unitConfirmations, [signature]: next } });
    },

    setUnitPolicyOverride(policy) {
      // `null` clears the override (back to inheriting the global tier). The field is
      // REMOVED rather than set to `undefined` so a saved file never carries a dead key —
      // `JSON.stringify` would drop it anyway, but an in-memory `{unitPolicyOverride:
      // undefined}` makes `'unitPolicyOverride' in snapshot` answer yes about nothing.
      const state = get();
      if ((state.unitPolicyOverride ?? null) === (policy ?? null)) return;
      // `set` merges, so "clear" has to carry the key explicitly as `undefined`: spreading the
      // whole state back would re-add the very key being removed.
      set({ unitPolicyOverride: policy === null ? undefined : policy });
    },

    addUnitConstant(token, constant) {
      // The token is stored as the resolver spells it (trimmed), because it is looked up by
      // `base.token` — the exact text the header carries. A definition that would make the
      // resolver act on nothing (empty dimension, a zero/negative/NaN factor) is refused:
      // inventing a factor is exactly the guessing this whole layer exists to avoid.
      const key = token.trim();
      if (key === '') return false;
      const dimension = constant.dimension.trim();
      if (dimension === '') return false;
      if (!Number.isFinite(constant.factor) || constant.factor <= 0) return false;
      set((state) => ({ unitConstants: { ...state.unitConstants, [key]: { dimension, factor: constant.factor } } }));
      return true;
    },

    removeUnitConstant(token) {
      const key = token.trim();
      set((state) => {
        if (!(key in state.unitConstants)) return state;
        const next = { ...state.unitConstants };
        delete next[key];
        return { unitConstants: next };
      });
    },

    setFormulaUnit(cardId, index, unit) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const formulas = card.params.formulas?.slice();
      if (!formulas || index < 0 || index >= formulas.length) return;
      // An assertion must name a registered unit; `''` withdraws it. Anything else is a
      // typo the resolver could not act on, so it is refused instead of stored.
      const next = unit.trim();
      if (next !== '' && !candidateByUnit(next)) return;
      const current = formulas[index];
      if ((current.unit ?? '') === next) return;
      formulas[index] = next === '' ? { name: current.name, expression: current.expression } : { ...current, unit: next };
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, formulas } }
            : entry,
        ),
      });
      // The assertion is a card parameter, but it does not change a single number: the node
      // is NOT pushed (the backend never reads `formulas[].unit`). What does change is the
      // label of the output table, so the existing cache is re-asserted immediately — the
      // user must see the unit on the result without waiting for a recompute.
      assertFormulaUnits(cardId);
    },

    // ── summary panel (`builtin:summary`) ─────────────────────────────

    summaries: {},

    setSummaryOpen(cardId, open) {
      patchSummary(cardId, { open });
    },

    toggleSummaryStat(cardId, stat) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || (!isMatrixCard(card) && !isFormulaCard(card))) return;
      const entry = state.summaries[cardId] ?? emptySummaryEntry();
      const selected = new Set(entry.stats);
      if (selected.has(stat)) {
        // Never send an empty `stats`: the backend answers `badSignatureParams`, and "no
        // rows" is not a state this panel has. One statistic always stays selected.
        if (selected.size <= 1) return;
        selected.delete(stat);
      } else {
        selected.add(stat);
      }
      // Catalog order, whatever order the checkboxes were clicked in.
      const stats = canonicalSummaryStats([...selected]);
      patchSummary(cardId, { stats });
      if (entry.nodeId === null) return;
      // The parameters belong to the node (they are the signature's, not the card's), so a
      // new subset is a definition change: one PATCH, which the backend answers with
      // `dirty` — the panel then says 参数已改 until the user asks for a recompute.
      const nodeId = entry.nodeId;
      void backendClient.patchNode(nodeId, { params: summaryParams(stats) }).then((result) => {
        if (!result.ok) {
          if (result.code === 'backendUnavailable') {
            set({ backend: { state: 'offline', error: result.code } });
          } else {
            patchSummary(cardId, {
              status: 'error',
              code: result.code ?? 'internalError',
              result: null,
            });
          }
          return;
        }
        patchSummary(cardId, { status: 'dirty', reason: 'definitionChanged', result: null });
      });
    },

    computeSummary(cardId) {
      void (async () => {
        const state = get();
        const card = state.cards.find((c) => c.id === cardId);
        if (!card || (!isMatrixCard(card) && !isFormulaCard(card))) return;
        const source = summarySourceOf(card);
        if (!source) return;
        // One compute per card at a time: two overlapping clicks both saw `nodeId === null`
        // would create two nodes, and the loser is orphaned server-side.
        if (summaryComputing.has(cardId)) return;
        summaryComputing.add(cardId);
        const epoch = workspaceEpoch;
        const entry = state.summaries[cardId] ?? emptySummaryEntry();
        // In-flight marker, same name the backend publishes, so the yellow bar is honest
        // while the request is on the wire (the evaluation itself is synchronous there).
        patchSummary(cardId, { status: 'computing', reason: undefined, code: undefined });
        try {
          // The panel sums a table the SERVER holds. A data card's file is normally
          // uploaded when it loads; this awaits that upload (or starts it) so a click that
          // beats the upload — or a reconnect — still works instead of doing nothing.
          let serverMatrixId = source.serverMatrixId;
          if (serverMatrixId === null) {
            const matrix = state.matrices.get(source.localMatrixId);
            if (matrix) {
              serverMatrixId = await registerUploadedMatrix(
                source.localMatrixId,
                source.name,
                matrix,
              );
            }
          }
          if (serverMatrixId === null) {
            // Nothing authoritative to bind to (offline, or a function card with no result
            // yet). Stay 未请求 rather than pretending a compute happened.
            patchSummary(cardId, { status: 'idle', reason: undefined, result: null });
            return;
          }

          // One node per card: reuse it unless the data underneath the panel changed (a
          // node reads exactly one matrix, so a different source is a different request).
          let nodeId = entry.nodeId;
          if (nodeId !== null && entry.boundMatrixId !== source.localMatrixId) {
            void releaseSummaryNode(cardId);
            nodeId = null;
          }
          if (nodeId === null) {
            const created = await backendClient.createNode(
              [
                {
                  portId: SOURCE_PORT,
                  varName: SOURCE_PORT,
                  mode: 'matrix',
                  sourceMatrixId: serverMatrixId,
                },
              ],
              { signatureId: SUMMARY_SIGNATURE, params: summaryParams(entry.stats) },
            );
            if (!created.ok || created.nodeId === undefined) {
              if (created.code === 'backendUnavailable') {
                set({ backend: { state: 'offline', error: created.code } });
                patchSummary(cardId, { status: 'idle' });
              } else {
                patchSummary(cardId, {
                  status: 'error',
                  code: created.code ?? 'internalError',
                  result: null,
                });
              }
              return;
            }
            nodeId = created.nodeId;
            // The source (or the whole workspace) can change while the POST is in flight;
            // a node bound to a matrix nobody shows any more would leak server-side.
            if (epoch !== workspaceEpoch || !summaryStillCurrent(cardId, source.localMatrixId)) {
              void backendClient.deleteNode(nodeId);
              return;
            }
            patchSummary(cardId, { nodeId, boundMatrixId: source.localMatrixId });
          }

          // The one trigger (decision §四). Never a GET, never a PATCH: reading a status
          // must not spend compute.
          const computed = await backendClient.computeNode(nodeId);
          if (!computed.ok) {
            if (computed.code === 'backendUnavailable') {
              set({ backend: { state: 'offline', error: computed.code } });
              patchSummary(cardId, { status: 'idle' });
            } else {
              patchSummary(cardId, {
                status: 'error',
                code: computed.code ?? 'internalError',
                result: null,
              });
            }
            return;
          }
          if (computed.state === 'error') {
            patchSummary(cardId, {
              status: 'error',
              code: computed.code ?? 'internalError',
              result: null,
              computedAt: null,
            });
            return;
          }
          if (computed.state !== 'done') {
            // The backend declined to compute right now; mirror what it said instead of
            // inventing a table.
            patchSummary(cardId, {
              status: computed.state ?? 'dirty',
              reason: computed.reason,
              result: null,
            });
            return;
          }
          if (!summaryStillCurrent(cardId, source.localMatrixId)) return;
          const table = await fetchSummaryTable(nodeId, entry.stats);
          if (!summaryStillCurrent(cardId, source.localMatrixId)) return;
          if (!table) {
            patchSummary(cardId, { status: 'error', code: 'internalError', result: null });
            return;
          }
          patchSummary(cardId, {
            status: 'done',
            reason: undefined,
            code: undefined,
            // There is no protocol field for "computed at" (the status DTO carries none),
            // so the panel labels this as local time rather than inventing one.
            computedAt: Date.now(),
            result: table,
          });
        } finally {
          summaryComputing.delete(cardId);
        }
      })();
    },

    // ── unit conversion card (`builtin:unit-convert`) ─────────────────

    unitRuns: {},

    convertUnits(cardId, targets) {
      void (async () => {
        const state = get();
        const found = state.cards.find((c) => c.id === cardId);
        // `isFormulaCard` first: two guards narrowing the same branch to the same type leave
        // the value as `never`, so the kind check comes before the signature check.
        if (!found || !isFormulaCard(found) || !isUnitConvertCard(found)) return;
        const card = found;
        // An empty list would be a card that does nothing (and `badSignatureParams` on the
        // wire): "convert nothing" is the state the card already starts in.
        if (targets.length === 0) return;
        // One conversion per card at a time: two overlapping clicks would race their answers
        // into the same display cache, and the loser's numbers may belong to another target.
        if (unitConvertsInFlight.has(cardId)) return;
        unitConvertsInFlight.add(cardId);
        const epoch = workspaceEpoch;
        const nodeIdBefore = card.node?.nodeId ?? null;
        const params = { targets: targets.map((target) => ({ ...target })) };
        try {
          patchUnitRun(cardId, { status: 'running', code: null, params: null });
          // The declaration travels with the request: one PATCH for an existing node, or the
          // create that carries the parameters. Either way the node ends up dirty, which is
          // exactly why the compute below is still needed.
          set({
            cards: state.cards.map((entry) =>
              entry.id === cardId && isFormulaCard(entry)
                ? { ...entry, params: { ...entry.params, ...params } }
                : entry,
            ),
          });
          const bindings = portBindingsFor(card, backendMatrixIdFor);
          if (!bindings) {
            // The source table has no server id yet (still uploading, or an upstream card
            // with no result). Nothing authoritative to bind to — say so, do not compute air.
            patchUnitRun(cardId, { status: 'idle', code: 'upstreamPending', params: null });
            return;
          }
          const existingNodeId =
            card.node && card.node.nodeId > 0 ? card.node.nodeId : null;
          const pushed = existingNodeId === null
            ? await backendClient.createNode(bindings, {
                signatureId: UNIT_CONVERT_SIGNATURE,
                params,
              })
            : await backendClient.patchNode(existingNodeId, { params, inputs: bindings });
          if (!pushed.ok || pushed.nodeId === undefined) {
            if (pushed.code === 'backendUnavailable') {
              set({ backend: { state: 'offline', error: pushed.code } });
            }
            patchUnitRun(cardId, {
              status: 'error',
              code: pushed.code ?? 'internalError',
              params: null,
            });
            return;
          }
          const nodeId = pushed.nodeId;
          const stillCurrent = (): boolean =>
            workspaceEpoch === epoch &&
            useWorkspace.getState().cards.some((entry) => entry.id === cardId && isUnitConvertCard(entry));
          if (!stillCurrent()) {
            // Closed while the request was in flight: the newer intent wins, and a node we
            // created (rather than reused) would otherwise leak server-side.
            if (nodeIdBefore === null) void backendClient.deleteNode(nodeId);
            return;
          }
          const resultMatrixIds =
            pushed.resultMatrixIds ?? (pushed.resultMatrixId !== undefined ? [pushed.resultMatrixId] : []);
          applyNodeSnapshot(cardId, { nodeId, state: pushed.state ?? 'dirty' });
          if (resultMatrixIds.length > 0) {
            // A single-output signature: `result` is ordinal 0, the display matrix.
            applyScriptOutputIds(cardId, resultMatrixIds, []);
          }
          // Comparisons against the PREVIOUS declaration no longer apply: this push is the
          // declaration the node now carries, so an identical re-push must be recognised.
          lastPushedSignature.set(cardId, JSON.stringify({ params, inputs: bindings }));

          // The one trigger (decision §四). Never a GET: reading a status must not spend compute.
          const computed = await backendClient.computeNode(nodeId);
          if (!stillCurrent()) return;
          if (!computed.ok) {
            if (computed.code === 'backendUnavailable') {
              set({ backend: { state: 'offline', error: computed.code } });
              patchUnitRun(cardId, { status: 'idle', code: null, params: null });
            } else {
              const code = computed.code ?? 'internalError';
              // A refused compute answers HTTP 400 with `{code, params}`, but the client's
              // `computeNode` surfaces only the code. The node STATUS carries both, and it is
              // the same object every other error path reads — so the detail that turns a
              // code into a sentence (which column, which unit) is read there, never guessed.
              const status = await backendClient.getNode(nodeId);
              const params = status?.params ?? {};
              markNodeError(cardId, code, params);
              clearUnitConvertResult(cardId);
              patchUnitRun(cardId, { status: 'error', code, params });
            }
            return;
          }
          if (computed.resultMatrixIds && computed.resultMatrixIds.length > 0) {
            applyScriptOutputIds(cardId, computed.resultMatrixIds, []);
          }
          if (computed.state === 'error') {
            const code = computed.code ?? 'internalError';
            const detail = (computed as typeof computed & ScriptComputeAnswer).params ?? {};
            // The structured detail (`column`/`from`/`to`/`unit`/`token`) is what turns a code
            // into a sentence naming the offending column, so it lands on the node AND on the
            // card's own run state (the panel renders from the latter).
            markNodeError(cardId, code, detail);
            clearUnitConvertResult(cardId);
            patchUnitRun(cardId, { status: 'error', code, params: detail });
            return;
          }
          if (computed.state !== 'done') {
            // Cancelled or declined: back to "not computed yet" — not a failure.
            applyNodeSnapshot(cardId, { nodeId, state: computed.state ?? 'dirty' });
            clearUnitConvertResult(cardId);
            patchUnitRun(cardId, { status: 'idle', code: null, params: null });
            return;
          }
          applyNodeSnapshot(cardId, {
            nodeId,
            state: 'done',
            ...(computed.warnings !== undefined ? { warnings: computed.warnings } : {}),
          });
          // Publish: display cache first, then the lamp, so "done" is never claimed while the
          // numbers are still on the wire (the summary panel's rule, applied here).
          await pullResultIntoCache(cardId);
          if (!stillCurrent()) return;
          patchUnitRun(cardId, {
            status: 'done',
            code: null,
            params: null,
            computedAt: Date.now(),
          });
        } finally {
          unitConvertsInFlight.delete(cardId);
        }
      })();
    },

    // ── view helpers ──────────────────────────────────────────────────

    tileCards(viewportWidth, viewportHeight) {
      const state = get();
      const count = state.cards.length;
      if (count === 0) return;

      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const gap = 12;
      const pad = 12;
      const cellWidth = Math.max(MIN_CARD_WIDTH, (viewportWidth - pad * 2 - gap * (cols - 1)) / cols);
      const cellHeight = Math.max(
        MIN_CARD_HEIGHT,
        (viewportHeight - pad * 2 - gap * (rows - 1)) / rows,
      );

      // Anchor the grid to the visible rectangle: on an unbounded plane, tiling from a
      // fixed origin would rearrange the cards somewhere the user is not looking.
      const view = viewportRectInWorld();
      const cards = state.cards.map((card, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          ...card,
          x: Math.max(0, view.left) + pad + col * (cellWidth + gap),
          y: Math.max(0, view.top) + pad + row * (cellHeight + gap),
          width: cellWidth,
          height: cellHeight,
        };
      });
      set({ cards });
    },

    cascadeCards() {
      const state = get();
      const view = viewportRectInWorld();
      const originX = Math.max(0, view.left);
      const originY = Math.max(0, view.top);
      const cards = state.cards.map((card, index) => ({
        ...card,
        x: originX + 24 + index * 28,
        y: originY + 24 + index * 28,
        z: index + 1,
      }));
      set({ cards });
    },

    // ── canvas view (infinite plane) ───────────────────────────────────

    panBy(dx, dy) {
      const { view } = get();
      // Clamping lives in CardCanvas: only the DOM knows the plane and viewport sizes.
      set({ view: { x: view.x + dx, y: view.y + dy, zoom: view.zoom } });
    },

    setView(view) {
      set({ view });
    },

    resetView() {
      const { cards } = get();
      if (cards.length === 0) {
        set({ view: { x: 0, y: 0, zoom: 1 } });
        return;
      }
      // Nominal visible box, in screen px: `canvasSize()` reports plane units (Tile/Cascade
      // place cards with it), so multiply the zoom back in.
      const zoom = getCanvasZoom();
      const box = canvasSize();
      const screen = { width: box.width * zoom, height: box.height * zoom };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const card of cards) {
        minX = Math.min(minX, card.x);
        minY = Math.min(minY, card.y);
        maxX = Math.max(maxX, card.x + card.width);
        maxY = Math.max(maxY, card.y + card.height);
      }
      // Zoom-to-fit: "where did my work go" deserves an answer that actually shows the
      // work, so the fit shrinks the view when the cards span more than one screenful —
      // but never zooms in past 100%, which would look like a bug rather than a feature.
      const padding = 48;
      const fit = Math.min(
        screen.width > 0 ? screen.width / (maxX - minX + padding) : 1,
        screen.height > 0 ? screen.height / (maxY - minY + padding) : 1,
        1,
      );
      const nextZoom = Math.min(Math.max(fit, MIN_ZOOM), MAX_ZOOM);
      // Centre on the cards rather than jumping to the origin.
      set({
        view: {
          zoom: nextZoom,
          x: Math.max(0, ((minX + maxX) / 2) * nextZoom - screen.width / 2),
          y: Math.max(0, ((minY + maxY) / 2) * nextZoom - screen.height / 2),
        },
      });
    },

    // ── misc ──────────────────────────────────────────────────────────

    setLocale(locale) {
      set({ locale });
    },

    blockCard(id) {
      set((state) => ({
        blockedCardId: id,
        blockNonce: state.blockNonce + 1,
        selectedId: id,
      }));
    },

    showToast(kind, message) {
      set({ toast: { id: ++toastCounter, kind, message } });
    },

    clearToast() {
      set({ toast: null });
    },

    // ── help dialog ───────────────────────────────────────────────────

    openHelp(section) {
      // Without a section the dialog opens at the top; an explicit one scrolls there.
      set({ helpOpen: true, helpSection: section ?? null });
    },

    closeHelp() {
      set({ helpOpen: false, helpSection: null });
    },

    // ── script card (`builtin:python`) ────────────────────────────────

    scriptRuns: {},

    addScriptCard(seedRefs) {
      const state = get();
      // Birth binding, in the order the caller listed the sources: one PORT per source, its
      // injected name the next free letter. The key is the (card, matrix) pair, not the card:
      // a function card can publish several outputs and two of them are two different tables,
      // while the same table selected twice collapses — a port is a declaration, and two
      // ports on one table would just be two names for the same numbers.
      const seeds: Array<{ cardId: number; matrixId: number }> = [];
      const seen = new Set<string>();
      for (const seedRef of seedRefs) {
        const sourceId = typeof seedRef === 'number' ? seedRef : seedRef.cardId;
        const outputId = typeof seedRef === 'number' ? undefined : seedRef.outputId;
        const source = state.cards.find((entry) => entry.id === sourceId);
        if (!source) continue;
        let matrixId: number | null;
        if (outputId !== undefined && isFormulaCard(source)) {
          const index = source.outputs.findIndex((output) => output.outputId === outputId);
          // A named output the card no longer declares is a stale selection, not a reason to
          // bind output 0 behind the caller's back.
          if (index < 0) continue;
          matrixId = outputLocalMatrixId(source, index);
        } else {
          // A data card (or a bare card id) keeps its long-standing meaning: the active file.
          matrixId = chartSourceMatrixId(source);
        }
        if (matrixId === null) continue;
        const key = `${sourceId}:${matrixId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seeds.push({ cardId: sourceId, matrixId });
      }
      if (seeds.length === 0) return null;

      const cardId = state.nextCardId;
      const displayMatrixId = state.nextMatrixId;
      const inputs: PortConnection[] = seeds.map((seed, index) => ({
        // `in:N` is the port's identity for the life of the card: renaming the injected
        // variable (`A` → `x`) never touches it, so no edge is ever re-pointed by a rename.
        portId: `in:${index}`,
        target: { type: 'matrix', cardId: seed.cardId, matrixId: seed.matrixId },
      }));
      const portNames = seeds.map((_, index) => scriptPortLetter(index));

      // Roomy: a script card holds a code editor AND two declaration panels; the formula
      // card's 640×480 left the editor showing nine lines.
      const size = { width: 780, height: 640 };
      const anchor = state.cards.find((entry) => entry.id === seeds[0].cardId);
      const spot = placeOnPlane(
        {
          x: (anchor?.x ?? CARD_MARGIN) + (anchor?.width ?? 0) + 32,
          y: (anchor?.y ?? CARD_MARGIN) + 40,
        },
        size,
        state.cards,
      );

      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...spot,
        width: size.width,
        height: size.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: PYTHON_SIGNATURE,
        params: {
          script: scriptTemplate(portNames),
          portNames,
          // Output 0 exists from the moment the card does: an edge to `out:0` is legal
          // before the first run (decision §三, "声明即存在").
          outputs: ['result'],
        },
        outputs: [{ outputId: 'out:0', resultMatrixId: -1 }],
        node: null,
        result: null,
        // The display cache starts EMPTY: only a run fills it (the backend computes).
        displayMatrixId,
      };

      // One edge per SOURCE card (two ports on one table = one edge, two ports), through the
      // ordinary graph: close protection, cycle detection and the connection layer come free.
      const portsBySource = new Map<number, string[]>();
      for (const input of inputs) {
        const ports = portsBySource.get(input.target.cardId) ?? [];
        ports.push(input.portId);
        portsBySource.set(input.target.cardId, ports);
      }
      for (const [sourceId, ports] of portsBySource) {
        const cycle = state.dependencies.addDependency(cardId, sourceId, ports);
        if (cycle) {
          // A refused edge must not leave a half-wired card behind: the edges already
          // accepted for THIS card go back out, and the card is never added.
          state.dependencies.removeAllDependencies(cardId);
          get().showToast(
            'error',
            translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
          );
          return null;
        }
      }

      const matrices = new Map(state.matrices);
      matrices.set(displayMatrixId, new MatrixData());
      set({
        cards: [...state.cards, card],
        matrices,
        dependencies: state.dependencies,
        nextCardId: cardId + 1,
        nextMatrixId: displayMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...spot, ...size });
      // The SAME node-sync path every function card uses: the card's parameters are already
      // the wire shape (that is why `portNames` is an array), so no signature-specific push
      // is needed. An `explicitCompute` signature is born dirty/notRequested — creating a
      // script card runs nobody's code.
      void syncFunctionCard(cardId);
      return cardId;
    },

    setScriptText(cardId, script) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card)) return;
      if (scriptParams(card).script === script) return;
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, script } }
            : entry,
        ),
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
    },

    renameScriptPort(cardId, portId, varName) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card)) return { ok: false, error: { code: 'notFound' } };
      const index = card.inputs.findIndex((input) => input.portId === portId);
      if (index < 0) return { ok: false, error: { code: 'notFound' } };

      const params = scriptParams(card);
      const portNames = [...params.portNames];
      // A saved snapshot predating this card's last port can leave the declaration short;
      // fill from the port ids so the array stays indexable by `inputs[]`.
      while (portNames.length < card.inputs.length) {
        portNames.push(card.inputs[portNames.length].portId);
      }
      const current = portNames[index];
      if (current === varName) return { ok: true, warning: null, replaced: 0 };

      const check = checkScriptName({
        name: varName,
        panel: 'port',
        portNames: portNames.filter((_, position) => position !== index),
        outputNames: params.outputs,
      });
      if (check.error) return { ok: false, error: check.error };

      portNames[index] = varName;
      const script = renameInScript(params.script, current, varName);
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, script, portNames } }
            : entry,
        ),
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
      return { ok: true, warning: check.warning, replaced: countScriptOccurrences(params.script, current) };
    },

    renameScriptOutput(cardId, outputId, name) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card)) return { ok: false, error: { code: 'notFound' } };
      const ordinal = card.outputs.findIndex((output) => output.outputId === outputId);
      if (ordinal < 0) return { ok: false, error: { code: 'notFound' } };

      const params = scriptParams(card);
      const outputs = [...params.outputs];
      while (outputs.length < card.outputs.length) outputs.push('');
      const current = outputs[ordinal];
      if (current === name) return { ok: true, warning: null, replaced: 0 };

      const check = checkScriptName({
        name,
        panel: 'output',
        portNames: params.portNames,
        outputNames: outputs.filter((_, position) => position !== ordinal),
      });
      if (check.error) return { ok: false, error: check.error };

      // Rename = rewrite the identifier in the script + the declaration. `outputs[].outputId`
      // is NOT touched: every dependent edge binds `out:N`, so no line can be left dangling
      // by a rename — only its label changes.
      outputs[ordinal] = name;
      const script = renameInScript(params.script, current, name);
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, script, outputs } }
            : entry,
        ),
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
      return {
        ok: true,
        warning: check.warning,
        replaced: current.length > 0 ? countScriptOccurrences(params.script, current) : 0,
      };
    },

    addScriptOutput(cardId) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card)) return null;

      const params = scriptParams(card);
      const name = nextScriptOutputName([...params.portNames, ...params.outputs]);
      const outputId = nextOutputId(card.outputs);
      // A slot of its own, so `out:N` is something a dependent can actually reference (the
      // local→server lookup in `backendMatrixIdFor` resolves it like any other output).
      const localMatrixId = state.nextMatrixId;
      const matrices = new Map(state.matrices);
      matrices.set(localMatrixId, new MatrixData());
      const outputs: OutputBinding[] = [
        ...card.outputs,
        { outputId, resultMatrixId: -1, localMatrixId },
      ];
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? {
                ...entry,
                outputs,
                params: {
                  ...entry.params,
                  outputs: [...params.outputs, name],
                  // Declared but unassigned is a run failure (`missingOutput`), so the new
                  // line is a comment pointing at the next step — never silent code.
                  script: `${params.script.replace(/\n*$/, '\n')}\n# assign ${name} to publish this table\n`,
                },
              }
            : entry,
        ),
        matrices,
        nextMatrixId: localMatrixId + 1,
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
      return outputId;
    },

    removeScriptOutput(cardId, outputId) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card)) return { ok: false, code: 'notFound' };
      const ordinal = card.outputs.findIndex((output) => output.outputId === outputId);
      if (ordinal < 0) return { ok: false, code: 'notFound' };
      if (ordinal === 0) {
        // Output 0 is the card's display matrix: every chart and every chained card built
        // before K > 1 points at that slot, so removing it is not a declaration edit but a
        // re-pointing of edges nobody asked to move.
        get().blockCard(cardId);
        return { ok: false, code: 'displayOutput' };
      }

      // The existing protection mechanism, reused: a dependent reads a MATRIX. Refuse while
      // one still points at this output's slot — that is the same `hasDependents` rule close
      // protection uses, narrowed to the declaration being removed.
      const localMatrixId = card.outputs[ordinal].localMatrixId;
      const readers =
        localMatrixId === undefined
          ? []
          : state.cards
              .filter(
                (other) =>
                  other.id !== cardId &&
                  other.inputs.some((input) => input.target.matrixId === localMatrixId),
              )
              .map((other) => other.id);
      if (readers.length > 0) {
        get().blockCard(cardId);
        return { ok: false, code: 'bound', readers };
      }

      const params = scriptParams(card);
      const outputs = card.outputs.filter((_, position) => position !== ordinal);
      const names = params.outputs.filter((_, position) => position !== ordinal);
      const matrices = new Map(state.matrices);
      if (localMatrixId !== undefined) {
        // The slot dies with the declaration. The server-side matrix is the node's business:
        // the next successful run re-syncs the declared count and releases the surplus.
        matrices.delete(localMatrixId);
      }
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, outputs, params: { ...entry.params, outputs: names } }
            : entry,
        ),
        matrices,
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
      return { ok: true };
    },

    addScriptPort(cardId) {
      const state = get();
      const card = state.cards.find((entry) => entry.id === cardId);
      if (!card || !isScriptCard(card) || card.inputs.length === 0) return null;

      // v1 binds a new port to the source the card already reads: picking a NEW source is a
      // canvas gesture that already exists for every other card kind, and inventing a second
      // one inside the card would be the "port-level connection" the decision rules out.
      const first = card.inputs[0];
      const portId = nextInputPortId(card.inputs);
      const params = scriptParams(card);
      const portNames = [...params.portNames];
      while (portNames.length < card.inputs.length) {
        portNames.push(card.inputs[portNames.length].portId);
      }
      portNames.push(nextScriptVarName([...portNames, ...params.outputs]));
      const cycle = state.dependencies.addDependency(cardId, first.target.cardId, portId);
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? {
                ...entry,
                inputs: [...entry.inputs, { portId, target: { ...first.target } }],
                params: { ...entry.params, portNames },
              }
            : entry,
        ),
        // The graph was mutated in place; publishing the reference is what tells every
        // `dependencies` subscriber (the connection layer) that one more port exists.
        dependencies: state.dependencies,
      });
      markScriptDefinitionChanged(cardId);
      void syncFunctionCard(cardId);
      return portId;
    },

    runScriptCard(cardId) {
      void runScriptCardNow(cardId, 'clean');
    },

    debugScriptCard(cardId) {
      void runScriptCardNow(cardId, 'debug');
    },

    // ── compute backend ───────────────────────────────────────────────

    backend: { state: 'unknown' },
    signatures: [],
    connectBackend: async () => {
      const info = await backendClient.hello();
      const missing = info.ok
        ? REQUIRED_CAPABILITIES.filter((cap) => !(info.capabilities ?? []).includes(cap))
        : [];
      if (info.ok && missing.length > 0) {
        // Additive or not, this backend cannot evaluate function cards: say so instead of
        // creating nodes it will silently misinterpret.
        stopEventLoop();
        set({
          backend: { state: 'mismatch', error: `missing-capability:${missing.join(',')}` },
        });
        return;
      }
      if (info.ok) {
        set({ backend: { state: 'online', build: info.build, protocol: info.protocol } });
        // Advertised signatures (built-ins today, plugin registrations later).
        void backendClient.signatures().then((signatures: SignatureDto[]) => {
          if (signatures.length > 0) set({ signatures });
        });
        // The event stream is the only way results reach the browser; re-arm it whenever we
        // (re)connect so a reconnect after an outage resumes pushing node states.
        get().startBackendEventLoop();
        // Tables loaded (or files replaced) while the backend was down have no server id,
        // and nothing else retries them: upload them now and re-push the function cards.
        void ensureUploadedMatricesRegistered();
      } else if (info.error?.startsWith('protocol-mismatch')) {
        stopEventLoop();
        set({ backend: { state: 'mismatch', error: info.error } });
      } else {
        stopEventLoop();
        set({ backend: { state: 'offline', error: info.error ?? 'unreachable' } });
      }
    },

    registerMatrixWithBackend: async (name, columns) => {
      const result = await backendClient.registerMatrix(name, columns);
      if (!result.ok || result.matrixId === undefined) {
        set({ backend: { state: 'offline', error: result.code ?? 'unreachable' } });
        return null;
      }
      return result.matrixId;
    },

    backendMatrixId: (localMatrixId) => backendMatrixIds.get(localMatrixId) ?? null,

    applyNodeEvent(event) {
      // Matrix-level events (no nodeId) carry no per-node state to mirror here.
      if (event.nodeId === undefined || !event.state) return;
      if (event.seq > lastEventSeq) lastEventSeq = event.seq;
      // `reason` is the field that separates 未请求 from 待重算; the server puts it on a
      // dirty event (`nodes.cpp` `markStaleLocked`), so it is part of NodeEvent.
      const reason = event.reason;
      // A summary node is not a function card's node, so it is routed separately.
      const summaryCardId = locateSummaryCardByNode(event.nodeId);
      if (summaryCardId !== null) {
        applySummaryEvent(summaryCardId, event.state, reason, event.code);
      }
      const cardId = locateCardByNode(event.nodeId);
      if (cardId === null) return;
      applyNodeSnapshot(cardId, {
        nodeId: event.nodeId,
        state: event.state,
        ...(event.code !== undefined ? { code: event.code } : {}),
        ...(event.params !== undefined ? { params: event.params } : {}),
        // A `done` push carries the advice about the numbers it just published (units L1b /
        // B1); every other push means the numbers are gone, so the warnings go with them.
        ...(event.warnings !== undefined ? { warnings: event.warnings } : {}),
      });
      // A finished computation is the trigger to pull the numbers — the display cache is
      // refreshed from the window endpoint, never from a local evaluation.
      const pulled = event.state === 'done' ? pullResultIntoCache(cardId) : null;
      if (pulled) void pulled;
      // The unit-conversion card mirrors the same events into its own run state (lamp, the
      // structured error a sentence is built from) and drops its numbers on dirty/error —
      // the backend has already emptied the result matrix by then.
      const eventCard = useWorkspace.getState().cards.find((entry) => entry.id === cardId);
      if (eventCard && isUnitConvertCard(eventCard)) {
        applyUnitConvertEvent(cardId, event.state, event.code, event.params);
        // A `done` event nobody here asked for still has to light the card once the numbers
        // land — the SAME pull as above, awaited rather than started a second time.
        if (pulled) {
          void pulled.then(() => {
            const still = useWorkspace.getState().unitRuns[cardId];
            if (still && still.status === 'running') {
              patchUnitRun(cardId, { status: 'done', computedAt: Date.now() });
            }
          });
        }
      }
      // An armed script card treats "my input changed" exactly like a formula card's node
      // does: it runs again (the user asked for formula-like behaviour after the first run).
      //
      // ONLY `upstreamChanged`: a dirty event is also the echo of our own declaration PATCH
      // (`notRequested` / `definitionChanged`), and that echo arrives while the run it
      // belongs to is in flight — retriggering on it runs the card, whose PATCH emits the
      // next echo, forever. Definition edits and bindings have their own trigger in
      // `pushFunctionCard`; the event path exists for changes the frontend did not push.
      if (event.state === 'dirty' && event.reason === 'upstreamChanged') {
        maybeAutoRunScript(cardId);
      }
    },

    startBackendEventLoop() {
      stopEventLoop();
      const controller = new AbortController();
      eventLoopAbort = controller;
      void (async () => {
        while (!controller.signal.aborted) {
          const events = await backendClient.events(lastEventSeq, controller.signal);
          if (controller.signal.aborted) break;
          // A malformed answer must not kill the long-poll loop (the banner is the signal
          // for "the backend is unusable", not an exception in a detached async task)…
          const list = Array.isArray(events) ? events : [];
          for (const event of list) get().applyNodeEvent(event);
          // …and it must not turn the loop into a busy poll: `events()` resolves empty on
          // timeout or transport failure, and "not even an array" is the same situation.
          // Without this the pause was skipped and the loop hammered the backend at full
          // speed (found by a test whose stub answered the wrong shape).
          if (list.length === 0) await sleep(250);
        }
      })();
    },

    stopBackendEventLoop() {
      stopEventLoop();
    },

    // ── persistence ───────────────────────────────────────────────────

    toSnapshot() {
      const state = get();
      const matrices: MatrixSnapshot[] = [];

      // Resolve each matrix's display name from the cards that actually reference it.
      // The identity cache cannot serve this purpose — it is keyed by bytes, not by label,
      // and a name lookup here was what previously degraded to `#id` when two cards shared
      // a file name. A matrix nothing references still gets a stable placeholder.
      const nameForMatrix = (matrixId: number): string => {
        for (const card of state.cards) {
          if (!isMatrixCard(card)) continue;
          const source = card.sources.find((s) => s.matrixId === matrixId);
          if (source) return source.name;
        }
        return `#${matrixId}`;
      };

      for (const [id, matrix] of state.matrices) {
        matrices.push({
          id,
          name: nameForMatrix(id),
          columns: matrix.columns().map((col) => ({
            posName: col.posName,
            annotation: col.annotation,
            data: col.data,
          })),
        });
      }
      return {
        version: 2,
        savedAt: new Date().toISOString(),
        // Written unconditionally — a workspace without scripts carries the block too, so
        // the file shape never depends on which cards happen to be open, and opening one
        // script card later needs no migration.
        env: cloneWorkspaceEnv(state.workspaceEnv),
        cards: state.cards.map(persistedCard),
        matrices,
        // Written unconditionally (like `env`): the file shape never depends on whether a
        // unit happened to be confirmed, and a legacy reader simply ignores the field.
        unitConfirmations: state.unitConfirmations,
        // Written unconditionally, like `env`: the manual constants are a workspace layer of
        // their own (units L1b §B2), and a file that has none must still say so rather than
        // leave a reader guessing whether the field was forgotten. `{}` is the neutral value.
        unitConstants: state.unitConstants,
        // Present only when this workspace overrides the global tier (units L1a): a file
        // that never set one carries no key at all, so "absent" and "inherit" are the same
        // statement and an older build reads the file unchanged.
        ...(state.unitPolicyOverride !== undefined
          ? { unitPolicyOverride: state.unitPolicyOverride }
          : {}),
        nextCardId: state.nextCardId,
        nextMatrixId: state.nextMatrixId,
      };
    },

    loadSnapshot(snapshot) {
      // A push started against the previous workspace must not bind into this one.
      workspaceEpoch += 1;
      // Slot completeness is per-workspace bookkeeping keyed by local matrix id, and those
      // ids restart: the restored workspace re-learns it from its first pull. The same holds
      // for pulls still in flight — they carry the old epoch and answer nobody.
      outputSlotCache.clear();
      outputSlotPulls.clear();

      // Unit drift is a comparison between the OLD and the NEW version of a same-name table
      // (units L1a §3), so it has to be collected before `set` replaces `matrices`. The
      // previous workspace's matrices are gone by the time the restore finishes otherwise.
      const previousMatrices = get().matrices;
      const previous = get();
      const previousConfirmations = previous.unitConfirmations;
      const previousCards = previous.cards;

      const matrices = new Map<number, MatrixData>();
      for (const entry of snapshot.matrices) {
        const matrix = new MatrixData();
        for (const col of entry.columns) {
          matrix.appendColumn(col.posName, col.data.slice());
          matrix.setColumnAnnotation(matrix.columnCount() - 1, col.annotation);
        }
        matrices.set(entry.id, matrix);
      }

      // The identity cache is deliberately left empty after a restore: the bytes are no
      // longer on disk, so re-dropping the same file must produce a fresh parse rather
      // than silently aliasing to restored data.

      // Rebuild the graph from `inputs[]` — the ONE place dependencies live, so this pass
      // needs no per-kind knowledge (the v1 code rebuilt from chart cards only, which is
      // exactly how restored formula dependencies used to vanish). Refused edges are
      // skipped: a hand-edited save file must not corrupt close-protection.
      const restored = normalizeRestoredCards(snapshot.cards);
      const { dependencies, droppedEdges } = rebuildDependencies(restored);
      // "本工作区包含 N 段用户脚本，首次成功后才自动重跑": one sentence for the file, and the
      // number is a count of CARDS — nothing is compiled, imported or run to produce it.
      const scriptCount = restored.filter(isScriptCard).length;

      // Restored cards are pushed afresh; a signature from the previous workspace would
      // suppress a push that the restarted backend actually needs.
      lastPushedSignature.clear();

      set({
        cards: restored,
        matrices,
        matrixIdByIdentity: new Map(),
        dependencies,
        // Never trust the counters in the file: a hand-edited (or truncated) snapshot
        // could otherwise hand a new card an id that collides with an existing one.
        nextCardId: Math.max(
          snapshot.nextCardId ?? 0,
          snapshot.cards.reduce((max, card) => Math.max(max, card.id), 0) + 1,
        ),
        nextMatrixId: Math.max(
          snapshot.nextMatrixId ?? 0,
          [...matrices.keys()].reduce((max, id) => Math.max(max, id), 0) + 1,
        ),
        selectedId: null,
        blockedCardId: null,
        blockNonce: 1,
        // Panel state names nodes of the workspace being replaced; a restored card starts
        // with 未请求 like every other card.
        summaries: {},
        // Unit confirmations travel with the file (sanitised): the same headers must not be
        // re-asked after a restore. A legacy file without the block starts empty.
        //
        // NESTING RULE (units L1a §1 / decision §五): this REPLACES the memory, it never
        // merges it. The previous workspace's answers describe the previous workspace's
        // matrices — same-signature headers in another file can mean something else — so a
        // restore is a {0} boundary and nothing from outside the snapshot may leak across it.
        unitConfirmations: sanitizeUnitConfirmations(snapshot.unitConfirmations),
        // The workspace layer travels with its own snapshot; `null` when the file carries no
        // override (inherit the global tier — never the previous workspace's override).
        unitPolicyOverride: normalizeUnitPolicyOverride(snapshot.unitPolicyOverride),
        // Likewise the manual constants: they describe THIS workspace's project conventions,
        // so a restore REPLACES them (a legacy file without the block restores to none). A
        // nested workspace keeps its own definitions and never inherits the parent's.
        unitConstants: sanitizeUnitConstants(snapshot.unitConstants),
        // A restored script card has no run of its own: the traceback, duration and previews
        // belonged to a node that no longer exists.
        scriptRuns: {},
        // Likewise a conversion: the targets are the card's PARAMETER (restored above), but
        // the last run's lamp and its numbers were that node's.
        unitRuns: {},
        // The caller knows the file's hash (it read the bytes); trust starts empty so a file
        // can never be treated as trusted by accident while that lookup is in flight.
        trust: initialTrust(),
        propagationFrozen: false,
        blockers: [],
        // The stamp travels with the file, verbatim: a legacy file (no block — `migrate`
        // fills the pinned one) or a file from another machine both land here, and the
        // difference from this build's constants is REPORTED by the banner, never repaired.
        workspaceEnv: cloneWorkspaceEnv(snapshot.env ?? PINNED_WORKSPACE_ENV),
        envMismatchAcknowledged: false,
        scriptNotice: scriptCount > 0 ? scriptCount : null,
      });

      if (droppedEdges > 0) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycleDropped', { n: droppedEdges }),
        );
      }

      // Re-validate the units of every table that the previous workspace also had (units L1a
      // §3): only a changed/contested resolution is worth a word, and only in strict mode.
      // Clean data, and any auto/free workspace, stay silent — opening a file must never
      // become a confirmation ritual.
      reportUnitDrift(
        previousCards,
        previousMatrices,
        previousConfirmations,
        // The OLD side is judged by the OLD workspace's constants: a restore replaces them,
        // and comparing two tables with two different definitions would report a drift the
        // user never made.
        unitResolutionContext(previous),
        restored,
        matrices,
        get,
      );

      // Bring the restored state back to the server: the backend's matrix and node ids do
      // not survive a restart, so a restore has to re-register the matrices first and can
      // only then bind function-card nodes to them. Martices are registered in id order so
      // the local→server mapping is deterministic; function cards that cannot register
      // (offline backend) simply stay grey and the banner carries the failure (contract 1).
      void (async () => {
        // A function card's display cache is a *derived* view: its numbers come from the
        // node's result matrix server-side. Registering it as a source would create a
        // duplicate table that nothing reads (and leak one per restore). Declared outputs
        // beyond ordinal 0 are derived in exactly the same sense — one slot each, filled
        // only by a run — so the exclusion is written over every output, not just the first.
        const derivedIds = new Set(
          restored
            .filter(isFormulaCard)
            .flatMap((card) => [
              card.displayMatrixId,
              ...card.outputs
                .map((output) => output.localMatrixId)
                .filter((id): id is number => typeof id === 'number'),
            ]),
        );
        const ordered = [...matrices.entries()]
          .filter(([localId]) => !derivedIds.has(localId))
          .sort((a, b) => a[0] - b[0]);
        for (const [localId, matrix] of ordered) {
          if (backendMatrixIds.has(localId)) continue;
          await registerUploadedMatrix(localId, `#${localId}`, matrix);
        }
        for (const card of restored) {
          if (isFormulaCard(card)) void syncFunctionCard(card.id);
        }
      })();
    },

    reset() {
      // Matrix ids restart at 1, so cached server ids from the previous workspace would
      // point at the wrong rows after a reset. Drop them together with the matrices.
      backendMatrixIds.clear();
      // A coalesced re-run queued before the reset would otherwise target the *new* card
      // that inherits the same id.
      syncingCards.clear();
      resyncRequested.clear();
      lastPushedSignature.clear();
      // Uploads started for the previous workspace must not bind their server ids to the
      // new workspace's local ids; `registerUploadedMatrix` releases the copy on settle.
      matrixUploads.clear();
      // A run in flight belongs to a node of the previous workspace; its answer must not be
      // written into the card that inherits the same id (the epoch check catches the write,
      // this drops the in-flight marker so the new workspace can run immediately).
      scriptRunsInFlight.clear();
      // Local matrix ids restart at 1 as well, so a slot marked complete here would make the
      // new workspace believe it holds rows nobody ever fetched — and a pull in flight would
      // be merged into a request for a slot of the same id in the new workspace.
      outputSlotCache.clear();
      outputSlotPulls.clear();
      workspaceEpoch += 1;
      lastEventSeq = 0;
      stopEventLoop();
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        dependencies: new DependencyGraph(),
        blockedCardId: null,
        blockNonce: 0,
            // Session-only panel state dies with the workspace (like the node map above, it
        // must never be answered for a card that inherits the same id).
        summaries: {},
        scriptRuns: {},
        unitRuns: {},
        // Confirmations belonged to the matrices that were just dropped.
        unitConfirmations: {},
        // …and so did the workspace's policy override: a reset is an empty workspace, which
        // inherits the global tier like a brand-new one.
        unitPolicyOverride: undefined,
        // Manual constants are workspace data like the confirmations: a reset has none.
        unitConstants: {},
        trust: initialTrust(),
        propagationFrozen: false,
        blockers: [],
        toast: null,
        // A reset returns the app to its initial state, including "no modal open".
        helpOpen: false,
        helpSection: null,
        // An empty workspace is the one this build is pinned to: there is no file whose
        // stamp could disagree, and no scripts whose non-execution needs announcing.
        workspaceEnv: cloneWorkspaceEnv(PINNED_WORKSPACE_ENV),
        envMismatchAcknowledged: false,
        scriptNotice: null,
        // The plane is empty again, so bring the view back to the origin — otherwise the
        // next workspace would open panned into the void left by the previous one.
        view: { x: 0, y: 0, zoom: 1 },
        nextCardId: 1,
        nextMatrixId: 1,
      });
    },

    acknowledgeEnvMismatch() {
      // Only the banner closes. `workspaceEnv` keeps the file's values (they are a fact
      // about where the workspace came from) and no script is started either way.
      set({ envMismatchAcknowledged: true });
    },

    dismissScriptNotice() {
      set({ scriptNotice: null });
    },
  };
});

// ── Selectors ─────────────────────────────────────────────────────────────

export function useTranslator() {
  const locale = useWorkspace((s) => s.locale);
  // `translatorFor` caches by locale, so `t` keeps one identity for the whole locale.
  // Components put `t` in `useMemo`/`useCallback` dependency arrays; a fresh closure per
  // render used to invalidate every memo that mentioned it.
  const t = translatorFor(locale);
  return { t, locale };
}

export function useCard(id: number): CardModel | undefined {
  return useWorkspace((s) => s.cards.find((c) => c.id === id));
}

/**
 * Should the environment-mismatch banner be on screen?
 *
 * True when the loaded workspace's stamp differs from this build's pinned constants AND the
 * user has not yet acknowledged it. A boolean selector (not the raw stamp) keeps the banner
 * from re-rendering on every unrelated store change.
 */
export function useEnvMismatch(): boolean {
  const env = useWorkspace((s) => s.workspaceEnv);
  const acknowledged = useWorkspace((s) => s.envMismatchAcknowledged);
  return !acknowledged && !workspaceEnvIsPinned(env);
}

export function useMatrix(matrixId: number): MatrixData | undefined {
  return useWorkspace((s) => s.matrices.get(matrixId));
}


/**
 * The blocking conditions implied by the current state.
 *
 * Pure and cheap (a handful of fields + a card scan), so it can run on every store change.
 * `envMismatch` stays regardless of the banner's acknowledgement: the acknowledgement closes
 * the banner, it does not make the toolchain match.
 */
function computeBlockers(state: WorkspaceState): Blocker[] {
  const out: Blocker[] = [];
  if (!workspaceEnvIsPinned(state.workspaceEnv)) out.push({ kind: 'envMismatch' });
  if (state.backend.state === 'offline') {
    out.push({ kind: 'backendOffline', detail: state.backend.error });
  } else if (state.backend.state === 'mismatch') {
    out.push({ kind: 'backendMismatch', detail: state.backend.error });
  }
  for (const run of Object.values(state.scriptRuns)) {
    if (run.code === 'runtimeMissing') {
      out.push({ kind: 'runtimeMissing' });
      break;
    }
  }
  for (const card of state.cards) {
    if (card.kind !== 'formula') continue;
    const node = card.node;
    if (!node || node.state !== 'error') continue;
    if (node.code === 'cycle') out.push({ kind: 'cycle', cardId: card.id, detail: node.code });
    else if (node.code === 'columnContractViolation') {
      out.push({ kind: 'columnContract', cardId: card.id, detail: node.code });
    }
  }
  return out;
}

function blockersEqual(a: readonly Blocker[], b: readonly Blocker[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i].kind !== b[i].kind || a[i].cardId !== b[i].cardId) return false;
  }
  return true;
}

/**
 * Keep the blocker list (and the propagation latch) in step with the store.
 *
 * A subscription rather than calls at every mutation site: there are many writers (node
 * events, run outcomes, restores, the backend banner) and missing one would silently leave
 * automatic propagation running through a block. The equality check makes the nested
 * `setState` terminate instead of looping.
 */
useWorkspace.subscribe((state) => {
  const next = computeBlockers(state);
  if (blockersEqual(state.blockers, next)) return;
  const wasFrozen = state.propagationFrozen;
  useWorkspace.setState({ blockers: next, propagationFrozen: next.length > 0 });
  // The gate released: whatever was dropped while it was shut gets one chance to advance.
  // (Nothing is queued by design — a blocked trigger must not pile up — so this is the one
  // place that remembers "there was work waiting".)
  if (wasFrozen && next.length === 0) resumeAutoRuns();
});
