/**
 * Edge → wire endpoints, without a DOM.
 *
 * `resolveEdgeAnchors` is the priority rule from
 * `docs/decisions/2026-11-17-port-anchored-connections.md`, and these tests pin the three
 * things that can silently regress:
 *
 *   - which end wins when only one side renders a port (a level wire up to the other edge,
 *     not a wire angled away from the row it belongs to),
 *   - how the SOURCE output is recovered from data (the edge names the target's ports only;
 *     `publishedMatrices` — not this module — owns the "ordinal 0 is the display slot" rule),
 *   - that several ports on one pair of cards still produce ONE line (the average), because
 *     "one pair, one line" is a frozen contract.
 *
 * The measurement arrives through `PortMeasure`, so every case is plain objects.
 */
import { describe, expect, it } from 'vitest';

import type { Anchor, Rect } from '../src/ui/cardMetrics.ts';
import {
  facingSide,
  resolveEdgeAnchors,
  type PortMeasure,
} from '../src/ui/connectionAnchors.ts';
import type { DependencyEdge } from '../src/core/DependencyGraph.ts';
import type {
  CardModel,
  FunctionCardModel,
  MatrixCardModel,
  OutputBinding,
  PortConnection,
} from '../src/ui/types.ts';

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function functionCard(
  id: number,
  inputs: PortConnection[],
  outputs: OutputBinding[],
  displayMatrixId: number,
): FunctionCardModel {
  return {
    kind: 'formula',
    id,
    title: '',
    x: 0,
    y: 0,
    width: 200,
    height: 300,
    z: 1,
    createdAt: 0,
    inputs,
    signatureId: 'builtin:expression-columns',
    params: {},
    outputs,
    node: null,
    result: null,
    displayMatrixId,
  };
}

function dataCard(id: number, matrixId: number): MatrixCardModel {
  return {
    kind: 'matrix',
    id,
    title: '',
    x: 0,
    y: 0,
    width: 200,
    height: 300,
    z: 1,
    createdAt: 0,
    inputs: [],
    sources: [{ name: 'a.csv', matrixId }],
    activeSource: 0,
    readOnly: false,
  };
}

function edge(dependsOn: number, dependent: number, ports: string[]): DependencyEdge {
  return { dependsOn, dependent, ports };
}

/** One measured port, keyed the way the real registry keys one: `cardId:portId`. */
function measureFrom(entries: Record<string, Anchor>): PortMeasure {
  return (cardId, portId) => entries[`${cardId}:${portId}`] ?? null;
}

function portInput(portId: string, cardId: number, matrixId: number): PortConnection {
  return { portId, target: { type: 'matrix', cardId, matrixId } };
}

const noPorts = measureFrom({});

/** Two script-shaped cards side by side: source at (0,0), target at (400,0). */
function pair({
  sourceOutputs = [{ outputId: 'out:0', resultMatrixId: -1 }],
  sourceDisplay = 70,
  targetInputs = [portInput('in:0', 1, 70)],
}: {
  sourceOutputs?: OutputBinding[];
  sourceDisplay?: number;
  targetInputs?: PortConnection[];
} = {}) {
  const cards: CardModel[] = [
    functionCard(1, [], sourceOutputs, sourceDisplay),
    functionCard(2, targetInputs, [{ outputId: 'out:0', resultMatrixId: -1 }], 80),
  ];
  const rects = new Map<number, Rect>([
    [1, rect(0, 0, 200, 300)],
    [2, rect(400, 0, 200, 300)],
  ]);
  return { cards, rects };
}

describe('resolveEdgeAnchors', () => {
  it('anchors both ends on the rendered ports the edge belongs to', () => {
    const { cards, rects } = pair();
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0']),
      cards,
      rects,
      measureFrom({
        '1:out:0': { x: 200, y: 150, side: 'right' },
        '2:in:0': { x: 452, y: 120, side: 'left' },
      }),
    );

    expect(anchors).not.toBeNull();
    expect(anchors!.from).toEqual({
      point: { x: 200, y: 150 },
      side: 'right',
      portIds: ['out:0'],
      viaPort: true,
    });
    expect(anchors!.to).toEqual({
      point: { x: 452, y: 120 },
      side: 'left',
      portIds: ['in:0'],
      viaPort: true,
    });
  });

  it('recovers the source output through the local matrix id, not by position', () => {
    // `out:0` publishes the card's display slot (70); `out:1` has its own slot (77). The
    // target input names matrix id 77, so the wire must leave the SECOND output row.
    const { cards, rects } = pair({
      sourceOutputs: [
        { outputId: 'out:0', resultMatrixId: -1 },
        { outputId: 'out:1', resultMatrixId: -1, localMatrixId: 77 },
      ],
      targetInputs: [portInput('in:1', 1, 77)],
    });
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:1']),
      cards,
      rects,
      measureFrom({
        '1:out:0': { x: 200, y: 60, side: 'right' },
        '1:out:1': { x: 200, y: 260, side: 'right' },
        '2:in:1': { x: 400, y: 260, side: 'left' },
      }),
    );

    expect(anchors!.from.portIds).toEqual(['out:1']);
    expect(anchors!.from.point).toEqual({ x: 200, y: 260 });
  });

  it('does not invent an output when the target input maps to nothing', () => {
    // The edge names `in:0` but the target carries no such input: no source port may be
    // guessed (anchoring output 0 here would point at the wrong row).
    const { cards, rects } = pair({ targetInputs: [] });
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0']),
      cards,
      rects,
      measureFrom({ '1:out:0': { x: 200, y: 150, side: 'right' } }),
    );

    expect(anchors!.from.viaPort).toBe(false);
    expect(anchors!.to.viaPort).toBe(false);
  });

  it('averages several target ports into the one line the pair still gets', () => {
    const { cards, rects } = pair({
      targetInputs: [portInput('in:0', 1, 70), portInput('in:1', 1, 70)],
    });
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0', 'in:1']),
      cards,
      rects,
      measureFrom({
        '1:out:0': { x: 200, y: 150, side: 'right' },
        '2:in:0': { x: 400, y: 100, side: 'left' },
        '2:in:1': { x: 400, y: 300, side: 'left' },
      }),
    );

    expect(anchors!.to.point).toEqual({ x: 400, y: 200 });
    expect(anchors!.to.portIds).toEqual(['in:0', 'in:1']);
  });

  it('falls back to the facing card edge when the target renders no port', () => {
    const { cards, rects } = pair();
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0']),
      cards,
      rects,
      measureFrom({ '1:out:0': { x: 200, y: 150, side: 'right' } }),
    );

    // The target is to the right and the source anchor is at y = 150: the wire stays level
    // up to the target's left edge instead of angling away from the row it came from.
    expect(anchors!.to).toEqual({
      point: { x: 400, y: 150 },
      side: 'left',
      portIds: [],
      viaPort: false,
    });
  });

  it('uses each card edge midpoint when neither card renders a port', () => {
    const { cards, rects } = pair();
    const anchors = resolveEdgeAnchors(edge(1, 2, ['in:0']), cards, rects, noPorts);

    expect(anchors!.from.point).toEqual({ x: 200, y: 150 });
    expect(anchors!.from.side).toBe('right');
    expect(anchors!.to.point).toEqual({ x: 400, y: 150 });
    expect(anchors!.to.side).toBe('left');
    expect(anchors!.from.viaPort || anchors!.to.viaPort).toBe(false);
  });

  it('picks top/bottom for a vertically stacked pair', () => {
    const cards: CardModel[] = [
      functionCard(1, [], [{ outputId: 'out:0', resultMatrixId: -1 }], 70),
      functionCard(2, [portInput('in:0', 1, 70)], [{ outputId: 'out:0', resultMatrixId: -1 }], 80),
    ];
    const rects = new Map<number, Rect>([
      [1, rect(0, 0, 200, 200)],
      [2, rect(0, 400, 200, 200)],
    ]);

    const anchors = resolveEdgeAnchors(edge(1, 2, ['in:0']), cards, rects, noPorts);
    expect(anchors!.from).toMatchObject({ point: { x: 100, y: 200 }, side: 'bottom' });
    expect(anchors!.to).toMatchObject({ point: { x: 100, y: 400 }, side: 'top' });
  });

  it('clamps a measured anchor onto its own card', () => {
    const { cards, rects } = pair();
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0']),
      cards,
      rects,
      measureFrom({
        // A row scrolled above its panel reports a rect outside the card.
        '1:out:0': { x: 200, y: -40, side: 'right' },
        '2:in:0': { x: 452, y: 120, side: 'left' },
      }),
    );

    expect(anchors!.from.point).toEqual({ x: 200, y: 0 });
  });

  it('falls back for a data-card source while the target keeps its port', () => {
    const cards: CardModel[] = [
      dataCard(1, 70),
      functionCard(2, [portInput('in:0', 1, 70)], [{ outputId: 'out:0', resultMatrixId: -1 }], 80),
    ];
    const rects = new Map<number, Rect>([
      [1, rect(0, 0, 200, 300)],
      [2, rect(400, 0, 200, 300)],
    ]);
    const anchors = resolveEdgeAnchors(
      edge(1, 2, ['in:0']),
      cards,
      rects,
      measureFrom({ '2:in:0': { x: 452, y: 120, side: 'left' } }),
    );

    expect(anchors!.from.viaPort).toBe(false);
    expect(anchors!.from.side).toBe('right');
    expect(anchors!.from.point).toEqual({ x: 200, y: 120 });
    expect(anchors!.to.viaPort).toBe(true);
  });

  it('skips an edge whose card or rectangle is missing', () => {
    const { cards, rects } = pair();
    expect(resolveEdgeAnchors(edge(1, 99, []), cards, rects, noPorts)).toBeNull();
    expect(resolveEdgeAnchors(edge(99, 2, []), cards, rects, noPorts)).toBeNull();

    const missingTargetRect = new Map<number, Rect>([[1, rect(0, 0, 200, 300)]]);
    expect(resolveEdgeAnchors(edge(1, 2, []), cards, missingTargetRect, noPorts)).toBeNull();
  });
});

describe('facingSide', () => {
  const box = rect(0, 0, 100, 100);

  it('picks the dominant axis', () => {
    expect(facingSide(box, { x: 400, y: 50 })).toBe('right');
    expect(facingSide(box, { x: -400, y: 50 })).toBe('left');
    expect(facingSide(box, { x: 50, y: 400 })).toBe('bottom');
    expect(facingSide(box, { x: 50, y: -400 })).toBe('top');
  });

  it('breaks a diagonal tie toward the horizontal side', () => {
    expect(facingSide(box, { x: 200, y: 60 })).toBe('right');
    expect(facingSide(box, { x: 60, y: 200 })).toBe('bottom');
  });
});
