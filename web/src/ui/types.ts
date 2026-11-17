/**
 * Card-layer types — **schema v2** (docs/decisions/2026-10-26-card-schema-v2.md).
 *
 * A card is a record in the store and a React component renders it. Keeping cards as
 * data (rather than classes) is what makes the workspace persistable and the dependency
 * graph easy to reason about.
 *
 * v2 changes, all of them consequences of the function-card review:
 *   - **Dependencies live on the envelope** (`CardBase.inputs`), not inside each payload.
 *     Rebuilding the graph is one pass with zero per-kind knowledge — which is what makes
 *     the old "formula dependencies silently vanish on reload" bug impossible.
 *   - **References point at explicit matrices**, not at "a card, whatever file it happens
 *     to be showing". Switching a table's active file no longer silently re-points a
 *     function card's input; that is now an explicit, visible operation.
 *   - **A function card is ONE node with K outputs** (`outputs[]`), not N nodes. The old
 *     per-column mapping computed the same input N times and could not express a
 *     heterogeneous K-output function (SVD's U/S/V).
 *
 * The header comment used to describe these as mirroring the Qt widget layer; that C++
 * tree was removed on 2026-10-15 (docs/decisions/2026-10-15-qt-implementation-removed.md),
 * so this file is now the authoritative definition rather than a port.
 */

import type { SmoothingOptions } from '../core/Smoothing.ts';
import type { MatrixData } from '../core/MatrixData.ts';
import type { ChartConfig, ChartSource } from '../charts/chartModel.ts';
import type { ChartTypeId } from '../charts/chartTypes.ts';

export type CardKind = 'matrix' | 'chart' | 'formula';

/** A card can be dragged, resized, stacked and closed. */
export interface CardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One data dependency. `portId` is the stable identity — renaming a display label must
 * never change it, and connections are recognised by it, never by position.
 */
export interface PortConnection {
  portId: string;
  target:
    | { type: 'matrix'; cardId: number; matrixId: number }
    | { type: 'cell'; cardId: number; matrixId: number; column: number; row?: number };
}

export interface CardBase extends CardBounds {
  id: number;
  kind: CardKind;
  title: string;
  /** Stacking order; the highest value is the active card. */
  z: number;
  createdAt: number;
  /**
   * First-class citizen: who this card reads from. The dependency graph is rebuilt by
   * walking this array — never by inspecting a payload.
   */
  inputs: PortConnection[];
}

/** One parsed file inside a matrix card. */
export interface MatrixSource {
  /** Display name — the file name. Unique within its card, not globally. */
  name: string;
  matrixId: number;
}

/**
 * Byte identity of a loaded file. Two loads with the same size + lastModified are the
 * same bytes; a different identity under the same name is a *new* file and must not
 * reuse an older parse.
 */
export interface FileIdentity {
  size: number;
  lastModified: number;
}

/** Cache key for a parse: the bytes, not the label. */
export function identityKey(identity: FileIdentity): string {
  return `${identity.size}:${identity.lastModified}`;
}

/**
 * One parsed file on its way into a matrix card: a drop, the picker, or a restored set.
 *
 * `identity` is the byte fingerprint used to reuse an identical parse (see
 * `matrixIdByIdentity`); programmatically built tables and restored snapshots leave it out
 * and therefore always get a matrix of their own.
 */
export interface MatrixEntry {
  name: string;
  matrix: MatrixData;
  identity?: FileIdentity;
}

export interface MatrixCardModel extends CardBase {
  kind: 'matrix';
  /** All files loaded into this card. Content, not a dependency — `inputs` is always []. */
  sources: MatrixSource[];
  /** Index into `sources` of the file currently displayed. */
  activeSource: number;
  /** File-backed tables are read-only. Editing belongs to non-file-backed cards. */
  readOnly: boolean;
}

/** Identifies one plotted column. */
export interface SourceRef {
  matrixId: number;
  columnIndex: number;
}

export interface ChartCardModel extends CardBase {
  kind: 'chart';
  /**
   * Chart type plus its attached columns and presentation options.
   *
   * `config.sources` is a *display view* in v2: the authoritative dependency edges live
   * on `inputs` (one `cell` connection per attached column, plus one `x` connection for
   * an explicit X axis). The two are kept in step by the store.
   */
  config: ChartConfig;
  smoothing: SmoothingOptions;
  /**
   * Whether the column dock is open on this chart card (pure UI state, persisted with
   * the card). Absent on older snapshots — normalizeRestoredCards reads it as false.
   */
  columnPanelOpen?: boolean;
}

/**
 * A compute node as the browser sees it (docs/decisions/2026-10-17-backend-owns-compute.md).
 *
 * One card owns **one** node in v2. The card no longer computes anything; it mirrors the
 * server node's state machine so the UI can light an indicator (dirty/computing/done/error
 * → 灰/黄/绿/红) and render a localised message from a structured error code. `code`/`params`
 * are present only while `state === 'error'`; the user-facing sentence comes from i18n key
 * `formula.error.<code>`, never from the server.
 */
export interface NodeStatus {
  nodeId: number;
  state: 'dirty' | 'computing' | 'done' | 'error';
  /** Structured error identity from the backend (never user prose). */
  code?: string;
  params?: Record<string, unknown>;
}

/** One output declaration plus the server matrix that carries its values. */
export interface OutputBinding {
  /** Stable identity from the signature's output list. */
  outputId: string;
  /** Server-side result matrix id (authoritative copy); -1 until registration. */
  resultMatrixId: number;
  /**
   * Local display-cache matrix id for outputs BEYOND ordinal 0.
   *
   * Output 0 always mirrors into the card's `displayMatrixId` (every chart and downstream
   * card built before K > 1 points at that slot), so only the extra outputs need a slot of
   * their own. Allocating one here is what makes `out:N` an identity a dependent can bind
   * to: the local→server resolution walks `outputs[]`, exactly like it already did for
   * ordinal 0. Absent on every single-output signature, which is why nothing else notices.
   */
  localMatrixId?: number;
}

/** One derived column: a display name and the expression that computes it. */
export interface FormulaColumn {
  name: string;
  expression: string;
}

/**
 * A promised column count for one output table.
 *
 * Created when the user first names an output column: from then on the width is a
 * contract, and a drift stops the data flow here with a structured error instead of
 * silently re-labelling columns. It is deliberately explicit — a heuristic "did the shape
 * change?" check would fire on every legitimate re-point.
 */
export interface ColumnContract {
  outputId: string;
  columns: number;
}

/**
 * A function card's parameter bag.
 *
 * Deliberately open: parameters belong to the SIGNATURE, not to the card. An expression
 * signature carries `formulas`; a signature like `builtin:linear-regression` carries none
 * at all. Typing this as "must have formulas" would force every future signature to
 * pretend it has an empty formula list — the kind of lie that later reads as data.
 */
export interface FunctionParams {
  /** Present for expression-shaped signatures (one expression per output column). */
  formulas?: FormulaColumn[];
  /** Present once the user has named an output column. */
  columnContract?: ColumnContract;
  [key: string]: unknown;
}

/** Parameters of `builtin:expression-columns` — the signature that requires formulas. */
export interface ExpressionColumnsParams extends FunctionParams {
  formulas: FormulaColumn[];
}

/** Published signature id of the Python script card. Frozen like every signature id. */
export const PYTHON_SIGNATURE = 'builtin:python';

/**
 * Parameters of `builtin:python` — the DECLARED shape of a script card
 * (docs/decisions/2026-11-15-python-script-card.md §二/§三).
 *
 * The signature's own `inputs`/`outputs` are an empty template: the real ports and outputs
 * are declared here, because `K` for a script cannot be enumerated in the registry. Two
 * consequences shape this type:
 *
 *   - `portNames` is an ARRAY ordered like `inputs[]`, not a map keyed by portId. That is
 *     the wire shape the backend validates (`params.portNames`), so a card's parameter bag
 *     can travel verbatim without the generic node push knowing which signature it is.
 *     Renaming a port rewrites `portNames[index]`; the `in:N` portId is never touched.
 *   - `outputs` holds the DECLARED VARIABLE NAMES in output-ordinal order. The edge
 *     identity (`out:N`) lives on `outputs[]`, so renaming never breaks a dependent.
 */
export interface PythonScriptParams extends FunctionParams {
  /** The user's Python source, verbatim: the runner wraps nothing around it (§二). */
  script: string;
  /** Injected variable name per bound input port, in `inputs[]` order. */
  portNames: string[];
  /** Declared output variable names in ordinal order. Never empty (§三: K ≥ 1). */
  outputs: string[];
}

/** Script-card parameters pre-declared with their signature (so call sites stay honest). */
export function scriptParams(card: FunctionCardModel): PythonScriptParams {
  const params = card.params;
  return {
    script: typeof params.script === 'string' ? params.script : '',
    portNames: Array.isArray(params.portNames) ? (params.portNames as string[]) : [],
    outputs: Array.isArray(params.outputs) ? (params.outputs as string[]) : [],
  };
}

/**
 * A function card: a signature + parameters + K declared outputs, backed by ONE node.
 *
 * `signatureId` names an entry in the signature registry (built-in today, plugin
 * implementations tomorrow — the port-semantics spec forbids a second entry point).
 */
export interface FunctionCardModel extends CardBase {
  kind: 'formula';
  signatureId: string;
  /** Parameters are separate from the dataflow graph: changing one adds/removes no edge. */
  params: FunctionParams;
  /** K outputs = one node. K is fixed by the signature, never by the data. */
  outputs: OutputBinding[];
  /**
   * Whether the card's declaration columns are expanded (2026-11-17).
   *
   * A presentation choice, persisted with the card like the chart's `columnPanelOpen` — and
   * deliberately NOT in `params`: parameters belong to the signature and travel to the
   * backend, while which column is folded is nobody's business but the user's. A card written
   * before this field existed opens expanded, which is what it looked like when written.
   */
  inputsPanelOpen?: boolean;
  outputsPanelOpen?: boolean;
  /** The single backend compute node; null while registration is pending/offline. */
  node: NodeStatus | null;
  /**
   * Local display-cache matrix id (frontend id space, like a matrix card's `sources[]`).
   * This is a **read-only cache** filled from the backend's result
   * matrix; nothing writes into it locally.
   */
  displayMatrixId: number;
  /**
   * How much of the result the display cache actually holds.
   *
   * A 10⁵-row result is shown as its first rows (`shownRows`) and the rest is fetched only
   * when the user asks (`complete: false` + the "show more" action). `totalRows` comes from
   * the dense-matrix frame's shape header, so the card can say "100 of 165 000" without
   * downloading the whole table. `null` while no result has arrived.
   */
  result: ResultDisplay | null;
}

/** Row budget of a function card's display cache (see `FunctionCardModel.result`). */
export interface ResultDisplay {
  /** Rows of the stored result matrix (authoritative, server-side). */
  totalRows: number;
  /** Rows currently mirrored in the browser cache. */
  shownRows: number;
  /** True once `shownRows === totalRows` (nothing left to fetch). */
  complete: boolean;
  /** True when the cache stopped at the row ceiling instead of the end of the data. */
  truncated: boolean;
}

export type CardModel = MatrixCardModel | ChartCardModel | FunctionCardModel;

export function isMatrixCard(card: CardModel): card is MatrixCardModel {
  return card.kind === 'matrix';
}

export function isChartCard(card: CardModel): card is ChartCardModel {
  return card.kind === 'chart';
}

export function isFormulaCard(card: CardModel): card is FunctionCardModel {
  return card.kind === 'formula';
}

/**
 * Is this function card the Python script card?
 *
 * The render dispatch (`<ScriptCard>` instead of `<FormulaCard>`) and the script card's own
 * actions ask this question; nothing in the generic infrastructure does. `builtin:python`
 * is a signature, not a card kind — one `FunctionCardModel`, one node, one display cache —
 * so a script card must keep working through every code path that never asks.
 */
export function isScriptCard(
  card: CardModel,
): card is FunctionCardModel & { params: PythonScriptParams } {
  return card.kind === 'formula' && card.signatureId === PYTHON_SIGNATURE;
}

/**
 * Does this card read from any matrix owned by `cardId`?
 *
 * Reads `inputs` only — the one place dependencies live. Used by close protection and by
 * the chart-refresh path, so neither needs kind-specific knowledge.
 */
export function dependsOnCard(card: CardModel, cardId: number): boolean {
  return card.inputs.some((input) => input.target.cardId === cardId);
}

/** Persisted card snapshot (no matrix payload — that travels in `MatrixSnapshot`). */
export type CardSnapshot = CardModel;

/** Serialisable form of `MatrixData`, used by the workspace save file. */
export interface MatrixSnapshot {
  id: number;
  name: string;
  columns: Array<{ posName: string; annotation: string; data: number[] }>;
}

// ── workspace environment lock ───────────────────────────────────────────────────────
//
// The workspace file records the toolchain its scripts were validated against, so reopening
// it can say "saved with python 3.13.18" instead of silently running under whatever happens
// to be installed. Two rules make the block useful rather than decorative:
//
//   - It is written UNCONDITIONALLY (`toSnapshot` always stamps it), scripts or no scripts:
//     a saved file always has the block, so the schema does not depend on the card mix and
//     a later script card needs no second migration.
//   - It is never repaired on load. A block that differs from this machine's constants is a
//     fact about the save file; the UI reports the mismatch and leaves the value alone.

/** One pinned wheel: what it is, the build it was fetched for, and its byte identity. */
export interface WorkspaceEnvPackage {
  name: string;
  version: string;
  /** Wheel platform tag of the pinned build (informational, never matched at runtime). */
  platform: string;
  /** SHA-256 of the wheel itself — the identity, not the label. */
  sha256: string;
}

/** The environment stamp stored at the top level of a workspace file. */
export interface WorkspaceEnv {
  python: string;
  packages: readonly WorkspaceEnvPackage[];
}

/**
 * The ONE pinned toolchain table in the repository.
 *
 * Same source as `scripts/fetch-python-runtime.sh`: `PY_VERSION="3.13.18+20261110"`,
 * `NUMPY_VERSION="2.5.4"`, `NUMPY_SHA256="6ffa07…062c0"`, fetched as
 * `numpy-2.5.4-cp313-cp313-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`. Change one,
 * change both — v1 accepts this as the only legal value of a workspace `env` block.
 *
 * `workspaceStore`'s `PYTHON_RUNTIME_STAMP` is derived from this object on purpose: the
 * stamp the script card prints and the block the save file carries cannot drift apart.
 */
export const PINNED_WORKSPACE_ENV = {
  python: '3.13.18',
  packages: [
    {
      name: 'numpy',
      version: '2.5.4',
      platform: 'cp313-manylinux_2_27_x86_64',
      sha256: '6ffa07666f8da0eef81d149934a626d0d95fbd6838432a33e66245423a9062c0',
    },
  ],
} as const satisfies WorkspaceEnv;

/** A copy the caller owns (the pinned table itself is never handed out for mutation). */
export function cloneWorkspaceEnv(env: WorkspaceEnv): WorkspaceEnv {
  return { python: env.python, packages: env.packages.map((pkg) => ({ ...pkg })) };
}

/** Version of one pinned package, or `''` when the stamp does not mention it. */
export function workspaceEnvPackageVersion(env: WorkspaceEnv, name: string): string {
  return env.packages.find((pkg) => pkg.name === name)?.version ?? '';
}

/**
 * Order-independent identity of an environment stamp.
 *
 * Comparing the block verbatim would call two logically identical stamps different just
 * because `packages[]` was reordered; the signature makes the mismatch flag mean "different
 * toolchain", not "different serialisation".
 */
export function workspaceEnvSignature(env: WorkspaceEnv): string {
  const packages = env.packages
    .map((pkg) => `${pkg.name}@${pkg.version}:${pkg.platform}#${pkg.sha256}`)
    .sort();
  return `python ${env.python} | ${packages.join(', ')}`;
}

export function workspaceEnvEquals(a: WorkspaceEnv, b: WorkspaceEnv): boolean {
  return workspaceEnvSignature(a) === workspaceEnvSignature(b);
}

/** Is this workspace's stamp the one this build is pinned to? */
export function workspaceEnvIsPinned(env: WorkspaceEnv): boolean {
  return workspaceEnvEquals(env, PINNED_WORKSPACE_ENV);
}

export interface WorkspaceSnapshot {
  version: 2;
  savedAt: string;
  /**
   * Environment stamp the workspace was saved against.
   *
   * Optional in the TYPE because snapshots written before the lock existed are still on
   * users' disks: `migrateWorkspace` fills those in with the pinned constants, and
   * `toSnapshot` — the writer — always emits the field. So "absent" only ever describes a
   * legacy file being read, never a file this app produced.
   */
  env?: WorkspaceEnv;
  cards: CardSnapshot[];
  matrices: MatrixSnapshot[];
  nextCardId: number;
  nextMatrixId: number;
}

export type { ChartConfig, ChartSource, ChartTypeId };
