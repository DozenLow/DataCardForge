/**
 * One settle period for the whole workspace: debounce belongs to the USER OPERATION, not to a
 * compute node (2026-11-17, superseding the per-card 250 ms / 500 ms / 600 ms timers).
 *
 * A definition edit that other cards can observe — a formula expression, the script source —
 * is applied to the store after ONE 200 ms quiet period shared by every card. When it fires,
 * the whole chain leaves in one wave: the PATCH that marks downstream nodes dirty, the
 * authoritative script check, and (for an armed script card) the compute request. Nothing
 * downstream arms a timer of its own: the backend evaluates the subtree synchronously, so an
 * intermediate card never adds a wait of its own.
 *
 * Why not per-card: 250/500/600 ms of each card excusing itself separately is wall-clock time
 * the user reads as lag, and it makes two cards edited in one pause take two waves instead of
 * one. A discrete action (file drop, Run, create a card) calls `flushOperations()` first, so
 * "I finished, now act" never waits out a typing pause.
 *
 * The timer is module-level on purpose: it must survive a card unmounting mid-edit. A task
 * whose card is gone is a store no-op, and a pending edit for a closed card never comes back.
 */
const SETTLE_MS = 200;

type Task = () => void;

/** Latest task per operation key. A keystroke replaces its card's entry, never queues. */
const pending = new Map<string, Task>();
// `globalThis` rather than `window`: the scheduler is plain, and its unit test runs in Node
// (a DOM environment would be paid for on every case for no measurement).
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function arm(): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    flushOperations();
  }, SETTLE_MS);
}

/**
 * Queue (or replace) the task for one operation key and restart the quiet period.
 *
 * The period is GLOBAL: editing card B 150 ms after card A does not flush A early, it extends
 * the same pause, so a user moving between inputs produces one wave, not one per card.
 */
export function settleOperation(key: string, task: Task): void {
  pending.set(key, task);
  arm();
}

/** Drop the pending task for one key (an external rewrite is the newer intent). */
export function cancelOperation(key: string): void {
  if (!pending.delete(key)) return;
  if (pending.size === 0) clearTimer();
}

/**
 * Run every pending task now and stop the timer.
 *
 * Called by discrete actions before they read the graph (run a script, replace a file, create
 * a card) so what they act on is what the user sees. A task that schedules again during the
 * flush gets a fresh 200 ms period instead of joining this one.
 */
export function flushOperations(): void {
  clearTimer();
  if (pending.size === 0) return;
  const tasks = [...pending.values()];
  // Clear first: a task may schedule a new operation, and that one must not be swallowed by
  // this flush (it has not been "settled" yet).
  pending.clear();
  for (const task of tasks) task();
}

/** Test hook: forget the timer and every pending task. */
export function resetOperationSettle(): void {
  clearTimer();
  pending.clear();
}

export { SETTLE_MS };
