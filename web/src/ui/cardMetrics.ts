/**
 * Card anchor metrics.
 *
 * The Qt frontend drew connection lines by asking every widget for a global point
 * (`mapToGlobal`) on each repaint. The web equivalent needs the same information,
 * but the platform gives it to us only through the DOM. This module is the single
 * place where that DOM measurement happens:
 *
 *   - a card registers its root element once,
 *   - a card that renders ports registers each one by `portId` (the measurement is looked
 *     up by id, never by position),
 *   - the connection layer asks for `cardRect()` / `portAnchor()` in canvas coordinates and
 *     never touches the DOM itself.
 *
 * All measurements are in CSS pixels relative to the canvas container, so window
 * scroll and devicePixelRatio do not have to be handled twice.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CardMetrics {
  root: HTMLElement;
}

/** Monotonic counter bumped whenever a measurement could have changed. */
let layoutVersion = 0;
const listeners = new Set<() => void>();
const cards = new Map<number, CardMetrics>();
/**
 * Two different references, because the canvas is now a pannable, unbounded plane:
 *
 *   - `viewportElement` is the visible clipping box — its *size* answers "how much room
 *     does the user have on screen" (Tile/Cascade, new-card placement).
 *   - `worldElement` is the origin of the card coordinate system. It carries the pan
 *     transform, so `getBoundingClientRect()` differences against it stay in plane
 *     coordinates no matter how far the view has been panned — the same trick that used
 *     to make scroll position a non-issue.
 *
 * Before the plane was pannable these were the same element, which is why the module
 * predates the split.
 */
let viewportElement: HTMLElement | null = null;
let worldElement: HTMLElement | null = null;

export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLayoutVersion(): number {
  return layoutVersion;
}

/** Mark the layout dirty; React subscribers recompute on the next frame. */
export function invalidateLayout(): void {
  layoutVersion += 1;
  for (const listener of listeners) listener();
}

export function setCanvasElement(element: HTMLElement | null): void {
  viewportElement = element;
  invalidateLayout();
}

/** Register the panned world layer that defines the card coordinate origin. */
export function setWorldElement(element: HTMLElement | null): void {
  worldElement = element;
  invalidateLayout();
}

export function registerCard(id: number, root: HTMLElement): void {
  cards.set(id, { root });
  invalidateLayout();
}

export function unregisterCard(id: number): void {
  if (cards.delete(id)) invalidateLayout();
}

/**
 * Size of the *visible* canvas viewport, in CSS px.
 *
 * `Tile`/`Cascade` and new-card placement must measure *this*, not the window or the app
 * shell: the shell also contains the menu bar and the status bar, so sizing cards from it
 * made every tiled card ~48px taller than the canvas and pushed its bottom edge (and the
 * south-east resize handle) off-screen. Note it is the viewport, not the card plane: the
 * plane is unbounded, so "how big is the canvas" only means anything on screen.
 */
/**
 * Zoom bounds for the whole workbench. Shared by the store (zoom-to-fit) and the canvas
 * (wheel zoom), so the two can never disagree about how far the view may go.
 *
 * The lower bound is deliberately far out: "adapt the view to the cards" (View → Reset
 * View) is the answer to a workflow that spans several screens, and at 20% that answer
 * only reaches ~5 screenfuls — the very complaint that started this feature. Text is
 * unreadable down there, which is fine: it is an overview, not a reading mode.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;

/** Current zoom of the world layer. 1 = 100%. */
let worldScale = 1;

/**
 * Publish the zoom so measurements can be converted back into plane units.
 *
 * `getBoundingClientRect()` reports *scaled* screen pixels, so every difference has to be
 * divided by the zoom before it means anything in card coordinates — the same reason the
 * pan cancels out of the differences.
 */
export function setCanvasZoom(zoom: number): void {
  if (zoom === worldScale || !Number.isFinite(zoom) || zoom <= 0) return;
  worldScale = zoom;
  invalidateLayout();
}

export function getCanvasZoom(): number {
  return worldScale;
}

export function canvasSize(): { width: number; height: number } {
  if (!viewportElement) return { width: 0, height: 0 };
  const rect = viewportElement.getBoundingClientRect();
  // Reported in *plane* units: every caller places cards with it (Tile/Cascade), and at
  // 50% zoom the same screen box holds twice as many plane pixels.
  return { width: rect.width / worldScale, height: rect.height / worldScale };
}

/**
 * Origin of the card coordinate system, in screen px.
 *
 * Every measurement is a difference against this rectangle, so panning cancels out and
 * all anchors stay in unbounded plane coordinates.
 */
function canvasRect(): Rect {
  const element = worldElement ?? viewportElement;
  if (!element) return { left: 0, top: 0, width: 0, height: 0 };
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * The visible viewport rectangle expressed in plane coordinates.
 *
 * New cards are placed relative to *this*: with an unbounded plane there is no "canvas
 * edge" to clamp against any more, but a card must still be born where the user can see
 * it. Panning moves the rectangle, so a card created after panning lands in view.
 */
export function viewportRectInWorld(): Rect {
  if (!viewportElement) return { left: 0, top: 0, width: 0, height: 0 };
  const origin = canvasRect();
  const v = viewportElement.getBoundingClientRect();
  return {
    left: (v.left - origin.left) / worldScale,
    top: (v.top - origin.top) / worldScale,
    width: v.width / worldScale,
    height: v.height / worldScale,
  };
}

function toCanvas(rect: DOMRect, canvas: Rect): Rect {
  // Screen differences divided by the zoom: the world layer is CSS-scaled, so a card that
  // measures 400px wide on screen is 200 plane px at 200% zoom.
  return {
    left: (rect.left - canvas.left) / worldScale,
    top: (rect.top - canvas.top) / worldScale,
    width: rect.width / worldScale,
    height: rect.height / worldScale,
  };
}

export function cardRect(id: number): Rect | null {
  const metrics = cards.get(id);
  if (!metrics) return null;
  return toCanvas(metrics.root.getBoundingClientRect(), canvasRect());
}

/**
 * Every registered card's rectangle, by card id.
 *
 * The hit test of the wiring gesture (G3) resolves a drop against *all* cards at once, so it
 * asks for the whole measured set instead of guessing which card ids exist. The map is
 * paint-order-agnostic; the caller decides which card wins an overlap (the store's `z`).
 */
export function allCardRects(): Map<number, Rect> {
  const origin = canvasRect();
  const out = new Map<number, Rect>();
  for (const [id, metrics] of cards) {
    out.set(id, toCanvas(metrics.root.getBoundingClientRect(), origin));
  }
  return out;
}

/** One rendered port row, measured in plane coordinates. */
export interface MeasuredPortRow {
  cardId: number;
  portId: string;
  rect: Rect;
}

/**
 * Every element inside a registered card that carries `data-port-id`, in plane coordinates.
 *
 * This is a *hit-test* measurement, which is why it is taken from the DOM attribute rather
 * than from the `registerPort` registry: the registry answers "where does this port's WIRE
 * attach" (one anchor per port, and a folded column's rail item is an anchor without being a
 * row), while a drop has to know where the ROW itself is on screen. `ScriptCard` puts the
 * attribute on the very element it also registers as the anchor, so the two can never
 * disagree about where a port is; `ColumnDock` puts it on chart port rows, which the gesture
 * refuses as targets anyway (a chart accepts no new input).
 *
 * Cards are measured through the same origin as everything else in this module, so a port row
 * and the card that contains it are always expressed in one coordinate system.
 */
export function measuredPortRows(): MeasuredPortRow[] {
  const origin = canvasRect();
  const out: MeasuredPortRow[] = [];
  for (const [cardId, metrics] of cards) {
    for (const element of metrics.root.querySelectorAll<HTMLElement>('[data-port-id]')) {
      const portId = element.dataset.portId;
      if (!portId) continue;
      out.push({ cardId, portId, rect: toCanvas(element.getBoundingClientRect(), origin) });
    }
  }
  return out;
}

/**
 * Convert a *viewport* point (a pointer's `clientX/clientY`) into plane coordinates.
 *
 * Two spaces differ by the pan and the zoom, and the conversion has to use the same origin the
 * rest of this module measures against. Deriving it from the store's `view` instead would be a
 * second source of truth: a draft wire computed from the store and a drop hit-test resolved
 * from `cardRect()` would disagree about where the cards are the moment the two drift apart
 * (a clamped pan, a frame of animation), and the wire would point somewhere the drop does not
 * land. The measured origin cannot drift — it *is* what `cardRect` subtracts.
 *
 * `worldScale` (published by `setCanvasZoom`) is the zoom factor the plane is drawn at, so
 * dividing by it converts screen pixels back into plane pixels. With no world layer registered
 * (a unit test, or before the canvas mounts) the origin is (0,0) and the scale 1, which makes
 * the conversion the identity — never NaN, never a guess.
 */
export function clientToPlane(clientX: number, clientY: number): { x: number; y: number } {
  const origin = canvasRect();
  return { x: (clientX - origin.left) / worldScale, y: (clientY - origin.top) / worldScale };
}

/**
 * Which side of a card a line leaves from or enters into.
 *
 * A line is not just two points: the side decides the bezier's control points *and* the
 * direction of the arrowhead. Sending every wire out of the top edge made a card that
 * sits below its source bend the line back over itself; a port on the left column and an
 * output on the right column left/entered horizontally.
 *
 * **Since 2026-11-17 the connection layer reads this again**: a wire leaves/enters on the
 * registered side of the port it is bound to, so the side is once more part of the geometry
 * (`wireGeometry(from, to, fromSide, toSide)`), not just a data attribute.
 */
export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface Anchor {
  x: number;
  y: number;
  side: AnchorSide;
}

/** Port anchors registered by the cards that actually render ports (2026-10-28). */
const ports = new Map<number, Map<string, { element: HTMLElement; side: AnchorSide }>>();

/**
 * Register one rendered port element as a line endpoint.
 *
 * `portId` — not its position — is the identity (port-semantics-v1 §已锁定 1). Cards call
 * this from a ref callback, with the side the wire has to leave from.
 *
 * Since 2026-11-17 the connection layer reads these anchors again
 * (`docs/decisions/2026-11-17-port-anchored-connections.md`): a wire anchors on the port's
 * window-side edge when the port is rendered, and falls back to the facing card edge when
 * it is not. Identity is still `portId` (the edge carries it and the measurement is looked
 * up by it); position is only the *geometry* that id happens to occupy today.
 */
export function registerPort(
  cardId: number,
  portId: string,
  element: HTMLElement,
  side: AnchorSide = 'left',
): void {
  let cardPorts = ports.get(cardId);
  if (!cardPorts) {
    cardPorts = new Map();
    ports.set(cardId, cardPorts);
  }
  cardPorts.set(portId, { element, side });
  invalidateLayout();
}

export function unregisterPort(cardId: number, portId: string): void {
  const cardPorts = ports.get(cardId);
  if (!cardPorts || !cardPorts.delete(portId)) return;
  if (cardPorts.size === 0) ports.delete(cardId);
  invalidateLayout();
}

/**
 * Midpoint of the registered SIDE of a port element, in plane coordinates.
 *
 * The side edge — not the element's centre — because the wire has to read as leaving the
 * port sub-card: an input chip's line starts at its left edge, an output row's at its right
 * edge. The card's own mask then hides whatever little stub is left between that edge and
 * the window frame, so the visible line begins exactly on the frame at the port's height.
 *
 * The result is clamped into the owning card's rectangle: a row scrolled out of its panel
 * still reports a layout rectangle (possibly outside the card), and an anchor outside its
 * own card would make the wire appear from thin air. Clamping to the frame — not inside it —
 * keeps a port that sits on the edge exactly where the card ends.
 */
export function portAnchor(cardId: number, portId: string): Anchor | null {
  const entry = ports.get(cardId)?.get(portId);
  if (!entry) return null;
  const r = entry.element.getBoundingClientRect();
  const origin = canvasRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  let point = { x, y };
  switch (entry.side) {
    case 'left':
      point = { x: r.left, y };
      break;
    case 'right':
      point = { x: r.right, y };
      break;
    case 'top':
      point = { x, y: r.top };
      break;
    case 'bottom':
      point = { x, y: r.bottom };
      break;
  }
  const anchor = {
    x: (point.x - origin.left) / worldScale,
    y: (point.y - origin.top) / worldScale,
  };
  const card = cardRect(cardId);
  if (card) {
    anchor.x = Math.min(Math.max(anchor.x, card.left), card.left + card.width);
    anchor.y = Math.min(Math.max(anchor.y, card.top), card.top + card.height);
  }
  return { ...anchor, side: entry.side };
}

/** Anchor on one side of a card: top/bottom mid-point, or left/right mid-height. */
export function cardAnchor(id: number, side: AnchorSide = 'top'): Anchor | null {
  const rect = cardRect(id);
  if (!rect) return null;
  switch (side) {
    case 'top':
      return { x: rect.left + rect.width / 2, y: rect.top, side };
    case 'bottom':
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height, side };
    case 'left':
      return { x: rect.left, y: rect.top + rect.height / 2, side };
    case 'right':
      return { x: rect.left + rect.width, y: rect.top + rect.height / 2, side };
  }
}

/** Anchor at the top-centre of a card — the card-level fallback this layer used to use. */
export function cardTopAnchor(id: number): Anchor | null {
  return cardAnchor(id, 'top');
}

/** Reset everything — used when the whole workspace is replaced. */
export function resetMetrics(): void {
  cards.clear();
  ports.clear();
  invalidateLayout();
}
