/**
 * The self-rendered text-editing menu — task G2, decision §八 step S2
 * (`docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md`).
 *
 * WHY IT EXISTS: G1 cancelled the browser's context menu for the whole workbench but left
 * editing surfaces exempt, because that menu was the only clipboard path an `input`, a
 * `textarea` or the CodeMirror script editor had. This component is the replacement that lets
 * the exemption go: right-clicking inside a text surface now opens *our* Copy / Cut / Paste /
 * Select all, and the native menu stays cancelled everywhere (G2 deletes the exemption).
 *
 * WHAT IT IS NOT: undo/redo are absent on purpose (every editor and every field has Ctrl+Z),
 * and so are spell-check / translate / inspect — the decision rules those out. Only the four
 * verbs that need a target surface are here.
 *
 * HOW IT ACTS: through an `EditingSurface` (see `editingSurface.ts`), never by knowing what the
 * surface is. The menu decides what is greyed out from the surface's `canCopy` / `canPaste`
 * getters, so a read-only field or an empty selection greys the row before the click instead of
 * failing after it. Plain `<input>`/`<textarea>` fields get an adapter for free; CodeMirror
 * registers one.
 *
 * PASTE IS THE ONLY ASYNC VERB, and the only one that can be refused: `navigator.clipboard`
 * needs a user gesture (the click on the row) and a permission. A denied read GREYS THE ROW AND
 * SHOWS A "use Ctrl+V" HINT — the menu stays open, because a Paste row that silently does
 * nothing is worse than one that says why. The Permissions API is asked once on open, so an
 * already-denied browser shows the greyed row before the user clicks.
 *
 * The strings are local to this file rather than in `i18n.ts` for the same lane reason as
 * `ScriptCard`'s label table: this task owns only its own files, and moving a dozen keys into
 * the shared dictionary later is mechanical.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { Locale } from '../i18n.ts';
import {
  canReadClipboard,
  resolveEditingSurface,
  type EditingMenuRequestDetail,
  type EditingSurface,
  EDITING_MENU_REQUEST_EVENT,
} from '../editingSurface.ts';
import { Popup } from './Popup.tsx';

// ── prose ─────────────────────────────────────────────────────────────────────────────

interface EditingMenuLabels {
  title: string;
  copy: string;
  cut: string;
  paste: string;
  selectAll: string;
  /** `{key}` is the platform's modifier key name ("Ctrl" / "⌘"). */
  pasteDenied: string;
  pasteUnavailable: string;
  pasteReadOnly: string;
}

const LABELS: Record<Locale, EditingMenuLabels> = {
  zh: {
    title: '编辑',
    copy: '复制',
    cut: '剪切',
    paste: '粘贴',
    selectAll: '全选',
    pasteDenied: '浏览器拒绝了剪贴板读取 — 请用 {key}+V 粘贴',
    pasteUnavailable: '此浏览器不提供剪贴板读取 — 请用 {key}+V 粘贴',
    pasteReadOnly: '此处不可编辑',
  },
  en: {
    title: 'Edit',
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select all',
    pasteDenied: 'Clipboard read was refused — paste with {key}+V',
    pasteUnavailable: 'This browser has no clipboard read — paste with {key}+V',
    pasteReadOnly: 'Not editable here',
  },
};

/**
 * The modifier key the hints name: ⌘ on an Apple platform, Ctrl elsewhere.
 *
 * The hints are advisory text, not a keymap — the menu never handles the keys itself — so a
 * wrong guess costs nothing but a misleading label, and the browser's own Ctrl+V/⌘+V keeps
 * working regardless.
 */
function modifierKey(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /mac|iphone|ipad/i.test(agent) ? '⌘' : 'Ctrl';
}

/** Why the Paste row is (or is not) usable. */
type PasteState = 'ready' | 'denied' | 'unavailable';

// ── one row ───────────────────────────────────────────────────────────────────────────

interface RowProps {
  label: string;
  /** The shortcut this row stands for; shown right-aligned, never handled here. */
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
}

/**
 * A menu row: label on the left, shortcut on the right.
 *
 * It reuses the shared menu skin (`.context-menu__item`, plus `--sub` for the two-column row)
 * rather than `ContextMenuItem`, whose single-label markup cannot carry the shortcut. The
 * classes are the contract with `styles.css`; this task does not own the stylesheet.
 */
function Row({ label, shortcut, disabled, onClick }: RowProps): ReactElement {
  return (
    <button
      type="button"
      className="context-menu__item context-menu__item--sub"
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="context-menu__chevron">{shortcut}</span>
    </button>
  );
}

// ── the menu ──────────────────────────────────────────────────────────────────────────

export interface EditingMenuProps {
  /** Viewport coordinates of the pointer that opened the menu (clamped by `Popup`). */
  x: number;
  y: number;
  /** The surface the four verbs act on. */
  surface: EditingSurface;
  /** Active UI language. */
  locale: Locale;
  onDismiss: () => void;
}

export function EditingMenu({ x, y, surface, locale, onDismiss }: EditingMenuProps): ReactElement {
  const labels = LABELS[locale];
  const modifier = modifierKey();
  // `unavailable` is decided synchronously: a browser without the async clipboard API can only
  // ever offer Ctrl+V, so the row is greyed from the first frame.
  const [pasteState, setPasteState] = useState<PasteState>(() =>
    canReadClipboard() ? 'ready' : 'unavailable',
  );
  /** A clipboard read is in flight: the row must not fire twice. */
  const [reading, setReading] = useState(false);

  // Ask the Permissions API once, so an already-denied clipboard greys the row up front
  // instead of failing on click. `clipboard-read` is not a permission every browser knows
  // (Firefox rejects the query); a rejection means "no answer", never "denied", so the click
  // remains the only authority there.
  useEffect(() => {
    const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!permissions || typeof permissions.query !== 'function') return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await permissions.query({ name: 'clipboard-read' as PermissionName });
        if (!cancelled && status.state === 'denied') {
          setPasteState((current) => (current === 'ready' ? 'denied' : current));
        }
      } catch {
        // Unknown permission name: the click decides.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const editable = surface.canPaste;
  const pasteDisabled = !editable || pasteState !== 'ready' || reading;

  /** The one-line explanation under a greyed-out Paste row; `null` when the row is usable. */
  const pasteHint = ((): string | null => {
    if (!editable) return labels.pasteReadOnly;
    if (pasteState === 'denied') return labels.pasteDenied.split('{key}').join(modifier);
    if (pasteState === 'unavailable') return labels.pasteUnavailable.split('{key}').join(modifier);
    return null;
  })();

  /**
   * Copy / cut / select-all are synchronous: act and close.
   *
   * `cut` is the one verb that needs both halves of the surface (a selection to take AND an
   * editable document to take it out of), so it is greyed out when either is missing.
   */
  const actAndDismiss = (action: () => void) => () => {
    action();
    onDismiss();
  };

  /**
   * Paste: read the clipboard, hand the text to the surface, close.
   *
   * A refusal keeps the menu open and turns the row grey with the Ctrl+V hint. This is the
   * "never a silent failure" ruling: the click visibly did something, it just could not read
   * the clipboard, and the fallback keystroke is named on screen.
   */
  const onPaste = () => {
    if (pasteDisabled) return;
    setReading(true);
    // Both a rejected promise (permission denied) and a synchronous throw (a browser that has
    // no `readText` after all) land in the same branch: the row turns grey and names Ctrl+V.
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        surface.paste(text);
        onDismiss();
      } catch {
        setReading(false);
        setPasteState('denied');
      }
    })();
  };

  return (
    <Popup x={x} y={y} className="context-menu context-menu--list" onDismiss={onDismiss}>
      <div className="context-menu__title">{labels.title}</div>
      <Row
        label={labels.copy}
        shortcut={`${modifier}+C`}
        disabled={!surface.canCopy}
        onClick={actAndDismiss(() => surface.copy())}
      />
      <Row
        label={labels.cut}
        shortcut={`${modifier}+X`}
        disabled={!surface.canCopy || !editable}
        onClick={actAndDismiss(() => surface.cut())}
      />
      <Row
        label={labels.paste}
        shortcut={`${modifier}+V`}
        disabled={pasteDisabled}
        onClick={onPaste}
      />
      {pasteHint === null ? null : <div className="context-menu__hint">{pasteHint}</div>}
      <div className="context-menu__separator" />
      <Row
        label={labels.selectAll}
        shortcut={`${modifier}+A`}
        disabled={false}
        onClick={actAndDismiss(() => surface.selectAll())}
      />
    </Popup>
  );
}

// ── the host ──────────────────────────────────────────────────────────────────────────

export interface EditingMenuHostProps {
  /**
   * Active UI language, passed in instead of read from the store: `App` already subscribes to
   * the locale, and keeping the host store-free means it can be mounted (and tested) without a
   * workspace.
   */
  locale: Locale;
}

interface OpenRequest {
  x: number;
  y: number;
  surface: EditingSurface;
}

/**
 * Mounted once, in `App.tsx`. Listens for the request the window suppression dispatches when a
 * right-click lands on an editing surface and renders the menu at that pointer.
 *
 * The surface is resolved HERE, from the request's target, so there is exactly one resolution
 * path (`resolveEditingSurface`) and the suppression module never has to know what an adapter
 * is beyond "does one exist". A request whose target no longer resolves (the field was removed
 * by the very click that opened the menu) simply opens nothing.
 */
export function EditingMenuHost({ locale }: EditingMenuHostProps): ReactElement | null {
  const [request, setRequest] = useState<OpenRequest | null>(null);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<EditingMenuRequestDetail>).detail;
      if (!detail) return;
      const surface = resolveEditingSurface(detail.target);
      if (!surface) return;
      setRequest({ x: detail.x, y: detail.y, surface });
    };
    window.addEventListener(EDITING_MENU_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(EDITING_MENU_REQUEST_EVENT, onRequest);
  }, []);

  const dismiss = useCallback(() => setRequest(null), []);
  if (!request) return null;
  return (
    <EditingMenu
      x={request.x}
      y={request.y}
      surface={request.surface}
      locale={locale}
      onDismiss={dismiss}
    />
  );
}