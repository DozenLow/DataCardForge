/**
 * The right-drag wiring gesture as a unit: the drop matrix (§六) and the pointer arbiter (§七).
 *
 * What this file is guarding, in the decision's own words:
 *   - the landing spot decides the action — a port row REPLACES that port, the card body ADDS
 *     one, a chart / builtin-signature / data card refuses, the source or anything downstream
 *     of it refuses (cycle), bare canvas cancels with zero side effects, and a port that
 *     already reads the matrix is a no-op;
 *   - a multi-output source is never guessed: `matrixId` stays null and the chooser decides;
 *   - click and drag are told apart **at pointer-up by 4px of displacement**, never by the
 *     platform's `contextmenu` timing and never by a long-press timer;
 *   - Escape / pointercancel / lost capture / blur throw the gesture away, and a throwaway can
 *     never come back and commit later.
 *
 * The geometry is plane-space and the store is a stub, which is the whole point of
 * `resolveDrop` being pure: the interesting cases are decided without a browser.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  IDLE_WIRE_STATE,
  WIRE_DRAG_THRESHOLD,
  WireArbiter,
  resolveDrop,
  type ClientPoint,
  type DropCard,
  type DropKind,
  type DropPlan,
  type DropReason,
  type DropScene,
  type DropPort,
  type WireChoice,
  type WireState,
} from '../src/ui/wireGesture.ts';
import type { Rect } from '../src/ui/cardMetrics.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────

const SOURCE = 1;
const TARGET = 2;
const CHART = 3;

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function card(overrides: Partial<DropCard> & { id: number; rect: Rect }): DropCard {
  return {
    name: `card ${overrides.id}`,
    surface: 'data',
    ports: [],
    ...overrides,
  };
}

function scriptTarget(ports: DropPort[], at = rect(600, 100, 400, 400)): DropCard {
  return card({ id: TARGET, name: 'script B', surface: 'inputs', rect: at, ports });
}

const C_CSV: WireChoice = { matrixId: 20, label: 'c.csv', outputId: null };
const D_CSV: WireChoice = { matrixId: 21, label: 'd.csv', outputId: null };

function scene(overrides: Partial<DropScene> = {}): DropScene {
  return {
    cards: [
      card({ id: SOURCE, name: 'data A', surface: 'data', rect: rect(100, 100, 400, 300) }),
      scriptTarget([
        { portId: 'in:0', name: 'A', targetMatrixId: 10 },
        { portId: 'in:1', name: 'B', targetMatrixId: 11 },
      ]),
    ],
    portRows: [
      // Two port rows on the target card: `in:0` upper, `in:1` lower.
      { cardId: TARGET, portId: 'in:0', rect: rect(604, 150, 380, 24) },
      { cardId: TARGET, portId: 'in:1', rect: rect(604, 180, 380, 24) },
    ],
    sourceCardId: SOURCE,
    sourceName: 'data A',
    sourceMatrices: [C_CSV],
    isDownstream: () => false,
    nextPortName: () => 'C',
    matrixName: (matrixId) =>
      new Map([
        [10, 'a.csv'],
        [11, 'b.csv'],
        [20, 'c.csv'],
        [21, 'd.csv'],
      ]).get(matrixId) ?? null,
    ...overrides,
  };
}

/** The `label.action` of a plan, so a test can name the intent it asserts. */
function actionOf(plan: DropPlan): string {
  return plan.label.action;
}

// ── the drop matrix (§六) ────────────────────────────────────────────────────────────

describe('resolveDrop — the landing spot decides the action', () => {
  it('replaces the port whose row the wire was dropped on', () => {
    const plan = resolveDrop({ x: 700, y: 190 }, scene());

    expect(plan.kind).toBe<DropKind>('replace');
    expect(plan.targetCardId).toBe(TARGET);
    expect(plan.portId).toBe('in:1');
    expect(plan.matrixId).toBe(C_CSV.matrixId);
    // 替换端口 B（原 b.csv → 新 c.csv） — the port's own variable, never the card's.
    expect(actionOf(plan)).toBe('replace');
    expect(plan.label.port).toBe('B');
    expect(plan.label.previous).toBe('b.csv');
    expect(plan.label.source).toBe('c.csv');
    expect(plan.highlight).toBe('accept');
  });

  it('adds a port when the drop lands on the card body, not on a row', () => {
    const plan = resolveDrop({ x: 700, y: 400 }, scene());

    expect(plan.kind).toBe<DropKind>('add');
    expect(plan.targetCardId).toBe(TARGET);
    expect(plan.portId).toBeUndefined();
    expect(plan.matrixId).toBe(C_CSV.matrixId);
    // 新增端口 C ← c.csv — the next free letter, as `addScriptInput` would allocate it.
    expect(plan.label.action).toBe('add');
    expect(plan.label.next).toBe('C');
    expect(plan.label.source).toBe('c.csv');
    expect(plan.highlight).toBe('accept');
  });

  it('refuses a chart card: it accepts no new input', () => {
    const plan = resolveDrop(
      { x: 1000, y: 200 },
      scene({
        cards: [
          card({ id: SOURCE, surface: 'data', rect: rect(100, 100, 400, 300) }),
          card({ id: CHART, name: 'chart C', surface: 'chart', rect: rect(900, 100, 400, 300) }),
        ],
      }),
    );

    expect(plan.kind).toBe<DropKind>('reject');
    expect(plan.reason).toBe<DropReason>('chart');
    expect(plan.highlight).toBe('refuse');
    expect(plan.label.action).toBe('refuse');
  });

  it('refuses a builtin-signature function card (expression / relation-enum / unit-convert)', () => {
    const plan = resolveDrop(
      { x: 700, y: 200 },
      scene({ cards: [scriptTarget([], rect(600, 100, 400, 400))], portRows: [] }),
    );
    // `inputSurfaceOf` maps a builtin-signature card to `signature`; the pure function only
    // has to honour the answer.
    const signature = resolveDrop(
      { x: 700, y: 200 },
      scene({
        cards: [
          card({ id: TARGET, name: 'expression', surface: 'signature', rect: rect(600, 100, 400, 400) }),
        ],
        portRows: [],
      }),
    );

    expect(plan.kind).toBe<DropKind>('add'); // a script card (surface 'inputs') does accept
    expect(signature.kind).toBe<DropKind>('reject');
    expect(signature.reason).toBe<DropReason>('signature');
    expect(signature.highlight).toBe('refuse');
  });

  it('refuses a data card: it publishes data, it never consumes it', () => {
    const plan = resolveDrop(
      { x: 300, y: 200 },
      scene({ cards: [card({ id: TARGET, name: 'data B', surface: 'data', rect: rect(200, 100, 400, 300) })] }),
    );
    expect(plan.kind).toBe<DropKind>('reject');
    expect(plan.reason).toBe<DropReason>('data');
  });

  it('refuses the source card itself before anything else', () => {
    const plan = resolveDrop({ x: 300, y: 200 }, scene());

    expect(plan.kind).toBe<DropKind>('reject');
    expect(plan.targetCardId).toBe(SOURCE);
    expect(plan.reason).toBe<DropReason>('self');
    expect(plan.label.action).toBe('refuse');
  });

  it('refuses a card downstream of the source: that is a cycle', () => {
    const plan = resolveDrop(
      { x: 700, y: 190 },
      scene({ isDownstream: (cardId) => cardId === TARGET }),
    );

    expect(plan.kind).toBe<DropKind>('reject');
    expect(plan.reason).toBe<DropReason>('cycle');
    expect(plan.highlight).toBe('refuse');
  });

  it('cancels on the bare canvas with zero side effects to describe', () => {
    const plan = resolveDrop({ x: 5000, y: 5000 }, scene());

    expect(plan.kind).toBe<DropKind>('cancel');
    expect(plan.targetCardId).toBeUndefined();
    expect(plan.matrixId).toBeUndefined();
    expect(plan.highlight).toBeNull();
    expect(plan.label.action).toBe('cancel');
  });

  it('is a no-op when that port already reads that exact matrix', () => {
    const plan = resolveDrop(
      { x: 700, y: 155 },
      scene({ sourceMatrices: [{ matrixId: 10, label: 'a.csv', outputId: null }] }),
    );

    expect(plan.kind).toBe<DropKind>('noop');
    expect(plan.portId).toBe('in:0');
    expect(plan.matrixId).toBe(10);
    // Nothing to paint red and nothing to write: the label says what is already true.
    expect(plan.highlight).toBeNull();
    expect(plan.label.action).toBe('noop');
    expect(plan.label.port).toBe('A');
  });

  it('never guesses out:0 — a multi-output source leaves the matrix to the chooser', () => {
    const plan = resolveDrop({ x: 700, y: 400 }, scene({ sourceMatrices: [C_CSV, D_CSV] }));

    expect(plan.kind).toBe<DropKind>('add');
    expect(plan.matrixId).toBeNull();
    expect(plan.choices?.map((choice) => choice.matrixId)).toEqual([20, 21]);
    // With several outputs there is no single name to print, so the label names the card.
    expect(plan.label.source).toBe('data A');
  });

  it('refuses a source that publishes no matrix at all', () => {
    const plan = resolveDrop({ x: 700, y: 400 }, scene({ sourceMatrices: [] }));

    expect(plan.kind).toBe<DropKind>('reject');
    expect(plan.reason).toBe<DropReason>('noSource');
  });

  it('hits the card painted last when two cards overlap', () => {
    const plan = resolveDrop(
      { x: 300, y: 200 },
      scene({
        cards: [
          card({ id: TARGET, name: 'below', surface: 'inputs', rect: rect(100, 100, 400, 300) }),
          card({ id: 9, name: 'above', surface: 'chart', rect: rect(150, 150, 300, 200) }),
        ],
        portRows: [],
      }),
    );
    expect(plan.targetCardId).toBe(9);
    expect(plan.reason).toBe<DropReason>('chart');
  });
});

// ── the pointer arbiter (§七) ───────────────────────────────────────────────────────

interface ArbiterHarness {
  arbiter: WireArbiter;
  states: WireState[];
  commit: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  /** The plan the stub resolver returns for the last point it was asked about. */
  setPlan(plan: DropPlan): void;
}

function plan(kind: DropKind, extra: Partial<DropPlan> = {}): DropPlan {
  const label = {
    action: kind === 'reject' ? ('refuse' as const) : kind === 'cancel' ? ('cancel' as const) : ('add' as const),
    port: null,
    next: 'C',
    source: 'c.csv',
    previous: null,
    reason: null,
  };
  return { kind, sourceCardId: SOURCE, label, ...extra };
}

function harness(initial: DropPlan = plan('add', { targetCardId: TARGET, matrixId: 20 })): ArbiterHarness {
  let current = initial;
  const states: WireState[] = [];
  const commit = vi.fn();
  const reject = vi.fn();
  const click = vi.fn();
  const resolve = vi.fn((point: ClientPoint) => {
    void point;
    return current;
  });
  const arbiter = new WireArbiter({
    // Identity: client px and plane px coincide in these tests, so an assertion about the
    // resolve point is also an assertion about where the release landed.
    toPlane: (client) => ({ x: client.x, y: client.y }),
    resolve,
    commit,
    reject,
    click,
    publish: (state) => states.push(state),
  });
  return {
    arbiter,
    states,
    commit,
    reject,
    click,
    resolve,
    setPlan: (next) => {
      current = next;
    },
  };
}

const PRESS: ClientPoint = { x: 100, y: 100 };

describe('WireArbiter — click and drag split at pointer-up, by displacement', () => {
  it('stays a candidate below the threshold and paints nothing', () => {
    const { arbiter, resolve, states } = harness();
    expect(arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS })).toBe(true);
    expect(arbiter.phase).toBe('candidate');

    arbiter.move({ pointerId: 1, client: { x: 102, y: 102 } }); // 2.8px

    expect(arbiter.phase).toBe('candidate');
    expect(resolve).not.toHaveBeenCalled();
    expect(arbiter.current.point).toBeNull();
    expect(states.map((state) => state.phase)).toEqual(['candidate']);
  });

  it('enters wiring at exactly the threshold and resolves the drop there', () => {
    const { arbiter, resolve } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });

    arbiter.move({ pointerId: 1, client: { x: PRESS.x + WIRE_DRAG_THRESHOLD, y: PRESS.y } });

    expect(arbiter.phase).toBe('wiring');
    expect(resolve).toHaveBeenCalledWith({ x: 104, y: 100 }, SOURCE);
    expect(arbiter.current.point).toEqual({ x: 104, y: 100 });
  });

  it('reads a release that never crossed the threshold as a right click', () => {
    const { arbiter, commit, click } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 102, y: 100 } });

    arbiter.release({ pointerId: 1, client: { x: 102, y: 100 } });

    expect(click).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(arbiter.current).toEqual(IDLE_WIRE_STATE);
  });

  it('commits the drop when the release happens past the threshold', () => {
    const { arbiter, commit, click } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
    arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });

    expect(click).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1]).toBe(20);
  });

  it('decides on the RELEASE point, not on the last move', () => {
    const { arbiter, resolve, commit } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });

    arbiter.release({ pointerId: 1, client: { x: 320, y: 310 } });

    // Once for the move, once for the release — and the release is what commits.
    expect(resolve).toHaveBeenLastCalledWith({ x: 320, y: 310 }, SOURCE);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('lets a refused drop reach the caller instead of writing', () => {
    const { arbiter, setPlan, commit, reject } = harness();
    setPlan(plan('reject', { targetCardId: TARGET, reason: 'cycle' }));
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
    arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });

    expect(reject).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(arbiter.current.choosing).toBeNull();
  });

  it('writes nothing for a cancel or a no-op release', () => {
    const cancelled = harness();
    cancelled.setPlan(plan('cancel'));
    cancelled.arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    cancelled.arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
    cancelled.arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });

    const noop = harness();
    noop.setPlan(plan('noop', { targetCardId: TARGET, portId: 'in:0', matrixId: 10 }));
    noop.arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    noop.arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
    noop.arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });

    for (const run of [cancelled, noop]) {
      expect(run.commit).not.toHaveBeenCalled();
      expect(run.reject).not.toHaveBeenCalled();
      expect(run.arbiter.current).toEqual(IDLE_WIRE_STATE);
    }
  });
});

describe('WireArbiter — discard paths never resurrect the wire', () => {
  it('throws the gesture away on Escape and ignores the following release', () => {
    const { arbiter, commit, states } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });

    expect(arbiter.cancel('escape')).toBe(true);
    expect(arbiter.phase).toBe('idle');
    expect(states[states.length - 1]).toEqual(IDLE_WIRE_STATE);

    arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });
    expect(commit).not.toHaveBeenCalled();
    // A second cancel has nothing left to cancel.
    expect(arbiter.cancel('escape')).toBe(false);
  });

  it('treats pointercancel, lost capture and blur the same way', () => {
    for (const reason of ['pointercancel', 'lostCapture', 'blur'] as const) {
      const { arbiter, commit } = harness();
      arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
      arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
      expect(arbiter.cancel(reason)).toBe(true);
      arbiter.release({ pointerId: 1, client: { x: 300, y: 300 } });
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it('has no long-press timer: time alone never promotes the gesture', () => {
    vi.useFakeTimers();
    try {
      const { arbiter, resolve, commit } = harness();
      arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
      vi.advanceTimersByTime(30_000);

      expect(arbiter.phase).toBe('candidate');
      expect(resolve).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores another pointer and refuses to arm twice', () => {
    const { arbiter, resolve } = harness();
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    expect(arbiter.start({ sourceCardId: TARGET, pointerId: 2, client: PRESS })).toBe(false);

    arbiter.move({ pointerId: 2, client: { x: 300, y: 300 } });
    expect(arbiter.phase).toBe('candidate');
    expect(resolve).not.toHaveBeenCalled();

    arbiter.move({ pointerId: 1, client: { x: 300, y: 300 } });
    expect(arbiter.phase).toBe('wiring');
  });
});

describe('WireArbiter — a multi-output source asks instead of guessing (ruling 4A)', () => {
  const multi = plan('add', { targetCardId: TARGET, matrixId: null, choices: [C_CSV, D_CSV] });

  it('opens the chooser at the release point and writes nothing yet', () => {
    const { arbiter, setPlan, commit } = harness();
    setPlan(multi);
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 700, y: 300 } });
    arbiter.release({ pointerId: 1, client: { x: 700, y: 300 } });

    expect(commit).not.toHaveBeenCalled();
    expect(arbiter.current.choosing).not.toBeNull();
    expect(arbiter.current.choosing?.targetCardId).toBe(TARGET);
    expect(arbiter.current.choosing?.choices.map((choice) => choice.matrixId)).toEqual([20, 21]);
    expect(arbiter.current.choosing?.client).toEqual({ x: 700, y: 300 });
    expect(arbiter.current.phase).toBe('idle');
  });

  it('commits the matrix the user picked — never output 0 by default', () => {
    const { arbiter, setPlan, commit } = harness();
    setPlan(multi);
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 700, y: 300 } });
    arbiter.release({ pointerId: 1, client: { x: 700, y: 300 } });

    expect(arbiter.choose(D_CSV.matrixId)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1]).toBe(D_CSV.matrixId);
    expect(arbiter.current).toEqual(IDLE_WIRE_STATE);
  });

  it('dismissing the chooser leaves exactly nothing behind', () => {
    const { arbiter, setPlan, commit } = harness();
    setPlan(multi);
    arbiter.start({ sourceCardId: SOURCE, pointerId: 1, client: PRESS });
    arbiter.move({ pointerId: 1, client: { x: 700, y: 300 } });
    arbiter.release({ pointerId: 1, client: { x: 700, y: 300 } });

    expect(arbiter.dismissChoice()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(arbiter.current).toEqual(IDLE_WIRE_STATE);
    expect(arbiter.dismissChoice()).toBe(false);
  });
});