/**
 * Editing surfaces — the adapter that lets the self-rendered context menu act on text without
 * the menu knowing any editor. Task G2 of
 * `docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md` §八.
 *
 * WHY THIS EXISTS: G1 cancelled the browser's own context menu application-wide but left
 * editing surfaces exempt (an `input`, a `textarea`, the CodeMirror script editor), because the
 * native menu was the only clipboard path those surfaces had. G2 closes that hole in the only
 * order that does not break copy/paste in between: first give every editing surface an adapter
 * the application's own menu can drive, then delete the exemption so the native menu is gone
 * everywhere.
 *
 * THE MENU DOES NOT KNOW CODEMIRROR. It sees four verbs — copy / cut / paste / select all —
 * plus two questions it has to ask before it draws a row (can this surface copy? can it paste?).
 * Everything editor-specific lives behind those six members:
 *
 *     EditingSurface = { copy(), cut(), paste(text), selectAll(), canCopy, canPaste }
 *
 * Two adapters cover the application:
 *   - the DEFAULT adapter, for plain `<input>` / `<textarea>`. These need NO registration: the
 *     resolver recognises them by tag, so `VirtualTable`'s editable cell, `FormulaCard`'s
 *     expression field and `NameField` all work without being touched (they own no code here).
 *   - the CODEMIRROR adapter factory, because a CodeMirror view keeps its document and its
 *     selection in its own state and looking at the DOM would be a lie. `ScriptCard` registers
 *     it once, for the lifetime of its editor.
 *
 * REGISTRY, NOT SELECTORS: `WeakMap<HTMLElement, EditingSurface>`. Resolution walks up from the
 * event target, so a right-click on a `.cm-line` lands on the `.cm-content` element that was
 * registered. The old G1 heuristic (`closest('input, textarea, select, [contenteditable="true"],
 * .cm-content')`) is deliberately gone rather than extended: an attribute cannot tell you
 * whether a surface can paste, and the decision calls out that `[contenteditable]` alone
 * misjudges `plaintext-only` and the empty value. Asking the surface itself cannot misjudge.
 *
 * A contenteditable element that is not CodeMirror therefore resolves to `null`: on this app
 * every rich editable IS CodeMirror, and inventing an adapter for a surface nobody has would be
 * an editing menu that silently cannot paste. Keyboard Ctrl+C/V still works there — the
 * suppression only removes the mouse menu.
 *
 * THE REQUEST EVENT lives here too (the module is framework-free, so both the window listener
 * and the React host can import the contract without importing each other). `suppressNativeMenu`
 * cancels the native menu and then asks for ours; `EditingMenuHost` answers.
 */

import type { EditorView } from '@codemirror/view';

/**
 * The six members the menu uses. `canCopy` / `canPaste` are read at draw time, so adapters
 * expose them as getters — a snapshot taken when the surface was resolved would go stale the
 * moment the user selects something or the editor turns read-only.
 */
export interface EditingSurface {
  copy(): void;
  cut(): void;
  paste(text: string): void;
  selectAll(): void;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
}

// ── clipboard ───────────────────────────────────────────────────────────────────────────

/**
 * Write plain text to the clipboard, best effort.
 *
 * `navigator.clipboard.writeText` first (the async API; a click on a menu item is the user
 * gesture it needs, and localhost is a secure context). Where that API does not exist — an old
 * browser, a test environment — fall back to the deprecated `execCommand('copy')`, which copies
 * whatever the focused field has selected. Copy has no failure UI on purpose: unlike paste, a
 * failed copy loses nothing (the text is still in the surface, and Ctrl+C is the same gesture),
 * and the menu is about to close, so there is nothing to keep on screen.
 */
export function writeClipboardText(text: string): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    void clipboard.writeText(text).catch(() => {
      // Denied or unavailable: nothing was lost, and the user's own Ctrl+C remains.
    });
    return;
  }
  try {
    document.execCommand?.('copy');
  } catch {
    // `execCommand` is deprecated and may throw in exotic contexts; there is no third path.
  }
}

/** True when this browser exposes the async clipboard read the Paste row depends on. */
export function canReadClipboard(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.clipboard?.readText === 'function';
}

// ── default adapter: plain <input> / <textarea> ─────────────────────────────────────────

/**
 * Input types that carry no text. A right-click on one of these is not an editing surface:
 * there is nothing to copy, cut or paste, so no editing menu is offered (and the native menu is
 * suppressed like anywhere else).
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Is `element` a plain text field? Tag-name based on purpose: the resolver runs in jsdom suites
 * too, and `instanceof HTMLInputElement` would tie this module to a DOM global being present at
 * import time.
 */
function isTextField(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type;
  return !NON_TEXT_INPUT_TYPES.has(type.toLowerCase());
}

/**
 * The `input` event that makes a React controlled field notice the edit.
 *
 * This is the whole reason the adapter does not simply assign `element.value`: React keeps a
 * value tracker on the instance and suppresses a change event whose value it did not see move.
 * `setRangeText` changes the DOM value *through the native setter path*, so the tracker's cached
 * value is stale and React does dispatch `onChange` — which is what keeps the store's copy of
 * the cell/expression/rename text in sync with what the user sees.
 */
function inputEvent(data: string): Event {
  if (typeof InputEvent === 'function') {
    return new InputEvent('input', { bubbles: true, inputType: 'insertText', data });
  }
  // `InputEvent` is missing in some test environments; a bubbling plain event is enough for
  // React's delegated listener.
  return new Event('input', { bubbles: true });
}

/**
 * Wrap a plain text field.
 *
 * Selection is read from `selectionStart` / `selectionEnd` rather than from the window
 * selection: those properties survive the field losing focus to the menu, which is exactly the
 * window in which the adapter runs.
 */
export function fieldSurface(
  element: HTMLInputElement | HTMLTextAreaElement,
): EditingSurface {
  const bounds = (): { from: number; to: number } => {
    const from = element.selectionStart ?? 0;
    const to = element.selectionEnd ?? from;
    return { from, to };
  };
  const selected = (): string => {
    const { from, to } = bounds();
    return element.value.slice(from, to);
  };
  /**
   * Replace the current selection and tell React about it.
   *
   * `focus()` first: clicking a menu row moved focus to the row, and while `selectionStart`
   * survives that, a field that never regains focus shows no caret after the edit.
   */
  const replaceSelection = (text: string): void => {
    const { from, to } = bounds();
    element.focus();
    element.setRangeText(text, from, to, 'end');
    element.dispatchEvent(inputEvent(text));
  };

  return {
    copy() {
      writeClipboardText(selected());
    },
    cut() {
      if (element.readOnly || element.disabled) return;
      const text = selected();
      if (text.length === 0) return;
      writeClipboardText(text);
      replaceSelection('');
    },
    paste(text) {
      if (element.readOnly || element.disabled) return;
      replaceSelection(text);
    },
    selectAll() {
      element.focus();
      element.setSelectionRange(0, element.value.length);
    },
    get canCopy() {
      return selected().length > 0;
    },
    get canPaste() {
      return !element.readOnly && !element.disabled;
    },
  };
}

// ── CodeMirror adapter ──────────────────────────────────────────────────────────────────

/**
 * Wrap a CodeMirror view.
 *
 * The view owns the document and the selection, so every verb goes through its state: the
 * selection range is sliced out of the document for copy/cut, and the edits are dispatched as
 * transactions — which is what keeps undo history, change listeners (`ScriptCard`'s settle
 * operation) and the store in step. Touching the DOM instead would desynchronise all three.
 */
export function codeMirrorSurface(view: EditorView): EditingSurface {
  return {
    copy() {
      const { from, to } = view.state.selection.main;
      writeClipboardText(view.state.sliceDoc(from, to));
    },
    cut() {
      const { from, to } = view.state.selection.main;
      if (from === to || view.state.readOnly) return;
      writeClipboardText(view.state.sliceDoc(from, to));
      view.dispatch(view.state.replaceSelection(''));
      view.focus();
    },
    paste(text) {
      if (view.state.readOnly) return;
      view.focus();
      view.dispatch(view.state.replaceSelection(text));
    },
    selectAll() {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    },
    get canCopy() {
      return !view.state.selection.main.empty;
    },
    get canPaste() {
      return !view.state.readOnly;
    },
  };
}

// ── registry + resolution ──────────────────────────────────────────────────────────────

/** Registered surfaces. Weak so a torn-down editor leaves nothing behind. */
const REGISTRY = new WeakMap<HTMLElement, EditingSurface>();

/**
 * Register `surface` for `element` and return the un-registration function.
 *
 * Only surfaces whose adapter cannot be derived from the DOM need this — in this app that is
 * exactly the CodeMirror editor. The returned function is identity-checked before deleting so a
 * newer registration on the same element is never torn out by an older card's cleanup.
 */
export function registerEditingSurface(
  element: HTMLElement,
  surface: EditingSurface,
): () => void {
  REGISTRY.set(element, surface);
  return () => {
    if (REGISTRY.get(element) === surface) REGISTRY.delete(element);
  };
}

/**
 * The editing surface a right-click at `target` acts on, or `null`.
 *
 * Walk up from the target: a registered element wins (CodeMirror reports its own state), then
 * the nearest plain text field gets the default adapter. Anything else is not an editing
 * surface — the caller suppresses the native menu and offers nothing of its own.
 */
export function resolveEditingSurface(target: EventTarget | null): EditingSurface | null {
  let node: Node | null = target instanceof Node ? target : null;
  while (node !== null) {
    // `HTMLElement` check via `nodeType` instead of `instanceof`: this function also runs in
    // node-environment tests, where the DOM globals may not exist at all.
    if (node.nodeType === 1) {
      const element = node as HTMLElement;
      const registered = REGISTRY.get(element);
      if (registered) return registered;
      if (isTextField(element)) return fieldSurface(element);
    }
    node = node.parentNode;
  }
  return null;
}

// ── the request the menu host answers ──────────────────────────────────────────────────

/**
 * The editing-menu request, dispatched by the window suppression once it has cancelled the
 * native menu. Its own event rather than a shared store: the suppression is installed before
 * the first render and knows nothing about React or the workspace.
 */
export const EDITING_MENU_REQUEST_EVENT = 'datacardforge-editing-menu';

/** Where the menu should open and which surface it acts on. */
export interface EditingMenuRequestDetail {
  /** Viewport coordinates of the pointer (or of the surface for a keyboard-invoked request). */
  x: number;
  y: number;
  /** The event target; the host resolves the surface from it (one resolution path). */
  target: EventTarget | null;
}

/** Ask the mounted menu host to open the editing menu. A no-op when no host is mounted. */
export function requestEditingMenu(detail: EditingMenuRequestDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<EditingMenuRequestDetail>(EDITING_MENU_REQUEST_EVENT, {
    detail,
  }));
}