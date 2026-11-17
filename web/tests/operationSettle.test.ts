/**
 * The workspace-wide operation settle (see `operationSettle.ts`).
 *
 * These cases pin the three properties the cards rely on:
 *   - 200 ms of quiet after the LAST operation (a global period, not per card),
 *   - the same key replaces its task (a keystroke never queues a second commit),
 *   - a discrete action flushes immediately, and a task scheduled during a flush gets its
 *     own new period instead of joining the wave it interrupted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SETTLE_MS,
  cancelOperation,
  flushOperations,
  resetOperationSettle,
  settleOperation,
} from '../src/ui/operationSettle.ts';

beforeEach(() => {
  vi.useFakeTimers();
  resetOperationSettle();
});

afterEach(() => {
  resetOperationSettle();
  vi.useRealTimers();
});

describe('operation settle', () => {
  it('waits for the 200 ms quiet period before running the task', () => {
    const task = vi.fn();
    settleOperation('formula:1', task);

    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);

    // One-shot: no trailing second run.
    vi.advanceTimersByTime(SETTLE_MS * 5);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('replaces the task under the same key instead of queueing a second commit', () => {
    const first = vi.fn();
    const latest = vi.fn();
    settleOperation('script:7', first);
    vi.advanceTimersByTime(100);
    settleOperation('script:7', latest);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('uses one GLOBAL period: an edit elsewhere extends the same pause', () => {
    const formula = vi.fn();
    const script = vi.fn();
    settleOperation('formula:1', formula);
    vi.advanceTimersByTime(150);
    settleOperation('script:2', script);

    // 199 ms after the last operation: neither card has flushed yet.
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(formula).not.toHaveBeenCalled();
    expect(script).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(formula).toHaveBeenCalledTimes(1);
    expect(script).toHaveBeenCalledTimes(1);
  });

  it('flushes a discrete action immediately and cancels the timer', () => {
    const pendingTask = vi.fn();
    settleOperation('formula:1', pendingTask);

    flushOperations();
    expect(pendingTask).toHaveBeenCalledTimes(1);

    // The timer was cancelled: the settle period cannot run the task a second time.
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(pendingTask).toHaveBeenCalledTimes(1);
  });

  it('gives a task scheduled during a flush its own new period', () => {
    const second = vi.fn();
    settleOperation('formula:1', () => {
      // A commit may itself produce a new edit (e.g. the store answers with a rewrite).
      settleOperation('formula:1', second);
    });

    flushOperations();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SETTLE_MS);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancels one key without touching the others', () => {
    const cancelled = vi.fn();
    const kept = vi.fn();
    settleOperation('a', cancelled);
    settleOperation('b', kept);

    cancelOperation('a');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(cancelled).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('resets timer and pending work (test isolation)', () => {
    const task = vi.fn();
    settleOperation('a', task);
    resetOperationSettle();

    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(task).not.toHaveBeenCalled();
    // A later flush finds nothing left to run.
    flushOperations();
    expect(task).not.toHaveBeenCalled();
  });
});
