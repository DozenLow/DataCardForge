/**
 * Card shell — the Qt `QMdiSubWindow` replacement.
 *
 * Provides the title bar, close button and the draggable/resizable frame. Cards are
 * absolutely positioned inside the canvas so that the connection layer can measure
 * them directly; react-rnd handles the pointer interactions and reports the new
 * geometry back to the store.
 *
 * Since 2026-11-20 the title bar is also the **wiring handle** (task G3,
 * `docs/decisions/2026-11-20-card-multi-input-and-wire-gesture.md` §六/§七): a right press
 * arms the right-drag gesture that wires this card into another card's input. The title bar is
 * the one clean surface for it — react-rnd's handle ignores the right button (`allowAnyClick`
 * defaults to false, so a right press never moves the card) and the title bar carries no
 * right-click menu of its own. This shell is shared by all nine card types, so the trigger is
 * a single `onPointerDown` that does nothing at all unless `button === 2`; the left-button
 * drag/resize/double-click paths are untouched.
 */
import { useEffect, useRef } from 'react';
import { Rnd } from 'react-rnd';
import type { ReactNode } from 'react';

import { MIN_CARD_HEIGHT, MIN_CARD_WIDTH, useWorkspace } from '../workspaceStore.ts';
import { registerCard, unregisterCard, invalidateLayout } from '../cardMetrics.ts';
import { startWireGesture, useWireHighlight } from '../wireGesture.ts';
import type { CardModel } from '../types.ts';

/**
 * Wire-drop rings, painted inline because this lane owns no stylesheet.
 *
 * Deliberately unlike `.card--drop-target` (a dashed accent outline for a *file* drop): a wire
 * drop is a solid ring pulled inside the frame — blue where the release would commit, red where
 * it would be refused — so "a file will replace this card's data" and "a wire will feed this
 * card" can never be read as the same state.
 */
const WIRE_ACCEPT_RING = { outline: '2px solid rgb(40, 120, 220)', outlineOffset: '-4px' } as const;
const WIRE_REFUSE_RING = { outline: '2px solid rgb(200, 50, 50)', outlineOffset: '-4px' } as const;

interface CardShellProps {
  card: CardModel;
  title: string;
  /** Optional short badge shown after the title, e.g. dimensions or smoothing mode. */
  badge?: string;
  active: boolean;
  /** Extra classes appended to the card root (e.g. `card--chart`). */
  variant: string;
  /**
   * A file is being dragged over this card, which would *replace* its data (only data
   * cards accept drops). The canvas owns the hit test; the shell only paints the state.
   */
  dropTarget?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseBlocked: () => void;
  onBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  /** True when closing must be refused because other cards depend on this one. */
  closeBlocked: boolean;
  closeLabel: string;
  /**
   * Per-card resize floor, defaulting to the workspace-wide minimum.
   *
   * A card that lays its body out in columns needs more room than a plain one before the
   * columns stop being readable, and the floor belongs to the card that knows its own
   * content — not to the shared constant every other card is sized against.
   */
  minWidth?: number;
  minHeight?: number;
  children: ReactNode;
}

export function CardShell({
  card,
  title,
  badge,
  active,
  variant,
  dropTarget = false,
  onActivate,
  onClose,
  onCloseBlocked,
  onBounds,
  closeBlocked,
  closeLabel,
  minWidth,
  minHeight,
  children,
}: CardShellProps) {
  const rndRef = useRef<Rnd | null>(null);
  // react-rnd computes drag/resize deltas from *screen* pointer movement, so at any zoom
  // other than 100% it has to be told the scale or cards would drift away from the cursor.
  const zoom = useWorkspace((s) => s.view.zoom);
  /** Node-level blockers outline the card that cannot advance (workspace-level ones do not). */
  const blocked = useWorkspace((s) => s.blockers.some((blocker) => blocker.cardId === card.id));
  /**
   * Is a wire being dragged over this card, and would the drop be accepted? (G3)
   *
   * A primitive snapshot, so the other eight cards do not re-render on every pointer move. The
   * ring below is painted inline: this lane owns no stylesheet, and the two file-drop states
   * (`.card--drop-target`) must stay visually distinct from a wire drop anyway.
   */
  const wireHighlight = useWireHighlight(card.id);
  const wireRing =
    wireHighlight === 'accept' ? WIRE_ACCEPT_RING : wireHighlight === 'refuse' ? WIRE_REFUSE_RING : null;

  // Publish this card's DOM element so the connection layer can measure anchors on it.
  useEffect(() => {
    const element = rndRef.current?.getSelfElement();
    if (element) registerCard(card.id, element);
    return () => unregisterCard(card.id);
  }, [card.id]);

  const handleClose = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (closeBlocked) onCloseBlocked();
    else onClose();
  };

  return (
    <Rnd
      className={`card ${variant}${active ? ' card--active' : ''}${
        dropTarget ? ' card--drop-target' : ''
      }${blocked ? ' card--blocked' : ''}${wireHighlight ? ` card--wire-${wireHighlight}` : ''}`}
      data-card-id={card.id}
      // `outline` instead of `box-shadow`: the card's own shadow is a stylesheet rule, and an
      // inline box-shadow would erase it for the duration of the gesture.
      style={wireRing ? { zIndex: card.z, ...wireRing } : { zIndex: card.z }}
      size={{ width: card.width, height: card.height }}
      position={{ x: card.x, y: card.y }}
      minWidth={minWidth ?? MIN_CARD_WIDTH}
      minHeight={minHeight ?? MIN_CARD_HEIGHT}
      scale={zoom}
      bounds="parent"
      dragHandleClassName="card__titlebar"
      cancel=".card__close, .card__control, button, input, select"
      onMouseDown={onActivate}
      onDragStart={onActivate}
      onDrag={() => invalidateLayout()}
      onDragStop={(_event, data) =>
        onBounds({ x: data.x, y: data.y, width: card.width, height: card.height })
      }
      onResizeStart={onActivate}
      onResize={() => invalidateLayout()}
      onResizeStop={(_event, _dir, ref, _delta, position) =>
        onBounds({
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
      }
      ref={rndRef}
    >
      <div
        className="card__titlebar"
        onDoubleClick={onActivate}
        onPointerDown={(event) => {
          // ── the right-drag wiring trigger (G3) ────────────────────────────────────────
          //
          // Right button only. Every other button returns immediately, so react-rnd's
          // left-button move/resize and the double-click/title behaviour are bit-for-bit what
          // they were before this lane.
          if (event.button !== 2) return;
          // A press on the close control is not a wire: the shell already excludes it from the
          // DRAG handle (`cancel`), and arming here would let "right-click just off the ×, drift
          // 4px, let go" add a port by accident.
          if (event.target instanceof Element && event.target.closest('.card__close') !== null) {
            return;
          }
          // NO `preventDefault()` here: react-rnd's `onMouseDown` (→ `onActivate`, which raises
          // and selects the card) must still run, and the native context menu is already
          // cancelled application-wide by G1. The press itself decides nothing — the arbiter
          // separates "right click" from "wire drag" at pointer-up, by displacement.
          startWireGesture({
            sourceCardId: card.id,
            pointerId: event.pointerId,
            client: { x: event.clientX, y: event.clientY },
            // Capture keeps the rest of the sequence on the surface that started it (`move` /
            // `up`/ `cancel` still pass through the window listeners the controller installs;
            // jsdom has no pointer capture at all, hence the optional call).
            capture: event.currentTarget,
          });
        }}
      >
        <span className="card__title" title={title}>
          {title}
        </span>
        {badge ? <span className="card__badge">{badge}</span> : null}
        <button
          type="button"
          className={`card__close${closeBlocked ? ' card__close--blocked' : ''}`}
          title={closeLabel}
          aria-label={closeLabel}
          onClick={handleClose}
        >
          ×
        </button>
      </div>
      <div className="card__body">{children}</div>
    </Rnd>
  );
}
