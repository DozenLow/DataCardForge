/**
 * useAccuracyHint — asks the backend, once the result has settled, how much rounding jitter
 * the node's own arithmetic shows.
 *
 * Two rules shape this hook:
 *
 * 1. **Nothing is asked until the definition has been quiet for 3 s.** The formula card
 *    recomputes on every keystroke; measuring on each of them would spend work on results
 *    the user has already replaced.
 * 2. **A reply that arrives after the definition changed is discarded, not displayed.** A
 *    hint about a result nobody is looking at is worse than no hint.
 *
 * The measurement itself is `POST /api/nodes/{id}/accuracy`: same values, different row
 * order. The exact answer cannot change, the rounding can, so the gap is a sample of the
 * rounding noise. It is a SAMPLE, not a bound — which is why the "ok" copy says "no jitter
 * detected" and never "accurate".
 */
import { useEffect, useRef, useState } from 'react';

import { BackendClient } from '../backend/client.ts';

/** The store keeps its own instance; the client is stateless HTTP, so a second one is fine. */
const backendClient = new BackendClient();

export const ACCURACY_DEBOUNCE_MS = 3000;

export type AccuracyHint =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'degraded'; digits: number; gap: number };

/**
 * Pure mapping from the endpoint's reply to what the card may render. Kept separate from
 * the hook so the three-state rule is testable without React.
 *
 * `unsupported` collapses to `idle` on purpose: the backend declined because it could not
 * measure (chained input, MOV/EMA, never computed). Rendering anything for that would read
 * as "checked and fine" when nothing was checked.
 */
export function toAccuracyHint(
  reply: {
    status?: string;
    digits?: number;
    relativeGap?: number;
    reason?: string;
  } | null,
): AccuracyHint {
  if (!reply || reply.status === undefined) return { kind: 'idle' };
  if (reply.status === 'ok') return { kind: 'ok' };
  if (reply.status === 'degraded' && typeof reply.digits === 'number') {
    return {
      kind: 'degraded',
      digits: reply.digits,
      gap: typeof reply.relativeGap === 'number' ? reply.relativeGap : 0,
    };
  }
  return { kind: 'idle' };
}

export function useAccuracyHint(nodeId: number | null, signature: string): AccuracyHint {
  const [hint, setHint] = useState<AccuracyHint>({ kind: 'idle' });
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    const mine = seq.current;
    // A new definition means the old number is about a result that no longer exists.
    setHint({ kind: 'idle' });
    if (nodeId === null || nodeId <= 0) return undefined;

    const timer = setTimeout(() => {
      void backendClient.checkAccuracy(nodeId).then((reply) => {
        if (seq.current !== mine) return; // superseded while in flight: drop it
        setHint(toAccuracyHint(reply));
      });
    }, ACCURACY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [nodeId, signature]);

  return hint;
}
