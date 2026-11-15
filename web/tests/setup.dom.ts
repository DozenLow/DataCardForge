/**
 * Shared polyfills for jsdom suites.
 *
 * jsdom implements neither ResizeObserver nor requestAnimationFrame-adjacent layout, and
 * the components under test legitimately use both (VirtualTable observes its viewport to
 * size the virtual window; ConnectionLayer coalesces invalidations into one frame). A
 * no-op observer is enough — these tests assert on the state they stub themselves
 * (rects, store values), never on real layout.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

/**
 * jsdom has no layout, so `Range` carries no `getClientRects`.
 *
 * CodeMirror measures a text range to place its selection and cursor layers and throws when
 * the method is missing — an error it reports once per frame, which turns a DOM suite's log
 * into noise and hides real failures. An empty rect list is the honest answer: there is no
 * geometry to report.
 */
if (typeof Range !== 'undefined' && !('getClientRects' in Range.prototype)) {
  const emptyList = () => [] as unknown as DOMRectList;
  const emptyRect = () => new DOMRect();
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = emptyList;
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    emptyRect;
}

export {};
