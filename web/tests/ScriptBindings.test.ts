/**
 * Card → protocol bindings for the Python script card.
 *
 * The script card is the first signature whose ports are named by the USER, so the wire
 * list has to answer two questions at once: which matrix feeds a port (edge identity,
 * `in:N`) and what name the script reads it under (`A`, `B`, …). The backend matches
 * `params.portNames[k]` with `inputs[k]`, so these tests pin the ORDER as hard as the values
 * — a silently re-ordered list would inject every name one port off.
 */
import { describe, expect, it } from 'vitest';

import { portBindingsFor, portVarName } from '../src/ui/bindings.ts';
import {
  PYTHON_SIGNATURE,
  type FunctionCardModel,
  type PortConnection,
} from '../src/ui/types.ts';

function scriptCard(
  inputs: PortConnection[],
  portNames: string[] | undefined,
): FunctionCardModel {
  const params: Record<string, unknown> = {
    script: 'result = A * 1.0\n',
    outputs: ['result'],
  };
  if (portNames !== undefined) params.portNames = portNames;
  return {
    kind: 'formula',
    id: 5,
    title: '',
    x: 0,
    y: 0,
    width: 780,
    height: 640,
    z: 1,
    createdAt: 0,
    inputs,
    signatureId: PYTHON_SIGNATURE,
    params,
    outputs: [{ outputId: 'out:0', resultMatrixId: -1 }],
    node: null,
    result: null,
    displayMatrixId: 900,
  };
}

const matrixPort = (portId: string, cardId: number, matrixId: number): PortConnection => ({
  portId,
  target: { type: 'matrix', cardId, matrixId },
});

/** Local id → server id, missing ids answer null the way an un-uploaded table does. */
const serverIds = (map: Record<number, number>) => (localId: number) => map[localId] ?? null;

describe('portBindingsFor — builtin:python', () => {
  it('turns the declared variable names into varNames, in inputs[] order', () => {
    const card = scriptCard(
      [matrixPort('in:0', 1, 7), matrixPort('in:1', 2, 9)],
      ['A', 'B'],
    );
    const bindings = portBindingsFor(card, serverIds({ 7: 70, 9: 90 }));
    expect(bindings).toEqual([
      { portId: 'in:0', varName: 'A', mode: 'matrix', sourceMatrixId: 70 },
      { portId: 'in:1', varName: 'B', mode: 'matrix', sourceMatrixId: 90 },
    ]);
  });

  it('keeps portId and varName independent (a rename never moves an edge)', () => {
    const card = scriptCard([matrixPort('in:0', 1, 7)], ['temperature']);
    const bindings = portBindingsFor(card, serverIds({ 7: 70 }))!;
    // The edge identity is still `in:0`; only the injected name changed.
    expect(bindings[0].portId).toBe('in:0');
    expect(bindings[0].varName).toBe('temperature');
  });

  it('falls back to the port id when no names are declared (every other signature)', () => {
    const card = scriptCard([matrixPort('src', 1, 7)], undefined);
    // Same rule, no signature knowledge: a card that declares nothing binds by port id, so
    // expression cards and regression cards keep their historical varName.
    expect(portVarName(card, card.inputs[0], 0)).toBe('src');
    expect(portBindingsFor(card, serverIds({ 7: 70 }))![0].varName).toBe('src');
  });

  it('refuses to bind a card whose sources are not all registered', () => {
    const card = scriptCard([matrixPort('in:0', 1, 7), matrixPort('in:1', 2, 9)], ['A', 'B']);
    // One unregistered source must produce NO list at all: a short list would shift the
    // names, a padded one would bind a name to a matrix the server does not hold.
    expect(portBindingsFor(card, serverIds({ 7: 70 }))).toBeNull();
  });

  it('carries the cell mode through unchanged', () => {
    const card = scriptCard(
      [{ portId: 'in:0', target: { type: 'cell', cardId: 1, matrixId: 7, column: 2 } }],
      ['col'],
    );
    expect(portBindingsFor(card, serverIds({ 7: 70 }))).toEqual([
      { portId: 'in:0', varName: 'col', mode: 'cell', sourceMatrixId: 70, columnIndex: 2 },
    ]);
  });
});