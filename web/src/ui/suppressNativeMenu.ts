/**
 * Cancel the browser's own context menu for the whole workbench — task G1, step S1 of
 * `docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md` §八.
 *
 * Why the native menu has to go: this application owns right-click. A right-click is how a
 * card is born (VirtualTable column header, FormulaCard result header, ScriptCard output row)
 * and — from task G3 on — how a wire is dragged from one card to another. The browser's menu
 * sits on the same button and has nothing to offer here ("Save page as…", "Inspect"), and no
 * API can defer it while a gesture decides between click and drag: it can only be cancelled.
 * So it is cancelled once, at the window, for the whole application.
 *
 * Two invariants make that safe, and neither may be relaxed to make a test pass:
 *
 *   1. `preventDefault()` only — never `stopPropagation()`. All four self-rendered menus
 *      (VirtualTable column header, FormulaCard result header, ScriptCard output row, the bare
 *      canvas in `App.tsx`) are React `onContextMenu` handlers, and React sees the event at
 *      the root *after* this window-capture listener. Cancelling the default action does not
 *      cancel dispatch, so those handlers keep running; stopping propagation here would
 *      silently disable every one of them.
 *
 *   2. Editing surfaces keep the native menu for now. Until task G2 ships the self-rendered
 *      editing menu, the browser's paste / spelling menu is the only clipboard path an
 *      `input`, a `textarea` or the CodeMirror script editor has; suppressing it there would
 *      leave the editor unable to paste. G2 deletes this exemption (§八).
 *
 * Installation is idempotent across hot reloads: the live listener is parked on the window
 * under a `Symbol.for` key, so a re-evaluated module replaces its predecessor instead of
 * stacking a second copy.
 *
 * Note: a keyboard-invoked `contextmenu` (Shift+F10 / the menu key) arrives on this same path
 * as an ordinary event and is cancelled like any other — G1's suppression is decided by the
 * target alone. The project's own right-click semantics are pointer-derived (decision §七),
 * so nothing of ours opens from the keyboard.
 */

/**
 * Targets that keep the browser's own menu: text entry (native paste / spelling), option
 * picking, and CodeMirror 6's editable DOM. `.cm-content` is listed alongside
 * `[contenteditable="true"]` because CodeMirror guarantees the class while the attribute is
 * only its default; either hit is enough. Temporary — see invariant 2 above.
 */
export const EDITING_SURFACE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], .cm-content';

const LISTENER_SLOT = Symbol.for('datacardforge.suppressNativeMenu.listener');

/** Only `capture` affects listener identity matching; the flag is the whole registration. */
const LISTENER_OPTIONS = { capture: true } as const;

type InstalledListener = (event: Event) => void;

/** The installed listener, parked on the window so a re-evaluated module can replace it. */
type ListenerHost = Record<symbol, unknown>;

/**
 * True when `target` is, or sits inside, an editing surface that keeps the native menu.
 *
 * A `contextmenu` can also be dispatched at the window or the document, where the target is
 * not an element at all; those are not editing surfaces, so the menu is suppressed there like
 * anywhere else.
 */
export function isEditingSurfaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITING_SURFACE_SELECTOR) !== null;
}

/**
 * The one window-level handler: cancel the native menu, touch nothing else.
 *
 * `stopPropagation` must not be added here — the four React `onContextMenu` handlers live
 * downstream of this listener and depend on the event continuing to bubble.
 */
export function suppressNativeContextMenu(event: Event): void {
  if (isEditingSurfaceTarget(event.target)) return;
  event.preventDefault();
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