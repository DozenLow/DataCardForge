/**
 * Cancel the browser's own context menu for the whole workbench — tasks G1 (S1) + G2 (S2) of
 * `docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md` §八.
 *
 * Why the native menu has to go: this application owns right-click. A right-click is how a
 * card is born (VirtualTable column header, FormulaCard result header, ScriptCard output row)
 * and — from task G3 on — how a wire is dragged from one card to another. The browser's menu
 * sits on the same button and has nothing to offer here ("Save page as…", "Inspect"), and no
 * API can defer it while a gesture decides between click and drag: it can only be cancelled.
 * So it is cancelled once, at the window, for the whole application.
 *
 * Three invariants make that safe, and none may be relaxed to make a test pass:
 *
 *   1. `preventDefault()` only — never `stopPropagation()`. All four self-rendered menus
 *      (VirtualTable column header, FormulaCard result header, ScriptCard output row, the bare
 *      canvas in `App.tsx`) are React `onContextMenu` handlers, and React sees the event at
 *      the root *after* this window-capture listener. Cancelling the default action does not
 *      cancel dispatch, so those handlers keep running; stopping propagation here would
 *      silently disable every one of them.
 *
 *   2. EVERY target is cancelled, editing surfaces included (G2). G1 kept a temporary
 *      exemption here so `input` / `textarea` / CodeMirror kept the browser's paste menu;
 *      that exemption is now deleted, because the application renders its own editing menu
 *      instead. The order matters and is why this landed only after `EditingMenu` existed:
 *      the other way around leaves the script editor unable to paste for the length of a
 *      release.
 *
 *   3. An editing surface gets our menu, not nothing. Cancelling the native menu on a text
 *      field is only acceptable if the application offers copy / cut / paste / select all on
 *      that field, so the listener asks `resolveEditingSurface` — which knows CodeMirror and
 *      plain fields and canPaste/canCopy per surface — and dispatches a request the mounted
 *      `EditingMenuHost` answers (`EDITING_MENU_REQUEST_EVENT`). Non-editing targets get no
 *      request: the card menus are handlers, not requests, and G3's wire gesture decides at
 *      `pointerup`.
 *
 * Installation is idempotent across hot reloads: the live listener is parked on the window
 * under a `Symbol.for` key, so a re-evaluated module replaces its predecessor instead of
 * stacking a second copy.
 *
 * Note: a keyboard-invoked `contextmenu` (Shift+F10 / the menu key) arrives on this same path
 * as an ordinary event and is handled like any other — G1's suppression is decided by the
 * target alone, and an editing surface opens the same menu, anchored to the surface itself
 * when the event carries no pointer position.
 */
import {
  requestEditingMenu,
  resolveEditingSurface,
} from './editingSurface.ts';

const LISTENER_SLOT = Symbol.for('datacardforge.suppressNativeMenu.listener');

/** Only `capture` affects listener identity matching; the flag is the whole registration. */
const LISTENER_OPTIONS = { capture: true } as const;

type InstalledListener = (event: Event) => void;

/** The installed listener, parked on the window so a re-evaluated module can replace it. */
type ListenerHost = Record<symbol, unknown>;

/**
 * Where the editing menu should open.
 *
 * A pointer-driven `contextmenu` carries the pointer position, which is where a menu belongs.
 * A keyboard-driven one carries (0, 0), and opening at the top-left of the viewport would put
 * the menu nowhere near the field the user just focused — so it is anchored to the surface's
 * left/bottom edge instead. The `clientX !== 0 || clientY !== 0` test is deliberately not
 * "inside the viewport": (0, 0) is the value a keyboard event uses, and a pointer that really
 * is at the origin still resolves to a menu that opens a few pixels away.
 */
function menuPosition(event: Event, target: EventTarget | null): { x: number; y: number } {
  if (
    typeof MouseEvent !== 'undefined' &&
    event instanceof MouseEvent &&
    (event.clientX !== 0 || event.clientY !== 0)
  ) {
    return { x: event.clientX, y: event.clientY };
  }
  if (target instanceof Element) {
    const rect = target.getBoundingClientRect();
    if (rect.width !== 0 || rect.height !== 0) return { x: rect.left, y: rect.bottom };
  }
  return { x: 0, y: 0 };
}

/**
 * The one window-level handler: cancel the native menu, then offer ours where we own one.
 *
 * `stopPropagation` must not be added here — the four React `onContextMenu` handlers live
 * downstream of this listener and depend on the event continuing to bubble.
 */
export function suppressNativeContextMenu(event: Event): void {
  // The ruling is unconditional: the browser's menu never appears, for any target.
  event.preventDefault();

  // Then, for a text surface only, ask the application for the replacement menu. A target
  // without an adapter (a card, the canvas, an empty stretch of body) stops here: those
  // targets have their own React handlers, and there is nothing to dispatch to.
  if (resolveEditingSurface(event.target) === null) return;
  requestEditingMenu({ ...menuPosition(event, event.target), target: event.target });
}

/**
 * Install the window-level suppression on `target` (default: the current window) and return a
 * release function. Installing again on the same window replaces the previous listener rather
 * than stacking a duplicate, which is what makes hot reload safe.
 *
 * `main.tsx` calls this once before the first render; tests call it per case.
 */
export function installNativeMenuSuppression(target: Window = window): () => void {
  const host = target as unknown as ListenerHost;
  const previous = host[LISTENER_SLOT];
  if (typeof previous === 'function') {
    target.removeEventListener('contextmenu', previous as InstalledListener, LISTENER_OPTIONS);
  }
  target.addEventListener('contextmenu', suppressNativeContextMenu, LISTENER_OPTIONS);
  host[LISTENER_SLOT] = suppressNativeContextMenu;

  return () => {
    // A later install may already have replaced this listener; then there is nothing of ours
    // left to remove, and removing anyway would tear out the newer registration.
    if (host[LISTENER_SLOT] !== suppressNativeContextMenu) return;
    target.removeEventListener('contextmenu', suppressNativeContextMenu, LISTENER_OPTIONS);
    Reflect.deleteProperty(host, LISTENER_SLOT);
  };
}