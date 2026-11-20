/**
 * Connection layer — the React/SVG counterpart of `src/widgets/ConnectionOverlay.cpp`.
 *
 * Honours the project's **connection subordination** principle: connections are a
 * background visualization of data dependencies, they never intercept pointer
 * events, and they never take part in card layout.
 *
 * Since 2026-11-17 a wire runs **port edge → port edge** (or card edge → card edge when a
 * card renders no port; see `connectionAnchors.ts`), and is a single cubic Bézier whose
 * control points leave along each side's normal (see `connectionGeometry.ts`). The
 * endpoints sit just inside the two cards — a port row is a sub-card, not the frame — so the
 * layer's mask — one black hole per card — is what turns "port to port" into "frame to
 * frame": the wire only becomes visible where it crosses a card's border, at the port's
 * height. That is also why the arrowhead has to be parked on the frame: drawn on the anchor
 * it would be erased.
 *
 * The layer still draws **every** dependency edge (2026-10-28): schema v2 made function
 * cards first-class graph nodes (`inputs[]` on the envelope), so a chain
 * `table → function → chart` is two edges and therefore two lines. A pair of cards is
 * exactly one line — a chart reading three columns of one table keeps one line and its
 * ports are averaged into one anchor and listed on the label.
 *
 * Layering reproduces the Qt two-overlay scheme with a single SVG using two groups:
 *   - `bg` group: thin grey lines for unselected cards, painted under the highlight
 *   - `fg` group: thick red/blue flowing dashes for the active card, painted on top
 *
 * The fg lines are dashed so that colour is not the only cue (red = the selected card is
 * the *source*, blue = it is the *target*, long dash vs short dash), and the dash offset
 * animates toward the target, so the flow direction itself reads as input/output.
 *
 * Since 2026-11-20 the layer also draws the wire the user is currently dragging (task G3,
 * `wireGesture.ts`): one more path in this same `pointer-events: none` SVG, plus the label that
 * says what the release would do. Drawing it anywhere else — a new overlay, an interactive
 * layer — would break the subordination rule this file exists to enforce.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';

import {
  cardAnchor,
  cardRect,
  subscribeLayout,
  getLayoutVersion,
  type AnchorSide,
  type Rect,
} from './cardMetrics.ts';
import { resolveEdgeAnchors, facingSide } from './connectionAnchors.ts';
import {
  arrowPathAt,
  arrowTip,
  cubicTangent,
  dashArray,
  dashCycle,
  dashDuration,
  easeOutCubic,
  lerpPolyline,
  pathData,
  polylineArrowTip,
  polylineDistance,
  polylineLabelPoint,
  polylinePathData,
  routeArrowTip,
  routeGeometry,
  routeLabelPoint,
  routePathData,
  ROUTE_JUMP,
  ROUTE_REFLOW_MS,
  ROUTE_SAMPLES,
  sampleRoute,
  wireGeometry,
  type ArrowPlacement,
  type Point,
  type WireDirection,
  type WireGeometry,
} from './connectionGeometry.ts';
import type { Locale } from './i18n.ts';
import { useTranslator } from './workspaceStore.ts';
import {
  dismissWireChoice,
  pickWireChoice,
  useWireState,
  type DropPlan,
  type WireChoiceRequest,
  type WireState,
} from './wireGesture.ts';
import { Popup } from './components/Popup.tsx';
import type { DependencyGraph } from '../core/DependencyGraph.ts';
import type { CardModel } from './types.ts';

const COLOR_GREY = 'rgb(107, 114, 128)';
const COLOR_RED = 'rgb(200, 50, 50)';
const COLOR_BLUE = 'rgb(40, 120, 220)';

/** Durations mirroring the Qt blink timer: 200 ms tick, 6 ticks (3 on / 3 off). */
const BLINK_INTERVAL_MS = 200;
const BLINK_TICKS = 6;

/**
 * Half-extent of the connection mask's own *region*, in plane px.
 *
 * `<mask>` has no "infinite" default: its `x` / `y` / `width` / `height` default to
 * -10% / 120% of the SVG viewport, and with `maskUnits="userSpaceOnUse"` those
 * percentages resolve in the *plane* coordinate system. Leaving them unset therefore
 * clipped the mask content — including the white backdrop rect below — to roughly one
 * screenful anchored at the plane origin, and everything outside that box is masked to
 * alpha 0: wires were erased, not drawn. That is the "line stops in mid-air while its
 * target card is still on screen" defect, and it appeared at any zoom below 100% or
 * after panning away from the origin, because the visible plane then reaches past the
 * implicit region.
 *
 * The region must be stated explicitly and must be the same box the white rect paints,
 * which is what `maskRegion.test` asserts.
 */
const MASK_EXTENT = 100000;

export interface Connection {
  key: string;
  /** The target card's rectangle — the arrow parks on this frame. */
  targetRect: Rect;
  /** The curve as the layout currently says it should be (before any transition). */
  target: WireGeometry;
  /** The side the wire leaves the source from, and the side it enters the target on. */
  fromSide: AnchorSide;
  toSide: AnchorSide;
  /** Target-side port ids carried by this edge, for the on-line label. */
  ports: string[];
  dependsOn: number;
  dependent: number;
  color: string;
  /** `out` = the selected card is the source (red), `in` = it is the target (blue). */
  direction: WireDirection;
  highlighted: boolean;
}

/**
 * Canvas-relative rectangles of every card, keyed by card id, refreshed whenever the layout
 * could have changed. These become the holes in the connection mask — the lines belong to
 * the desktop *behind* the cards, so they must not be painted across a card's face — and
 * they also clamp the anchors a scrolled port reports (see `connectionAnchors`).
 */
function useCardRects(cards: CardModel[]): Map<number, Rect> {
  const version = useSyncLayoutVersion();
  // `cardRect` reads the live DOM, so the memo is keyed on the layout version as well as
  // the card list — a drag or resize bumps the version without changing `cards`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const out = new Map<number, Rect>();
    for (const card of cards) {
      const rect = cardRect(card.id);
      if (rect) out.set(card.id, rect);
    }
    return out;
  }, [cards, version]);
}

/**
 * Recompute every connection whenever the measured rects or the graph could have changed.
 *
 * Endpoints come from `resolveEdgeAnchors`: the rendered port sub-cards when the edge's
 * ports are on screen, otherwise the facing card edges. The layer never touches the DOM
 * itself (see `cardMetrics`); a card whose rectangle cannot be measured is skipped instead
 * of guessing a position.
 */
export function useConnectionGeometry(
  cards: CardModel[],
  selectedId: number | null,
  dependencies: DependencyGraph,
  rects: Map<number, Rect>,
): Connection[] {
  return useMemo(() => {
    const out: Connection[] = [];

    for (const edge of dependencies.edges()) {
      const anchors = resolveEdgeAnchors(edge, cards, rects);
      if (!anchors) continue;

      const targetRect = rects.get(edge.dependent);
      if (!targetRect) continue;

      let color = COLOR_GREY;
      let direction: WireDirection = 'out';
      let highlighted = false;
      if (selectedId === edge.dependsOn) {
        color = COLOR_RED;
        direction = 'out';
        highlighted = true;
      } else if (selectedId === edge.dependent) {
        color = COLOR_BLUE;
        direction = 'in';
        highlighted = true;
      }

      out.push({
        key: `${edge.dependsOn}->${edge.dependent}`,
        targetRect,
        target: wireGeometry(
          anchors.from.point,
          anchors.to.point,
          anchors.from.side,
          anchors.to.side,
        ),
        fromSide: anchors.from.side,
        toSide: anchors.to.side,
        ports: edge.ports,
        dependsOn: edge.dependsOn,
        dependent: edge.dependent,
        color,
        direction,
        highlighted,
      });
    }

    return out;
  }, [cards, selectedId, dependencies, rects]);
}

function useSyncLayoutVersion(): number {
  const [version, setVersion] = useState(getLayoutVersion);
  useEffect(() => {
    let frame = 0;
    return subscribeLayout(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion(getLayoutVersion());
      });
    });
  }, []);
  return version;
}

/**
 * Reset the blink animation each time a new close attempt is blocked.
 * `nonce` changes on every refusal, so blocking the same card twice re-flashes.
 * Returns the set of card ids that should currently be invisible.
 */
export function useBlockedBlink(blockedCardId: number | null, nonce: number): Set<number> {
  const [visible, setVisible] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const ticksRef = useRef(0);

  useEffect(() => {
    if (blockedCardId === null) return;
    setActive(blockedCardId);
    setVisible(true);
    ticksRef.current = BLINK_TICKS;
  }, [blockedCardId, nonce]);

  useEffect(() => {
    if (active === null) return;
    const timer = window.setInterval(() => {
      setVisible((v) => !v);
      ticksRef.current -= 1;
      if (ticksRef.current <= 0) {
        window.clearInterval(timer);
        setActive(null);
        setVisible(true);
      }
    }, BLINK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return useMemo(() => {
    if (active === null || visible) return new Set<number>();
    return new Set<number>([active]);
  }, [active, visible]);
}

/** Motion is a courtesy: respect the OS setting, and never assume `matchMedia` exists. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Drive the drawn wire from the *settled* layout, not from a tweened endpoint pair.
 *
 * A wire has one shape to animate: its route. Interpolating the two anchors and then
 * re-routing (which is what the old `useTweenedGeometry` did) cannot animate a route whose
 * *topology* changed — when moving an obstacle flips the detour from above to below, the
 * anchors barely move and the drawn path jumps anyway. So the whole route is sampled and
 * interpolated here, and that covers a card jump as well as a detour flip.
 */

/** One wire as it is currently drawn: path, arrowhead and label anchor. */
interface WireFrame {
  d: string;
  arrow: ArrowPlacement | null;
  label: Point;
  samples: Point[];
}

interface Reflow {
  from: Point[];
  to: Point[];
  target: WireFrame;
  /** Target card frame: the arrowhead has to re-park on it every animation frame. */
  rect: Rect;
  startedAt: number;
}

/**
 * Animate the wire when its route is forced to change shape.
 *
 * The route is recomputed from the **settled** card rects, and the whole sampled shape is
 * interpolated — which covers a card jump *and* a detour flip (moving an obstacle so the
 * wire goes from above a card to below it changes no centre at all, but changes the drawn
 * path by hundreds of pixels). Small per-frame changes during a drag are snapped, because
 * the wire has to track the cursor: a tween on every drag frame is rubber-band lag.
 *
 * A reflow already in flight is *retargeted*, never restarted — the layout can keep
 * changing while a card is dragged, and restarting would reset `startedAt` and leave the
 * wire chasing a moving goal forever.
 */
function useReflowedWires(
  connections: Connection[],
  rects: Map<number, Rect>,
  rectList: Rect[],
): Map<string, WireFrame> {
  const [frames, setFrames] = useState<Map<string, WireFrame>>(() => new Map());
  const shownRef = useRef(new Map<string, WireFrame>());
  const tweenRef = useRef(new Map<string, Reflow>());
  const frameRef = useRef(0);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const now = performance.now();
    const keys = new Set<string>();
    let animating = false;
    let settled = false;

    const tick = () => {
      frameRef.current = 0;
      const time = performance.now();
      let alive = false;
      for (const [key, tween] of tweenRef.current) {
        const progress = easeOutCubic(Math.min(1, (time - tween.startedAt) / ROUTE_REFLOW_MS));
        if (progress >= 1) {
          shownRef.current.set(key, tween.target);
          tweenRef.current.delete(key);
          continue;
        }
        const samples = lerpPolyline(tween.from, tween.to, progress);
        shownRef.current.set(key, {
          samples,
          d: polylinePathData(samples),
          arrow: polylineArrowTip(samples, tween.rect),
          label: polylineLabelPoint(samples, rectList),
        });
        alive = true;
      }
      setFrames(new Map(shownRef.current));
      if (alive) frameRef.current = requestAnimationFrame(tick);
    };

    for (const conn of connections) {
      keys.add(conn.key);
      const obstacles: Rect[] = [];
      for (const [id, rect] of rects) {
        if (id !== conn.dependsOn && id !== conn.dependent) obstacles.push(rect);
      }
      const route = routeGeometry(conn.target.from, conn.target.to, obstacles, {
        from: conn.fromSide,
        to: conn.toSide,
      });
      const target: WireFrame = {
        samples: sampleRoute(route, ROUTE_SAMPLES),
        d: routePathData(route),
        arrow: routeArrowTip(route, conn.targetRect),
        label: routeLabelPoint(route, rectList),
      };

      const shown = shownRef.current.get(conn.key);
      if (!shown) {
        // A brand new wire is born where it belongs: appearing is not a layout jump.
        shownRef.current.set(conn.key, target);
        settled = true;
        continue;
      }

      const active = tweenRef.current.get(conn.key);
      if (active) {
        active.to = target.samples;
        active.target = target;
        active.rect = conn.targetRect;
        animating = true;
        continue;
      }

      if (reduced || polylineDistance(shown.samples, target.samples) <= ROUTE_JUMP) {
        shownRef.current.set(conn.key, target);
        settled = true;
        continue;
      }

      tweenRef.current.set(conn.key, {
        from: shown.samples,
        to: target.samples,
        target,
        rect: conn.targetRect,
        startedAt: now,
      });
      animating = true;
    }

    for (const key of [...shownRef.current.keys()]) {
      if (!keys.has(key)) {
        shownRef.current.delete(key);
        tweenRef.current.delete(key);
        settled = true;
      }
    }

    if (settled) setFrames(new Map(shownRef.current));
    if (animating && !frameRef.current) frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [connections, rects, rectList, reduced]);

  return frames;
}

/** Compact port list for the label: two ids, then a count. */
function portLabel(ports: string[]): string {
  if (ports.length === 0) return '';
  const shown = ports.slice(0, 2).join(' · ');
  return ports.length > 2 ? `${shown} +${ports.length - 2}` : shown;
}

// ── the draft wire: the one being dragged (G3) ───────────────────────────────────────
//
// The wire under the cursor is drawn HERE and not in a layer of its own, for the reason the
// whole layer exists: connections are subordinate, they never intercept the mouse, and a new
// interactive overlay is exactly what "drag a wire" must not introduce. The draft is one more
// path in the same `pointer-events: none` SVG, painted above the settled wires and masked by
// the same card cutout — so it looks like a wire because it *is* one, and it disappears into a
// card's face the same way every other wire does.
//
// It is never wired to anything: `wireGesture` owns the state, this file owns the drawing, and
// the only thing crossing between them is a `DropPlan` (already decided, never re-derived).

/** The side a wire enters when it ends at a bare point: the mirror of the side it left. */
const OPPOSITE_SIDE: Record<AnchorSide, AnchorSide> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

const DRAFT_THICKNESS = 2.5;
const DRAFT_DASH: readonly [number, number] = [7, 5];

/** One drawn draft: a curve, an arrowhead, and the colour/dash that state implies. */
interface DraftWire {
  d: string;
  arrow: string;
  color: string;
  dashed: boolean;
}

/**
 * Turn the gesture state into a wire, or `null` when nothing is being dragged.
 *
 * Two details are load-bearing:
 *   - the source end is the card edge that FACES the cursor (`facingSide`), so the curve always
 *     leaves towards the pointer instead of looping back over the card;
 *   - the arrowhead is parked on the target card's frame when the pointer is over one
 *     (`arrowTip`). Inside the frame the mask erases it, and an invisible arrow is not a
 *     direction cue — the same rule the settled wires follow.
 */
function draftWireFor(
  state: WireState,
  rects: Map<number, Rect>,
  zoom: number,
): DraftWire | null {
  if (state.phase !== 'wiring' || !state.point || state.sourceCardId === null) return null;
  const sourceRect = rects.get(state.sourceCardId);
  if (!sourceRect) return null;
  const fromSide = facingSide(sourceRect, state.point);
  const from = cardAnchor(state.sourceCardId, fromSide);
  if (!from) return null;

  const geometry = wireGeometry(from, state.point, fromSide, OPPOSITE_SIDE[fromSide]);
  const plan = state.plan;
  const targetRect =
    plan?.targetCardId === undefined ? undefined : rects.get(plan.targetCardId);
  const parked = targetRect ? arrowTip(geometry, targetRect) : null;
  const tip = parked ?? { tip: state.point, dir: cubicTangent(geometry, 1) };

  const refused = plan?.kind === 'reject';
  const cancel = !plan || plan.kind === 'cancel';
  const neutral = !refused && (cancel || plan?.kind === 'noop');
  return {
    d: pathData(geometry),
    arrow: arrowPathAt(tip.tip, tip.dir, zoom),
    color: refused ? COLOR_RED : neutral ? COLOR_GREY : COLOR_BLUE,
    // A dashed draft is the decision's "this release does nothing" cue (§六: blank canvas).
    dashed: cancel,
  };
}

// ── the drop label and the multi-output chooser (G3) ─────────────────────────────────
//
// Every string this gesture can say, per locale — the same shape `SourcePicker` and `ScriptCard`
// use, because this lane owns no dictionary file. `wireGesture` hands over NAMES (a port's
// variable, a file name); only the prose lives here.
//
// The label is rendered as a body-portaled badge carrying the stylesheet's `hover-help` box
// (fixed position, `pointer-events: none`): the cards are transform-positioned and clipped, so
// anything drawn inside one is displaced or cut off (see `Popup.tsx`), and a pointer-events:
// none badge cannot intercept the gesture that is producing it.

interface WireLabelSet {
  add: string;
  replace: string;
  replaceFresh: string;
  noop: string;
  refuseNoInput: string;
  refuseSelf: string;
  refuseCycle: string;
  refuseNoSource: string;
  cancel: string;
  choosePort: string;
  chooseAdd: string;
  chooseHint: string;
}

const WIRE_LABELS: Record<Locale, WireLabelSet> = {
  zh: {
    add: '新增端口 {port} ← {source}',
    replace: '替换端口 {port}（{previous} → {source}）',
    replaceFresh: '替换端口 {port} ← {source}',
    noop: '已经是 {card} 的输入 {port}',
    refuseNoInput: '此卡片不接受新输入 · 松开取消',
    refuseSelf: '不能接到自己 · 松开取消',
    refuseCycle: '会成环：{card} 已经依赖本卡 · 松开取消',
    refuseNoSource: '这张卡片还没有可接线的输出 · 松开取消',
    cancel: '松开取消',
    choosePort: '替换端口 {port}：接 {source} 的哪个输出',
    chooseAdd: '新增端口：接 {source} 的哪个输出',
    chooseHint: '这张卡声明了 {n} 个输出 — 接哪一个由你决定（不会替你猜 out:0）',
  },
  en: {
    add: 'Add port {port} ← {source}',
    replace: 'Replace port {port} ({previous} → {source})',
    replaceFresh: 'Replace port {port} ← {source}',
    noop: 'Already an input of {card} as {port}',
    refuseNoInput: 'This card accepts no new input · release to cancel',
    refuseSelf: 'A card cannot feed itself · release to cancel',
    refuseCycle: 'Would create a cycle: {card} already depends on this one · release to cancel',
    refuseNoSource: 'This card publishes no output to wire yet · release to cancel',
    cancel: 'Release to cancel',
    choosePort: 'Replace port {port}: which output of {source}?',
    chooseAdd: 'Add a port: which output of {source}?',
    chooseHint: '{n} outputs are declared — which one is wired is your call (out:0 is never assumed)',
  },
};

/** `{name}` / `{n}` substitution — the same one-liner `SourcePicker` uses. */
function fill(template: string, params: Record<string, string | number>): string {
  let text = template;
  for (const [key, value] of Object.entries(params)) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

/** The sentence shown at the pointer before the release, e.g. `新增端口 B ← c.csv`. */
function dropLabelText(plan: DropPlan, labels: WireLabelSet): string {
  const { label } = plan;
  switch (label.action) {
    case 'add':
      return fill(labels.add, { port: label.next ?? '', source: label.source });
    case 'replace':
      return label.previous !== null
        ? fill(labels.replace, {
            port: label.port ?? '',
            previous: label.previous,
            source: label.source,
          })
        : fill(labels.replaceFresh, { port: label.port ?? '', source: label.source });
    case 'noop':
      return fill(labels.noop, {
        card: plan.targetName ?? '',
        port: label.port ?? '',
      });
    case 'refuse':
      if (label.reason === 'cycle') {
        return fill(labels.refuseCycle, { card: plan.targetName ?? '' });
      }
      if (label.reason === 'self') return labels.refuseSelf;
      if (label.reason === 'noSource') return labels.refuseNoSource;
      return labels.refuseNoInput;
    case 'cancel':
      return labels.cancel;
  }
}

/** Distance between the pointer and the label, in px (same offset `HoverHelp` uses). */
const LABEL_OFFSET = 14;

/** One pickable output of a multi-output source (ruling 4A: the chooser, never `out:0`). */
const CHOICE_LABEL_STYLE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/**
 * The matrix chooser a multi-output source opens at the drop point.
 *
 * A popup rather than a silent commit, and one *after* the release rather than during it: the
 * gesture is already over when this appears, so nothing here can intercept the pointer
 * sequence, and dismissing it writes exactly nothing (the store is only called when a row is
 * picked). A source with a single output never reaches this component — it commits with zero
 * clicks.
 */
function WireChoiceMenu({ request }: { request: WireChoiceRequest }) {
  const { locale } = useTranslator();
  const labels = WIRE_LABELS[locale];
  const heading =
    request.portName !== null
      ? fill(labels.choosePort, { port: request.portName, source: request.plan.label.source })
      : fill(labels.chooseAdd, { source: request.plan.label.source });

  return (
    <Popup
      x={request.client.x}
      y={request.client.y}
      className="chart-card__popup chart-card__popup--wide wire-choice"
      onDismiss={() => dismissWireChoice()}
    >
      <div
        className="wire-choice__body"
        role="group"
        aria-label={heading}
        data-wire-choice={request.targetCardId}
        data-wire-choice-port={request.portId ?? undefined}
      >
        <div className="chart-card__field wire-choice__title">{heading}</div>
        <p className="context-menu__hint wire-choice__hint">
          {fill(labels.chooseHint, { n: request.choices.length })}
        </p>
        <ul className="formula-card__port-list">
          {request.choices.map((choice) => (
            <li key={choice.matrixId}>
              <button
                type="button"
                className="chart-card__popup-item wire-choice__item"
                data-matrix-id={choice.matrixId}
                data-output-id={choice.outputId ?? undefined}
                title={choice.label}
                onClick={() => pickWireChoice(choice.matrixId)}
              >
                <span className="source-picker__item-label" style={CHOICE_LABEL_STYLE}>
                  {choice.label}
                </span>
                {choice.outputId !== null ? (
                  <span className="script-card__output-id source-picker__item-id">
                    {choice.outputId}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Popup>
  );
}

interface ConnectionLayerProps {
  cards: CardModel[];
  selectedId: number | null;
  blockedCardId: number | null;
  /** Changes on every refused close so the blink restarts. */
  blockNonce: number;
  /** Current pan/zoom of the card plane; the layer counter-transforms by it. */
  view: { x: number; y: number; zoom: number };
  /** The store's dependency graph — the source of truth for which cards are connected. */
  dependencies: DependencyGraph;
}

export function ConnectionLayer({
  cards,
  selectedId,
  blockedCardId,
  blockNonce,
  view,
  dependencies,
}: ConnectionLayerProps) {
  const rects = useCardRects(cards);
  const connections = useConnectionGeometry(cards, selectedId, dependencies, rects);
  const hidden = useBlockedBlink(blockedCardId, blockNonce);
  const rectList = useMemo(() => [...rects.values()], [rects]);

  // The wire being dragged (G3). Subscribing here — not in a layer of its own — is what keeps
  // the draft in the background: this SVG is `pointer-events: none`, so an in-flight wire can
  // no more intercept the mouse than a settled one.
  const wire = useWireState();
  const draft = useMemo(
    () => draftWireFor(wire, rects, view.zoom),
    [wire, rects, view.zoom],
  );
  const { locale } = useTranslator();
  const wireLabels = WIRE_LABELS[locale];
  const wireText = draft !== null && wire.plan !== null ? dropLabelText(wire.plan, wireLabels) : null;

  const isHidden = (conn: Connection): boolean =>
    hidden.has(conn.dependsOn) || hidden.has(conn.dependent);

  const background = connections.filter((c) => !c.highlighted && !isHidden(c));
  const foreground = connections.filter((c) => c.highlighted && !isHidden(c));

  // One mask, reused by both line groups: white everywhere, a black hole per card. The
  // lines therefore stop at every card edge, exactly like lines drawn on the MDI desktop —
  // and that is also what turns port-to-port endpoints into frame-to-frame wires.
  const maskId = 'connection-card-cutout';

  const frames = useReflowedWires(connections, rects, rectList);

  const renderLine = (conn: Connection, framed: boolean) => {
    const frame = frames.get(conn.key);
    if (!frame) return null;
    const arrow = frame.arrow;
    // The whole layer sits inside a `scale(zoom)` group, so widths and dash lengths are
    // converted to user units here instead of relying on `vector-effect` (which does not
    // cover dash patterns, and left them zoom-dependent).
    const style: CSSProperties = framed
      ? ({
          animationDuration: `${dashDuration(conn.direction)}s`,
          '--connection-dash-cycle': `${dashCycle(conn.direction, view.zoom)}px`,
        } as CSSProperties)
      : {};

    return (
      <g key={conn.key} className={`connection connection--${framed ? 'fg' : 'bg'}`}>
        <path
          className={`connection__wire${framed ? ' connection__wire--flow' : ''}`}
          d={frame.d}
          stroke={conn.color}
          strokeWidth={(framed ? 3 : 1.5) / view.zoom}
          strokeDasharray={framed ? dashArray(conn.direction, view.zoom) : undefined}
          style={style}
        />
        {arrow ? (
          <path
            className="connection__arrow"
            d={arrowPathAt(arrow.tip, arrow.dir, view.zoom)}
            fill={conn.color}
          />
        ) : null}
        {framed && conn.ports.length > 0 ? (
          <ConnectionLabel
            conn={conn}
            point={frame.label}
            zoom={view.zoom}
          />
        ) : null}
      </g>
    );
  };

  // The SVG itself stays pinned to the viewport (a plane-sized SVG would be rasterised
  // as one enormous layer); only its contents are counter-translated, so everything below
  // can keep working in unbounded *plane* coordinates — the same space the anchors are
  // measured in (see cardMetrics).
  return (
    <>
      <svg className="connection-layer" aria-hidden="true">
      {/* Same transform as the world layer: translate *after* scale, so a plane point
          (px, py) lands at (px*zoom - view.x, py*zoom - view.y) in viewport px. */}
      <g transform={`translate(${-view.x}, ${-view.y}) scale(${view.zoom})`}>
        <defs>
          {/* The region is stated explicitly: an unset one defaults to one viewport of
              plane coordinates anchored at the origin, which erases every wire beyond it
              no matter how large the backdrop rect is. See MASK_EXTENT. */}
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            maskContentUnits="userSpaceOnUse"
            x={-MASK_EXTENT}
            y={-MASK_EXTENT}
            width={MASK_EXTENT * 2}
            height={MASK_EXTENT * 2}
          >
            {/* Covers the whole unbounded plane, not just the viewport: this group is
                counter-translated by the pan, so a `100%` rect would whiten only the first
                screenful of plane coordinates and silently erase every line beyond it. */}
            <rect
              x={-MASK_EXTENT}
              y={-MASK_EXTENT}
              width={MASK_EXTENT * 2}
              height={MASK_EXTENT * 2}
              fill="#ffffff"
            />
            {rectList.map((rect, index) => (
              <rect
                key={index}
                x={rect.left}
                y={rect.top}
                width={rect.width}
                height={rect.height}
                fill="#000000"
              />
            ))}
          </mask>
        </defs>
        {/* No end-point dots: this SVG paints *behind* the cards, so a marker at either
            end was occluded by the card it referred to. The arrowhead sits just outside the
            target card's frame instead, and the label spells the port ids out while a card
            is selected. */}
        <g mask={`url(#${maskId})`}>
          {background.map((conn) => renderLine(conn, false))}
        </g>
        <g mask={`url(#${maskId})`}>
          {foreground.map((conn) => renderLine(conn, true))}
        </g>
        {/* The wire under the cursor (G3): same mask, same "behind the cards" rule, painted
            last so it reads above the settled wires while a drag is in flight. */}
        {draft !== null ? (
          <g className="connection connection--draft">
            <g mask={`url(#${maskId})`}>
              <path
                className="connection__wire connection__wire--draft"
                d={draft.d}
                stroke={draft.color}
                strokeWidth={DRAFT_THICKNESS / view.zoom}
                strokeDasharray={
                  draft.dashed
                    ? `${DRAFT_DASH[0] / view.zoom} ${DRAFT_DASH[1] / view.zoom}`
                    : undefined
                }
              />
              <path className="connection__arrow" d={draft.arrow} fill={draft.color} />
            </g>
          </g>
        ) : null}
      </g>
    </svg>
      {/* The label that says what the release would do, before it does it (决策 §六). It is a
          pointer-events:none badge portaled to the body: the cards are transformed and clipped,
          so a badge drawn inside the layer (or inside a card) would be displaced, cut off or —
          since this SVG paints *behind* the cards — erased. */}
      {wireText !== null && wire.client !== null ? (
        <WireDropLabel text={wireText} plan={wire.plan} client={wire.client} />
      ) : null}
      {wire.choosing !== null ? <WireChoiceMenu request={wire.choosing} /> : null}
    </>
  );
}

/** The pre-release badge: text plus the action it describes, at the pointer. */
function WireDropLabel({
  text,
  plan,
  client,
}: {
  text: string;
  plan: DropPlan | null;
  client: { x: number; y: number };
}) {
  return createPortal(
    <div
      className="hover-help wire-drop-label"
      data-wire-drop={plan?.kind ?? 'cancel'}
      data-wire-reason={plan?.label.reason ?? undefined}
      data-wire-target={plan?.targetCardId ?? undefined}
      data-wire-port={plan?.portId ?? undefined}
      style={{ left: client.x + LABEL_OFFSET, top: client.y + LABEL_OFFSET }}
    >
      {text}
    </div>,
    document.body,
  );
}

/** Port ids on the line, shown only while one of its two cards is selected. */
function ConnectionLabel({
  conn,
  point,
  zoom,
}: {
  conn: Connection;
  point: Point;
  zoom: number;
}) {
  return (
    <text
      className="connection__label"
      x={point.x}
      y={point.y}
      fill={conn.color}
      fontSize={11 / zoom}
      stroke="#ffffff"
      strokeWidth={3 / zoom}
      paintOrder="stroke"
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {portLabel(conn.ports)}
    </text>
  );
}

export { COLOR_GREY, COLOR_RED, COLOR_BLUE };
