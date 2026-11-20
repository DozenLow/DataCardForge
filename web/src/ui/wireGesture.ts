/**
 * Right-drag wiring — the pointer arbiter, the drop matrix, and the gesture's own state (G3).
 *
 * Implements task G3 of `docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md`
 * (§六 drop matrix, §七 pointer arbitration). The gesture: press the **right** button on a
 * card's title bar, drag towards another card, release. The release decides what happens:
 *
 * | the drop lands on                              | action                            |
 * |------------------------------------------------|-----------------------------------|
 * | a script input port row (`data-port-id`)        | **replace** that port's source    |
 * | the card body (not a port row)                  | **add** a port (next free letter) |
 * | a chart / a builtin-signature function card     | **refuse** — no new input         |
 * | a data card                                     | **refuse** — it publishes, never consumes |
 * | the source itself, or any card downstream of it | **refuse** — that is a cycle      |
 * | the bare canvas                                 | **cancel** — zero side effects    |
 * | a port that already reads this exact matrix     | **no-op**                         |
 *
 * ## Why the arbitration is displacement, not a timer (§七)
 *
 * The browser reports a right press as `pointerdown(button=2) → pointermove* → pointerup`
 * plus **one** `contextmenu` whose timing is platform-specific (some Chromium/X11 builds fire
 * it on press, Windows/macOS on release). Two different intents — "right click" and "drag a
 * wire" — therefore cannot be told apart by when the menu arrives, and the menu cannot be
 * deferred while a gesture decides. So the split is made from the pointer sequence itself, at
 * **pointer-up, by displacement**: below `WIRE_DRAG_THRESHOLD` the press was a click (on a
 * title bar: nothing — P0), at or above it the release commits or cancels the drop. There is
 * deliberately no long-press timer: a timer adds latency, misfires under a busy main thread,
 * and cannot be unit-tested. The native menu is not this module's problem — G1 cancels it for
 * the whole application (`suppressNativeMenu.ts`).
 *
 * `pointerdown` is never `preventDefault()`ed: React's `onMouseDown` on the shell (`onActivate`
 * → raise/select) is what a right press has always done, and cancelling it would be a silent
 * regression on all nine card types. Only the native `contextmenu` is cancelled, and G1 does
 * that centrally.
 *
 * ## What this module owns, and what it refuses to touch
 *
 *   - `resolveDrop` is **pure**: plane-space rectangles in, one `DropPlan` out. It never reads
 *     the DOM (`elementFromPoint` is a lie in jsdom — no layout — and a race in a browser) and
 *     never reads the store. Every store rule it needs is injected by the caller: the cycle
 *     test (`findDownstreamPath`), the next port name (`nextScriptVarName`), a matrix's display
 *     name. That is what makes the drop matrix a unit test instead of a browser probe.
 *   - `WireArbiter` is a state machine over explicit inputs (a seed, pointer moves, a release,
 *     a cancel). No DOM, no timers, no store.
 *   - `startWireGesture` is the only DOM-facing entry: `CardShell` calls it from the title
 *     bar's right press, it follows the sequence with window listeners, writes through the M1
 *     store actions, and publishes the gesture's state to whoever needs it.
 *
 * The **draft wire is not drawn here**: it stays in the connection layer's background SVG,
 * which is `pointer-events: none`, so a wire being dragged can never intercept the mouse (the
 * locked "connections are subordinate" rule). This module only says where it goes.
 *
 * `InputSurface` is the single place the gesture maps a card's kind to a drop policy, and it
 * is injected data rather than a branch inside `resolveDrop` on purpose (决策 §九: generic
 * infrastructure grows no per-kind knowledge; the mapping is the wiring layer's).
 */
import { useSyncExternalStore } from 'react';

import {
  allCardRects,
  clientToPlane,
  measuredPortRows,
  type Rect,
} from './cardMetrics.ts';
import { distance, rectContains, type Point } from './connectionGeometry.ts';
import { portVarName } from './bindings.ts';
import { translatorFor } from './i18n.ts';
import {
  nextScriptVarName,
  publishedMatrices,
  useWorkspace,
  type PublishedMatrix,
} from './workspaceStore.ts';
import {
  isChartCard,
  isFormulaCard,
  isScriptCard,
  scriptParams,
  type CardModel,
} from './types.ts';

/** A viewport point, as a pointer event reports it (`clientX` / `clientY`). */
export interface ClientPoint {
  x: number;
  y: number;
}

/**
 * Displacement, in viewport px, that turns a right press into a wiring drag (§七 step 3).
 *
 * Measured as the straight-line distance from where the press landed — a diagonal nudge of
 * (3,3) is 4.2px and therefore a drag, which is what "moved at least 4px" means. It matches
 * the canvas' own pan threshold so the two gestures feel alike.
 */
export const WIRE_DRAG_THRESHOLD = 4;

// ─────────────────────────────────────────────────────────────────────────────────────
// §1  The drop matrix, as a pure function
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What a card does with a dropped wire.
 *
 * Deliberately *data*, computed by the caller — `resolveDrop` must not know that a script
 * card is `signatureId === 'builtin:python'` any more than the dependency graph does.
 *
 *   - `inputs`   — declares input ports (the Python script card): add / replace.
 *   - `chart`    — draws columns of a source; accepts no new input.
 *   - `signature`— builtin-signature function card (expression / relation-enum / unit-convert):
 *                  its inputs belong to the signature, not to the user's wiring.
 *   - `data`     — a data card publishes data; it never consumes it.
 */
export type InputSurface = 'inputs' | 'chart' | 'signature' | 'data';

/** One declared input port of a target card. */
export interface DropPort {
  readonly portId: string;
  /** The variable the card declares for this port (`A`). */
  readonly name: string;
  /** The matrix the port reads today, or null when it is unbound. */
  readonly targetMatrixId: number | null;
}

/** One card as the hit test sees it. */
export interface DropCard {
  readonly id: number;
  /** Display name for the drop label — the caller has already applied its own fallback. */
  readonly name: string;
  readonly surface: InputSurface;
  readonly rect: Rect;
  readonly ports: readonly DropPort[];
}

/** One rendered `[data-port-id]` element, in plane coordinates (see `measuredPortRows`). */
export interface DropPortRow {
  readonly cardId: number;
  readonly portId: string;
  readonly rect: Rect;
}

/** One matrix the source card publishes, as a chooser addresses it. */
export interface WireChoice {
  readonly matrixId: number;
  /** Display label: a file name, an output name, or the stable output id. */
  readonly label: string;
  /** The stable output identity (`out:1`) for a function card, null for a file. */
  readonly outputId: string | null;
}

export type DropKind = 'replace' | 'add' | 'reject' | 'cancel' | 'noop';

/**
 * Why a drop was refused. `self` and `cycle` are the two the decision names separately (the
 * cycle one reuses the store's `status.cycle` toast); the rest are "this card takes no input"
 * with the card kind kept for the tests that pin the mapping.
 */
export type DropReason = 'self' | 'cycle' | 'chart' | 'signature' | 'data' | 'noSource';

/**
 * Everything the pre-release label needs, as *data*.
 *
 * The sentence lives in the layer that draws it (`ConnectionLayer` owns the bilingual table,
 * exactly like `SourcePicker`/`ScriptCard` own theirs), so this struct never carries prose and
 * the renderer never re-derives a name.
 */
export interface DropLabel {
  readonly action: 'add' | 'replace' | 'noop' | 'refuse' | 'cancel';
  /** `replace` / `noop`: the variable of the port being re-bound (`A`). */
  readonly port: string | null;
  /** `add`: the variable the new port will take — the next free letter (`B`). */
  readonly next: string | null;
  /** What is being wired in: a file name, an output name, or the source card's name. */
  readonly source: string;
  /** `replace`: what the port reads now (null when it is unbound or unnamed). */
  readonly previous: string | null;
  readonly reason: DropReason | null;
}

/** The decision for one drop. Every other module reads this shape and nothing else. */
export interface DropPlan {
  readonly kind: DropKind;
  /** Who is being wired: the card id the release landed on (absent for `cancel`). */
  readonly sourceCardId: number;
  readonly targetCardId?: number;
  readonly targetName?: string;
  /** `replace` / `noop`: the port being re-bound. */
  readonly portId?: string;
  /**
   * The matrix the drop would bind, or `null` when the source publishes several: ruling 4A
   * has the chooser decide, and this module **never guesses `out:0`**.
   */
  readonly matrixId?: number | null;
  /** Set (with `matrixId: null`) when the source publishes more than one matrix. */
  readonly choices?: readonly WireChoice[];
  /** Machine-readable refusal, so a caller can react (the cycle case shows a toast). */
  readonly reason?: DropReason;
  /** What the target card should paint while the wire hovers it. */
  readonly highlight?: 'accept' | 'refuse' | null;
  readonly label: DropLabel;
}

/**
 * Everything `resolveDrop` may look at.
 *
 * The three callbacks are the store rules the drop matrix needs; injecting them keeps this
 * module free of store imports *and* makes each rule substitutable in a test:
 *   - `isDownstream(cardId)` — the caller answers with `findDownstreamPath`'s result;
 *   - `nextPortName(cardId)` — the name an added port would take (`nextScriptVarName`);
 *   - `matrixName(matrixId)` — how to name a matrix in a "was b.csv → now c.csv" label.
 */
export interface DropScene {
  /** Cards in paint order — a later entry wins an overlapping hit (§ the store's `z`). */
  readonly cards: readonly DropCard[];
  readonly portRows: readonly DropPortRow[];
  readonly sourceCardId: number;
  /** The source card's display name, for the multi-output label and the refusals. */
  readonly sourceName: string;
  /** Matrices the source publishes, in picker order. */
  readonly sourceMatrices: readonly WireChoice[];
  isDownstream(cardId: number): boolean;
  nextPortName(cardId: number): string;
  matrixName(matrixId: number): string | null;
}

/**
 * Which card a plane point lands on, topmost first.
 *
 * `cards` is in paint order, so the scan runs backwards: the card painted last is the one the
 * user sees under the cursor, and hit-testing in list order would let a card that is visually
 * behind swallow a drop.
 */
function cardUnderPointer(cards: readonly DropCard[], point: Point): DropCard | null {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    if (rectContains(cards[index].rect, point)) return cards[index];
  }
  return null;
}

/** The port row of `cardId` under the pointer, or null when the drop lands on the body. */
function portRowUnderPointer(
  rows: readonly DropPortRow[],
  cardId: number,
  point: Point,
): DropPortRow | null {
  for (const row of rows) {
    if (row.cardId !== cardId) continue;
    if (rectContains(row.rect, point)) return row;
  }
  return null;
}

function refusal(scene: DropScene, reason: DropReason): DropLabel {
  return { action: 'refuse', port: null, next: null, source: scene.sourceName, previous: null, reason };
}

/**
 * Resolve one drop — the decision table of §六, and the whole of it.
 *
 * Order matters, and it is the order the matrix is written in: the source itself first (a
 * drag that barely moved is still over its own card, and "your own output" explains that
 * better than a cycle), then the target's surface (a chart that happens to be downstream is
 * refused as a chart — it could not take the wire either way), then the cycle test, then the
 * source (a chart card publishes nothing to wire), then the landing spot. Every branch returns
 * a plan: a `DropPlan` is never "undefined behaviour", so the caller can always paint
 * something before the release.
 */
export function resolveDrop(point: Point, scene: DropScene): DropPlan {
  const card = cardUnderPointer(scene.cards, point);
  if (!card) {
    return {
      kind: 'cancel',
      sourceCardId: scene.sourceCardId,
      highlight: null,
      label: {
        action: 'cancel',
        port: null,
        next: null,
        source: scene.sourceName,
        previous: null,
        reason: null,
      },
    };
  }

  const base = {
    sourceCardId: scene.sourceCardId,
    targetCardId: card.id,
    targetName: card.name,
  };

  if (card.id === scene.sourceCardId) {
    return { kind: 'reject', ...base, highlight: 'refuse', reason: 'self', label: refusal(scene, 'self') };
  }
  if (card.surface !== 'inputs') {
    return {
      kind: 'reject',
      ...base,
      highlight: 'refuse',
      reason: card.surface,
      label: refusal(scene, card.surface),
    };
  }
  if (scene.isDownstream(card.id)) {
    return {
      kind: 'reject',
      ...base,
      highlight: 'refuse',
      reason: 'cycle',
      label: refusal(scene, 'cycle'),
    };
  }
  if (scene.sourceMatrices.length === 0) {
    return {
      kind: 'reject',
      ...base,
      highlight: 'refuse',
      reason: 'noSource',
      label: refusal(scene, 'noSource'),
    };
  }

  // One published matrix commits with zero clicks; several open the chooser at the drop point
  // (ruling 4A). `out:0` is never assumed — a K>1 card's outputs are different tables.
  const single = scene.sourceMatrices.length === 1 ? scene.sourceMatrices[0] : null;
  const matrixId = single ? single.matrixId : null;
  const sourceLabel = single ? single.label : scene.sourceName;
  const choices = single ? undefined : scene.sourceMatrices;

  const row = portRowUnderPointer(scene.portRows, card.id, point);
  const port = row ? card.ports.find((entry) => entry.portId === row.portId) : undefined;

  if (port) {
    const previous =
      port.targetMatrixId === null ? null : scene.matrixName(port.targetMatrixId);
    // Already reads this source on this very port: the graph would not move, and a write would
    // dirty the node (an armed script would run again for nothing).
    if (matrixId !== null && port.targetMatrixId === matrixId) {
      return {
        kind: 'noop',
        ...base,
        portId: port.portId,
        matrixId,
        highlight: null,
        label: {
          action: 'noop',
          port: port.name,
          next: null,
          source: sourceLabel,
          previous,
          reason: null,
        },
      };
    }
    return {
      kind: 'replace',
      ...base,
      portId: port.portId,
      matrixId,
      choices,
      highlight: 'accept',
      label: {
        action: 'replace',
        port: port.name,
        next: null,
        source: sourceLabel,
        previous,
        reason: null,
      },
    };
  }

  return {
    kind: 'add',
    ...base,
    matrixId,
    choices,
    highlight: 'accept',
    label: {
      action: 'add',
      port: null,
      next: scene.nextPortName(card.id),
      source: sourceLabel,
      previous: null,
      reason: null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// §2  The pointer arbiter (§七)
// ─────────────────────────────────────────────────────────────────────────────────────

export type WirePhase = 'idle' | 'candidate' | 'wiring';

/** Why a live gesture was thrown away. The store is never written on a cancel. */
export type WireCancelReason = 'escape' | 'pointercancel' | 'blur' | 'lostCapture';

/**
 * A release that landed on a card whose source publishes several matrices (§十二 ruling 4A).
 *
 * The gesture is over — the draft wire is gone — but nothing has been written yet: the user
 * picks one matrix here, one click, and the drop is committed. Dismissing the chooser writes
 * exactly nothing.
 */
export interface WireChoiceRequest {
  readonly targetCardId: number;
  /** The port being re-bound, or null for an `add` (the port does not exist yet). */
  readonly portId: string | null;
  /** The port's variable, for the chooser's heading. */
  readonly portName: string | null;
  readonly choices: readonly WireChoice[];
  /** Viewport coordinates of the drop, where the chooser opens. */
  readonly client: ClientPoint;
  /** The plan the pick will commit — replayed with the chosen matrix. */
  readonly plan: DropPlan;
}

/** The gesture, as everything that draws it needs to see it. */
export interface WireState {
  readonly phase: WirePhase;
  readonly sourceCardId: number | null;
  /** Pointer position in viewport px (the label/chooser anchor). */
  readonly client: ClientPoint | null;
  /** Pointer position in plane px (the draft wire's end). */
  readonly point: Point | null;
  readonly plan: DropPlan | null;
  readonly choosing: WireChoiceRequest | null;
}

/** Nothing is being dragged: the state every card and the layer render "off" from. */
export const IDLE_WIRE_STATE: WireState = {
  phase: 'idle',
  sourceCardId: null,
  client: null,
  point: null,
  plan: null,
  choosing: null,
};

/**
 * The outside world, injected so the state machine stays a unit.
 *
 * `commit` / `reject` / `click` are the *effects* a decision has: the arbiter decides, the
 * caller performs. Everything else is bookkeeping.
 */
export interface WireArbiterDeps {
  /** Viewport → plane conversion (measurement in the app, identity in a test). */
  toPlane(client: ClientPoint): Point;
  /** The drop matrix at a plane point (see `resolveDrop`). */
  resolve(point: Point, sourceCardId: number): DropPlan;
  /** Perform an accepted drop (`add` / `replace`) with the matrix it binds. */
  commit(plan: DropPlan, matrixId: number): void;
  /** A refused release — the cycle case reuses the store's own toast. */
  reject(plan: DropPlan): void;
  /** Right-click semantics of the armed surface. P0 (title bar): nothing. */
  click(): void;
  publish(state: WireState): void;
}

interface WireSession {
  readonly sourceCardId: number;
  /** Pointer id of the arming press; null when the platform did not report one. */
  readonly pointerId: number | null;
  readonly origin: ClientPoint;
  phase: 'candidate' | 'wiring';
}

/**
 * Is this the pointer the session belongs to?
 *
 * A missing id is not a *different* pointer: synthetic events (the DOM tests) and some
 * platform bridges dispatch pointer events without one, and refusing them would make the
 * gesture untestable off a real browser. When both sides name an id, they must agree — a
 * second finger must not drive the first finger's wire.
 */
function samePointer(seed: number | null, event: number | null | undefined): boolean {
  if (seed === null || event === null || event === undefined) return true;
  return seed === event;
}

/**
 * The right-press state machine: candidate → wiring → decided.
 *
 * `start` arms, `move` promotes (once movement passes `WIRE_DRAG_THRESHOLD`) and then tracks,
 * `release` decides, `cancel` throws the whole thing away. Any state transition is published
 * exactly once per call, so a subscriber never sees a half-applied step.
 */
export class WireArbiter {
  private session: WireSession | null = null;
  private state: WireState = IDLE_WIRE_STATE;

  constructor(private readonly deps: WireArbiterDeps) {}

  /** What is being dragged right now (the drawing layer's input). */
  get current(): WireState {
    return this.state;
  }

  get phase(): WirePhase {
    return this.state.phase;
  }

  /** Arm on a right press. Returns false when a gesture is already live. */
  start(seed: { sourceCardId: number; pointerId?: number | null; client: ClientPoint }): boolean {
    if (this.session) return false;
    this.session = {
      sourceCardId: seed.sourceCardId,
      pointerId: seed.pointerId ?? null,
      origin: seed.client,
      phase: 'candidate',
    };
    // A candidate paints NOTHING: until the pointer has moved far enough, the press is still
    // a potential right-click and showing a wire would be a guess.
    this.emit({
      phase: 'candidate',
      sourceCardId: seed.sourceCardId,
      client: seed.client,
      point: null,
      plan: null,
      choosing: null,
    });
    return true;
  }

  /** Track the pointer. Promotes to wiring at the threshold, then resolves the drop. */
  move(event: { pointerId?: number | null; client: ClientPoint }): void {
    const session = this.session;
    if (!session || !samePointer(session.pointerId, event.pointerId)) return;
    if (session.phase === 'candidate') {
      if (distance(session.origin, event.client) < WIRE_DRAG_THRESHOLD) return;
      session.phase = 'wiring';
    }
    const point = this.deps.toPlane(event.client);
    const plan = this.deps.resolve(point, session.sourceCardId);
    this.emit({
      phase: 'wiring',
      sourceCardId: session.sourceCardId,
      client: event.client,
      point,
      plan,
      choosing: null,
    });
  }

  /**
   * Decide at pointer-up — the only place a click and a drag are told apart (§七 steps 4–5).
   *
   * The drop is resolved from the *release* position, not from the last move: a browser can
   * deliver the release at coordinates the last move never reported, and committing on a stale
   * point would wire the wrong card.
   */
  release(event: { pointerId?: number | null; client: ClientPoint }): void {
    const session = this.session;
    if (!session || !samePointer(session.pointerId, event.pointerId)) return;
    const wasCandidate = session.phase === 'candidate';
    this.session = null;

    if (wasCandidate) {
      // Never past the threshold: this was a right CLICK on the armed surface. P0 = no action
      // (a title bar carries no card menu); the hook exists so a future surface can open one.
      this.emit(IDLE_WIRE_STATE);
      this.deps.click();
      return;
    }

    const plan = this.deps.resolve(this.deps.toPlane(event.client), session.sourceCardId);
    switch (plan.kind) {
      case 'cancel':
      case 'noop':
        // Zero side effects, and no toast: the label already said what would happen.
        this.emit(IDLE_WIRE_STATE);
        return;
      case 'reject':
        this.emit(IDLE_WIRE_STATE);
        this.deps.reject(plan);
        return;
      case 'add':
      case 'replace': {
        const matrixId = plan.matrixId ?? null;
        if (matrixId !== null) {
          this.emit(IDLE_WIRE_STATE);
          this.deps.commit(plan, matrixId);
          return;
        }
        const choices = plan.choices ?? [];
        if (choices.length > 1 && plan.targetCardId !== undefined) {
          this.emit({
            ...IDLE_WIRE_STATE,
            choosing: {
              targetCardId: plan.targetCardId,
              portId: plan.portId ?? null,
              portName: plan.label.port,
              choices,
              client: event.client,
              plan,
            },
          });
          return;
        }
        // A plan with neither a matrix nor a choice cannot be committed; nothing happens.
        this.emit(IDLE_WIRE_STATE);
        return;
      }
    }
  }

  /** Escape / pointercancel / lost capture / window blur — discard, never replay later. */
  cancel(_reason: WireCancelReason): boolean {
    if (!this.session) return false;
    this.session = null;
    this.emit(IDLE_WIRE_STATE);
    return true;
  }

  /** Commit the pending multi-output choice with the matrix the user picked. */
  choose(matrixId: number): boolean {
    const request = this.state.choosing;
    if (!request) return false;
    this.emit(IDLE_WIRE_STATE);
    this.deps.commit(request.plan, matrixId);
    return true;
  }

  /** Dismiss the pending chooser: nothing was written, exactly like a cancel. */
  dismissChoice(): boolean {
    if (!this.state.choosing) return false;
    this.emit(IDLE_WIRE_STATE);
    return true;
  }

  private emit(next: WireState): void {
    this.state = next;
    this.deps.publish(next);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// §3  The published gesture state (what the layer and the cards subscribe to)
// ─────────────────────────────────────────────────────────────────────────────────────

const wireListeners = new Set<() => void>();
let publishedWireState: WireState = IDLE_WIRE_STATE;

function subscribeWireState(listener: () => void): () => void {
  wireListeners.add(listener);
  return () => {
    wireListeners.delete(listener);
  };
}

/** The current gesture state (also the `useSyncExternalStore` snapshot). */
export function getWireState(): WireState {
  return publishedWireState;
}

function publishWireState(next: WireState): void {
  publishedWireState = next;
  for (const listener of [...wireListeners]) listener();
}

/**
 * The gesture state, for the layer that draws the draft wire.
 *
 * The object identity changes on every pointer move, which is correct: the wire tracks the
 * cursor. Components that only care *whether* they are the target use `useWireHighlight`
 * instead, whose snapshot is a primitive and therefore does not re-render them per move.
 */
export function useWireState(): WireState {
  return useSyncExternalStore(subscribeWireState, getWireState);
}

/** How a card should paint itself while a wire hovers it. */
export type WireHighlight = 'accept' | 'refuse';

/**
 * Whether `cardId` is the card a live wire would land on, and how that drop would go.
 *
 * Returns a primitive so React bails out of re-rendering the other eight cards on every
 * pointer move (`useSyncExternalStore` compares snapshots with `Object.is`).
 */
export function useWireHighlight(cardId: number): WireHighlight | null {
  return useSyncExternalStore(subscribeWireState, () => wireHighlightFor(cardId));
}

/** The snapshot `useWireHighlight` compares — primitive, and stable between unrelated moves. */
export function wireHighlightFor(cardId: number): WireHighlight | null {
  const { phase, plan } = publishedWireState;
  if (phase !== 'wiring' || !plan) return null;
  if (plan.targetCardId !== cardId) return null;
  return plan.highlight ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// §4  The DOM binding — the only impure part
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The drop scene, re-measured from the live store and the DOM.
 *
 * Built fresh for every pointer move and once more at the release, not cached for the gesture:
 * a rect captured at the press would be stale the moment anything scrolls or re-lays out, and
 * the drop has to describe where things are *now*. The cycle test inside it is therefore a
 * live read too — and `applyCardInputs` re-checks it atomically at write time regardless, so a
 * graph that moves under the gesture is refused by the store, never wired on stale knowledge.
 */
function sceneFor(sourceCardId: number): DropScene | null {
  const state = useWorkspace.getState();
  const source = state.cards.find((card) => card.id === sourceCardId);
  if (!source) return null;

  // Matrix display names for the whole workspace, so a "was b.csv" label never has to guess.
  const names = new Map<number, string>();
  for (const card of state.cards) {
    for (const published of publishedMatrices(card)) {
      names.set(published.matrixId, matrixLabel(published));
    }
  }

  const rects = allCardRects();
  const cards: DropCard[] = [];
  for (const card of [...state.cards].sort((left, right) => left.z - right.z)) {
    const rect = rects.get(card.id);
    if (!rect) continue;
    cards.push({
      id: card.id,
      name: cardName(card),
      surface: inputSurfaceOf(card),
      rect,
      ports: portsOf(card),
    });
  }

  return {
    cards,
    portRows: measuredPortRows(),
    sourceCardId,
    sourceName: cardName(source),
    sourceMatrices: publishedMatrices(source).map((published) => ({
      matrixId: published.matrixId,
      label: matrixLabel(published),
      outputId: published.outputId,
    })),
    isDownstream: (cardId) => state.dependencies.findDownstreamPath(cardId, sourceCardId) !== null,
    nextPortName: (cardId) => nextPortNameFor(cardId),
    matrixName: (matrixId) => names.get(matrixId) ?? null,
  };
}

/**
 * A card's display name: its title, or its id when it has none.
 *
 * Data cards carry no title of their own (`title: ''`), which is the same fallback
 * `SourcePicker` and `ColumnDock` already use — the label must never print an empty name.
 */
function cardName(card: CardModel): string {
  const title = card.title.trim();
  return title !== '' ? title : `#${card.id}`;
}

/** The label of one published matrix — file name first, then the declared name, then the id. */
function matrixLabel(published: PublishedMatrix): string {
  return published.fileName ?? published.outputName ?? published.outputId ?? `#${published.matrixId}`;
}

/**
 * The drop policy of a card kind.
 *
 * This is the one place the gesture knows about card kinds, and it lives in the *selection*
 * layer on purpose (决策 §九): `resolveDrop` receives the answer as data. It mirrors
 * `CardCanvas`'s render dispatch, which is where a card's kind already decides what is drawn.
 */
function inputSurfaceOf(card: CardModel): InputSurface {
  if (isScriptCard(card)) return 'inputs';
  if (isChartCard(card)) return 'chart';
  if (isFormulaCard(card)) return 'signature';
  // A data card publishes what it loaded; it never consumes a wire.
  return 'data';
}

/** The declared input ports of a card, in declaration order (empty for every non-script card). */
function portsOf(card: CardModel): DropPort[] {
  if (!isScriptCard(card)) return [];
  return card.inputs.map((input, index) => ({
    portId: input.portId,
    name: portVarName(card, input, index),
    targetMatrixId: input.target.matrixId,
  }));
}

/** The variable an added port would take — the same rule `addScriptInput` applies. */
function nextPortNameFor(cardId: number): string {
  const card = useWorkspace.getState().cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) return '';
  const names = card.inputs.map((input, index) => portVarName(card, input, index));
  return nextScriptVarName([...names, ...scriptParams(card).outputs]);
}

/** Do two port targets name the same matrix? (The no-op guard of a re-bind.) */
function sameMatrixTarget(
  left: { type: string; cardId: number; matrixId: number },
  right: { type: 'matrix'; cardId: number; matrixId: number },
): boolean {
  return left.type === 'matrix' && left.cardId === right.cardId && left.matrixId === right.matrixId;
}

/** Perform an accepted drop through the M1 store actions. */
function commitDrop(plan: DropPlan, matrixId: number): void {
  const targetCardId = plan.targetCardId;
  if (targetCardId === undefined) return;
  const target = { type: 'matrix' as const, cardId: plan.sourceCardId, matrixId };
  const store = useWorkspace.getState();

  if (plan.kind === 'replace') {
    const portId = plan.portId;
    if (portId === undefined) return;
    const card = store.cards.find((entry) => entry.id === targetCardId);
    const existing = card?.inputs.find((input) => input.portId === portId);
    // The chooser can land on the matrix the port already reads. `rebindScriptInput` would
    // return early anyway, but asking here keeps "picked the same table" free of a dirty node.
    if (existing && sameMatrixTarget(existing.target, target)) return;
    store.rebindScriptInput(targetCardId, portId, target);
    return;
  }
  // `add`: the store allocates the port id and the variable, appends the edge atomically and
  // marks the card dirty (it never runs it — a declaration change is not a run).
  store.addScriptInput(targetCardId, target);
}

/**
 * A refused release. Only the cycle case speaks up: the decision asks it to reuse the store's
 * own `status.cycle` toast (§六), and the "this card accepts no new input" cases already said
 * so on the label while the wire was being dragged.
 */
function rejectDrop(plan: DropPlan): void {
  if (plan.reason !== 'cycle') return;
  const targetCardId = plan.targetCardId;
  if (targetCardId === undefined) return;
  const store = useWorkspace.getState();
  const path = store.dependencies.findDownstreamPath(targetCardId, plan.sourceCardId) ?? [];
  store.showToast(
    'error',
    translatorFor(store.locale)('status.cycle', { path: [...path, targetCardId].join(' → ') }),
  );
}

/**
 * Window listeners of one live sequence; all installed at once and removed together.
 *
 * `capture` is per listener because the two kinds differ on purpose: the pointer sequence is
 * observed in the capture phase (a card's own handlers must not be able to hide the release
 * from the arbiter), while `blur` is observed in the bubble phase only. A *capture-phase*
 * window listener for `blur` would also fire whenever an element inside the document loses
 * focus — pressing the right button on a title bar blurs whatever input had focus, which would
 * cancel the gesture on its first event.
 */
type WireListener = { type: string; handler: (event: Event) => void; capture: boolean };

let arbiter: WireArbiter | null = null;
let boundListeners: WireListener[] | null = null;

function pointerOf(event: Event): { pointerId: number | null; client: ClientPoint } {
  const pointer = event as PointerEvent & MouseEvent;
  const pointerId = typeof pointer.pointerId === 'number' ? pointer.pointerId : null;
  return { pointerId, client: { x: pointer.clientX, y: pointer.clientY } };
}

function detachListeners(): void {
  if (!boundListeners) return;
  for (const { type, handler, capture } of boundListeners) {
    window.removeEventListener(type, handler, capture);
  }
  boundListeners = null;
}

function attachListeners(gesture: WireArbiter): void {
  if (boundListeners) return;
  const listeners: WireListener[] = [
    {
      type: 'pointermove',
      capture: true,
      handler: (event) => {
        const { pointerId, client } = pointerOf(event);
        gesture.move({ pointerId, client });
      },
    },
    {
      type: 'pointerup',
      capture: true,
      handler: (event) => {
        const { pointerId, client } = pointerOf(event);
        gesture.release({ pointerId, client });
      },
    },
    { type: 'pointercancel', capture: true, handler: () => gesture.cancel('pointercancel') },
    // Pointer capture can be taken away (an ancestor re-render, a browser gesture): the
    // sequence cannot be completed, so it is discarded instead of finished at the last point.
    { type: 'lostpointercapture', capture: true, handler: () => gesture.cancel('lostCapture') },
    { type: 'blur', capture: false, handler: () => gesture.cancel('blur') },
    {
      type: 'keydown',
      capture: true,
      handler: (event) => {
        if ((event as KeyboardEvent).key !== 'Escape') return;
        if (!gesture.cancel('escape')) return;
        // Escape belonged to the gesture, not to whatever had focus.
        event.preventDefault();
      },
    },
  ];
  for (const { type, handler, capture } of listeners) window.addEventListener(type, handler, capture);
  boundListeners = listeners;
}

/**
 * The effect hooks of one gesture, wired to the store and the DOM.
 *
 * Kept as a factory (not module state) so the class' collaborators are visible in one place:
 * the arbiter is *pure*, this object is everything that is not.
 */
function createDeps(): WireArbiterDeps {
  return {
    toPlane: (client) => clientToPlane(client.x, client.y),
    resolve: (point, sourceCardId) => {
      const scene = sceneFor(sourceCardId);
      if (!scene) {
        // The source card vanished mid-gesture (a close from another surface). There is no
        // drop to describe, and nothing to write: cancel.
        return {
          kind: 'cancel',
          sourceCardId,
          highlight: null,
          label: {
            action: 'cancel',
            port: null,
            next: null,
            source: '',
            previous: null,
            reason: null,
          },
        };
      }
      return resolveDrop(point, scene);
    },
    commit: commitDrop,
    reject: rejectDrop,
    click: () => {},
    publish: (state) => {
      publishWireState(state);
      // The window listeners exist only while a sequence does: a right press that never moved
      // leaves nothing behind to observe.
      if (state.phase === 'idle') detachListeners();
    },
  };
}

function ensureArbiter(): WireArbiter {
  if (!arbiter) arbiter = new WireArbiter(createDeps());
  return arbiter;
}

/**
 * Arm the wiring gesture on a right press (called by `CardShell`'s title bar).
 *
 * Returns false when the press cannot arm (another gesture is live, the card is unknown, or
 * the caller did not press the right button). The trigger owns the geometry of the press; this
 * function owns everything after it, so a port dot — when one exists — only has to call it too.
 *
 * `capture` is the element the pointer was captured on. Capture is what makes the sequence
 * finish on the surface that started it (a release over another card's header must not leave
 * a wire half-armed), and losing it cancels. It is optional because jsdom implements no
 * pointer capture at all, and a missing capture only costs events that leave the element.
 */
export function startWireGesture(press: {
  sourceCardId: number;
  pointerId?: number | null;
  client: ClientPoint;
  capture?: Element | null;
}): boolean {
  const target = ensureArbiter();
  const armed = target.start({
    sourceCardId: press.sourceCardId,
    pointerId: press.pointerId ?? null,
    client: press.client,
  });
  if (!armed) return false;
  attachListeners(target);
  // Capture is requested AFTER arming: if capture itself throws (a detached element), the
  // gesture is still tracked by the window listeners and Escape still cancels it.
  const capture = press.capture as (Element & { setPointerCapture?: (id: number) => void }) | null;
  if (capture && press.pointerId !== undefined && press.pointerId !== null) {
    try {
      capture.setPointerCapture?.(press.pointerId);
    } catch {
      // No capture: the sequence falls back to the window listeners, which is lossy but safe.
    }
  }
  return true;
}

/** Commit the pending multi-output choice with the matrix the user picked. */
export function pickWireChoice(matrixId: number): boolean {
  return arbiter?.choose(matrixId) ?? false;
}

/** Dismiss the pending chooser — zero side effects, exactly like a cancel. */
export function dismissWireChoice(): boolean {
  return arbiter?.dismissChoice() ?? false;
}

/** Drop every listener and forget the gesture — for tests and for a workspace reset. */
export function resetWireGesture(): void {
  detachListeners();
  arbiter = null;
  publishWireState(IDLE_WIRE_STATE);
}