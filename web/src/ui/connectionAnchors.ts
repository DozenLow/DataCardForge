/**
 * Where an edge attaches: the two wire endpoints, in plane coordinates.
 *
 * Since 2026-11-17 a wire is anchored on the **port sub-cards** it belongs to
 * (`docs/decisions/2026-11-17-port-anchored-connections.md`):
 *
 *   - the target side is named by the edge itself (`edge.ports` are the dependent's port
 *     ids), so a rendered port is measured and used;
 *   - the source side is not named by the edge. It is recovered through the *data*, not by
 *     guessing: each target input points at a local `matrixId`, and `publishedMatrices`
 *     says which output of the source card publishes that id (that module is the only one
 *     that knows "ordinal 0 IS the card's displayMatrixId");
 *   - an end with no rendered port (a data card publishing a file, a chart reading columns)
 *     falls back to the card edge that faces the other end.
 *
 * Kept as a pure module (DOM measurement arrives through `measurePort`) so the priority
 * order, the multi-port average and the fallback clamp can be unit-tested without a layout
 * engine. One pair of cards is still exactly one edge and therefore one line: an edge that
 * carries several ports averages their anchors instead of fanning out.
 */
import { portAnchor, type Anchor, type AnchorSide, type Rect } from './cardMetrics.ts';
import type { Point } from './connectionGeometry.ts';
import { publishedMatrices } from './workspaceStore.ts';
import type { PortConnection, CardModel } from './types.ts';
import type { DependencyEdge } from '../core/DependencyGraph.ts';

/** One end of a wire, after every fallback has been applied. */
export interface ResolvedEnd {
  point: Point;
  side: AnchorSide;
  /** Port ids whose rendered anchors were averaged. Empty when the card-edge fallback ran. */
  portIds: string[];
  /** True when the end is a rendered port; false means "card edge facing the other end". */
  viaPort: boolean;
}

export interface EdgeAnchors {
  from: ResolvedEnd;
  to: ResolvedEnd;
}

/**
 * Inset used when a fallback anchor is placed from the other end's coordinate.
 *
 * A fallback anchor sits ON the card's edge (that is where a card edge is); the inset only
 * keeps the borrowed coordinate off the edge's very corner, where the wire would clip it.
 */
const FALLBACK_INSET = 8;

/**
 * How a port is measured. The connection layer passes `cardMetrics.portAnchor`; tests pass
 * a stub so the priority rules stay testable without a DOM.
 */
export type PortMeasure = (cardId: number, portId: string) => Anchor | null;

function centreOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function clamp(value: number, min: number, max: number): number {
  // A card can be smaller than the inset (only before the first measure), so the clamp
  // range is normalised instead of trusting min <= max.
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.min(Math.max(value, low), high);
}

/**
 * Keep a measured anchor on its own card.
 *
 * A row scrolled out of its panel still reports a layout rectangle — sometimes outside the
 * card — and an anchor there would make the wire appear out of thin air. Clamping to the
 * frame (not inside it) keeps a port that sits on the edge exactly where the card ends.
 */
function clampToRect(point: Point, rect: Rect): Point {
  return {
    x: clamp(point.x, rect.left, rect.left + rect.width),
    y: clamp(point.y, rect.top, rect.top + rect.height),
  };
}

/**
 * The side of `rect` that faces `point` — dominant axis first.
 *
 * Used only for ends without a rendered port: a card edge has no intrinsic side, so the
 * side is whatever faces the other end (the 2026-10-28 rule).
 */
export function facingSide(rect: Rect, point: Point): AnchorSide {
  const centre = centreOf(rect);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** Midpoint of `side` on `rect`. */
function sidePoint(rect: Rect, side: AnchorSide): Point {
  const centre = centreOf(rect);
  switch (side) {
    case 'left':
      return { x: rect.left, y: centre.y };
    case 'right':
      return { x: rect.left + rect.width, y: centre.y };
    case 'top':
      return { x: centre.x, y: rect.top };
    case 'bottom':
      return { x: centre.x, y: rect.top + rect.height };
  }
}

/**
 * Anchor for an end that renders no port.
 *
 * `ownMidpoint` is the "neither end has a port" case: each card anchors on its dotted side's
 * midpoint, which is symmetric and depends on nothing but the two rectangles. Otherwise the
 * anchor takes the other end's coordinate (clamped into this card), so a wire bound to a
 * port stays level up to the edge instead of angling away from the row it belongs to.
 */
function fallbackEnd(rect: Rect, towards: Point, ownMidpoint: boolean): ResolvedEnd {
  const side = facingSide(rect, towards);
  if (ownMidpoint) {
    return { point: sidePoint(rect, side), side, portIds: [], viaPort: false };
  }
  const point =
    side === 'left' || side === 'right'
      ? {
          x: side === 'left' ? rect.left : rect.left + rect.width,
          y: clamp(towards.y, rect.top + FALLBACK_INSET, rect.top + rect.height - FALLBACK_INSET),
        }
      : {
          x: clamp(towards.x, rect.left + FALLBACK_INSET, rect.left + rect.width - FALLBACK_INSET),
          y: side === 'top' ? rect.top : rect.top + rect.height,
        };
  return { point, side, portIds: [], viaPort: false };
}

/**
 * Average the rendered anchors of one end.
 *
 * The average is what keeps "one pair of cards, one line" true while several columns of one
 * table feed the same card. Returns `null` when none of the ids is rendered.
 */
function resolvePorts(
  cardId: number,
  portIds: readonly string[],
  measurePort: PortMeasure,
  rect: Rect,
): ResolvedEnd | null {
  const resolved: Array<{ portId: string; anchor: Anchor }> = [];
  for (const portId of portIds) {
    const anchor = measurePort(cardId, portId);
    if (anchor) resolved.push({ portId, anchor });
  }
  if (resolved.length === 0) return null;

  let x = 0;
  let y = 0;
  for (const { anchor } of resolved) {
    const point = clampToRect(anchor, rect);
    x += point.x;
    y += point.y;
  }
  return {
    point: { x: x / resolved.length, y: y / resolved.length },
    side: resolved[0].anchor.side,
    portIds: resolved.map((entry) => entry.portId),
    viaPort: true,
  };
}

/**
 * The source card's output ids for this edge.
 *
 * `edge.ports` names the *target* ports; each of those inputs points at a local matrix id,
 * and the source's published matrices map that id back to an `outputId` (`out:1`, `result`,
 * …). A target input that cannot be mapped contributes nothing — inventing output 0 here
 * would anchor the wire on the wrong row.
 */
function sourceOutputIds(
  target: CardModel,
  portIds: readonly string[],
  source: CardModel,
): string[] {
  const published = publishedMatrices(source);
  if (published.length === 0) return [];
  const outputs: string[] = [];
  for (const portId of portIds) {
    const input: PortConnection | undefined = target.inputs.find(
      (entry) => entry.portId === portId,
    );
    if (!input) continue;
    const match = published.find((entry) => entry.matrixId === input.target.matrixId);
    if (!match || match.outputId === null) continue;
    if (!outputs.includes(match.outputId)) outputs.push(match.outputId);
  }
  return outputs;
}

/**
 * Resolve both wire endpoints for one edge.
 *
 * Returns `null` when either card (or its rectangle) is missing: the layer skips the edge
 * instead of guessing a position.
 */
export function resolveEdgeAnchors(
  edge: DependencyEdge,
  cards: readonly CardModel[],
  rects: Map<number, Rect>,
  measurePort: PortMeasure = portAnchor,
): EdgeAnchors | null {
  const source = cards.find((card) => card.id === edge.dependsOn);
  const target = cards.find((card) => card.id === edge.dependent);
  if (!source || !target) return null;
  const sourceRect = rects.get(edge.dependsOn);
  const targetRect = rects.get(edge.dependent);
  if (!sourceRect || !targetRect) return null;

  const targetEnd = resolvePorts(edge.dependent, edge.ports, measurePort, targetRect);
  const sourceEnd = resolvePorts(
    edge.dependsOn,
    sourceOutputIds(target, edge.ports, source),
    measurePort,
    sourceRect,
  );

  if (sourceEnd && targetEnd) return { from: sourceEnd, to: targetEnd };
  if (sourceEnd) {
    // The target renders no port: enter on the edge that faces the source's port.
    return { from: sourceEnd, to: fallbackEnd(targetRect, sourceEnd.point, false) };
  }
  if (targetEnd) {
    return { from: fallbackEnd(sourceRect, targetEnd.point, false), to: targetEnd };
  }
  // Neither end has a rendered port (data card -> chart card, for example): both cards
  // anchor on their own facing edge midpoint, exactly like the pre-2026-10-29 rule.
  return {
    from: fallbackEnd(sourceRect, centreOf(targetRect), true),
    to: fallbackEnd(targetRect, centreOf(sourceRect), true),
  };
}

