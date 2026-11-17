/**
 * Collapsible declaration column — the chart card's column dock, generalised.
 *
 * Expanded it is the card's declaration column and the card owns the content. Collapsed it is
 * a thin rail that keeps the column's identity visible and, crucially, keeps whatever the card
 * hands in as `rail` MOUNTED. For a card that renders ports, those rail items ARE the port
 * elements: a wire must not fall back to the card's centre edge just because the panel was
 * folded (docs/decisions/2026-11-17-port-anchored-connections.md).
 *
 * The rail's text is rotated for EVERY script, not just Latin: `text-orientation: sideways`
 * turns the whole line 90° (Chinese included), which `vertical-rl` + `mixed` does not. The
 * `@supports` fallback in the stylesheet keeps older engines readable (CJK upright) instead of
 * broken.
 */
import type { ReactNode } from 'react';

export interface SidePanelProps {
  side: 'left' | 'right';
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Column title, shown upright when open and rotated in the rail. */
  title: string;
  /** Stable id for `aria-controls`. */
  panelId: string;
  /** Card-specific classes carried by the container in BOTH states (width, borders, …). */
  className?: string;
  /** Scrolling the column moves its ports, so the card re-measures on scroll. */
  onScroll?: () => void;
  children: ReactNode;
  /** Collapsed content — for a card with ports, one registered chip per port. */
  rail: ReactNode;
  /** Extra controls in the head, after the title and before the collapse button. */
  headExtra?: ReactNode;
}

export function SidePanel({
  side,
  open,
  onToggle,
  title,
  panelId,
  className = '',
  onScroll,
  children,
  rail,
  headExtra,
}: SidePanelProps) {
  const bodyId = `${panelId}-body`;
  const classes = [
    'side-panel',
    `side-panel--${side}`,
    open ? 'side-panel--open' : 'side-panel--rail',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (!open) {
    return (
      <section
        className={classes}
        id={panelId}
        aria-label={title}
        data-side={side}
        data-open="false"
      >
        <button
          type="button"
          className="side-panel__rail-title"
          aria-expanded={false}
          aria-controls={bodyId}
          title={title}
          onClick={() => onToggle(true)}
        >
          {title}
        </button>
        <div className="side-panel__rail-body" id={bodyId} onScroll={onScroll}>
          {rail}
        </div>
      </section>
    );
  }

  return (
    <section
      className={classes}
      id={panelId}
      aria-label={title}
      data-side={side}
      data-open="true"
    >
      <div className="side-panel__head">
        <span className="side-panel__title">{title}</span>
        {headExtra}
        <button
          type="button"
          className="side-panel__collapse card__control"
          aria-expanded
          aria-controls={bodyId}
          title={title}
          onClick={() => onToggle(false)}
        >
          {side === 'left' ? '‹' : '›'}
        </button>
      </div>
      <div className="side-panel__body" id={bodyId} onScroll={onScroll}>
        {children}
      </div>
    </section>
  );
}
