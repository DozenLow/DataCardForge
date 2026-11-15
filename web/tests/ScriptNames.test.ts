/**
 * The script card's naming rules, as pure functions.
 *
 * These are the rules the decision fixes in §二 and that no UI convenience may widen:
 * one namespace across both panels, reserved runner names, ASCII identifiers only, and
 * "a rename rewrites IDENTIFIER nodes" — a name inside a string, a comment or an attribute
 * is not a reference and must survive untouched. The DOM suite checks the same rules through
 * the panel; this file checks them at the seam where they are implemented, including the
 * alphabet used for birth binding that a 26-port card would exhaust.
 */
import { describe, expect, it } from 'vitest';

import {
  checkScriptName,
  countScriptOccurrences,
  isReservedScriptName,
  nextScriptOutputName,
  nextScriptVarName,
  renameInScript,
  scriptDeclarationError,
  scriptOccurrences,
  scriptPortLetter,
} from '../src/ui/workspaceStore.ts';
import { PYTHON_SIGNATURE, type FunctionCardModel } from '../src/ui/types.ts';

describe('names — birth binding alphabet', () => {
  it('goes A…Z, then A1, B1, … (a simple rule beats a clever one)', () => {
    expect(scriptPortLetter(0)).toBe('A');
    expect(scriptPortLetter(25)).toBe('Z');
    expect(scriptPortLetter(26)).toBe('A1');
    expect(scriptPortLetter(27)).toBe('B1');
    expect(scriptPortLetter(52)).toBe('A2');
  });

  it('picks the first letter nothing declares', () => {
    expect(nextScriptVarName([])).toBe('A');
    expect(nextScriptVarName(['A'])).toBe('B');
    expect(nextScriptVarName(['A', 'B', 'result'])).toBe('C');
  });

  it('names outputs as results, never as another letter', () => {
    expect(nextScriptOutputName([])).toBe('result');
    expect(nextScriptOutputName(['result'])).toBe('result2');
    expect(nextScriptOutputName(['result', 'result2'])).toBe('result3');
    // A letter-freed list is irrelevant: outputs only care about 'resultN'.
    expect(nextScriptOutputName(['A', 'B'])).toBe('result');
  });
});

describe('names — identifier occurrences', () => {
  const script = [
    'raw = A',
    'label = "A"',
    '# A is not a reference here either',
    'scaled = A * 2.0',
    'width = df.A',
    'result = scaled',
    '',
  ].join('\n');

  it('finds identifiers only — not strings, comments or attributes', () => {
    const occurrences = scriptOccurrences(script, 'A');
    expect(occurrences).toHaveLength(2);
    // `raw = A` and `scaled = A * 2.0` — the string, the comment and `df.A` are all skipped.
    expect(occurrences.map((entry) => script.slice(entry.from, entry.to))).toEqual(['A', 'A']);
    expect(countScriptOccurrences(script, 'A')).toBe(2);
  });

  it('does not match a longer identifier that merely starts the same way', () => {
    expect(countScriptOccurrences('A2 = A\n', 'A')).toBe(1);
    expect(countScriptOccurrences('A2 = A\n', 'A2')).toBe(1);
  });

  it('rewrites exactly those occurrences, leaving every other byte alone', () => {
    expect(renameInScript(script, 'A', 'sensor')).toBe(
      [
        'raw = sensor',
        'label = "A"',
        '# A is not a reference here either',
        'scaled = sensor * 2.0',
        'width = df.A',
        'result = scaled',
        '',
      ].join('\n'),
    );
  });

  it('is a no-op for a name the script never references', () => {
    expect(renameInScript('result = 1\n', 'A', 'x')).toBe('result = 1\n');
    expect(countScriptOccurrences('result = 1\n', 'A')).toBe(0);
  });
});

describe('names — the rules', () => {
  const judge = (name: string, panel: 'port' | 'output' = 'port') =>
    checkScriptName({ name, panel, portNames: ['A'], outputNames: ['result'] });

  it('accepts a free identifier', () => {
    expect(judge('temp')).toEqual({ error: null, warning: null });
  });

  it('refuses an empty name and a non-identifier', () => {
    expect(judge('').error).toEqual({ code: 'empty' });
    expect(judge('2bad').error?.code).toBe('notIdentifier');
    expect(judge('has space').error?.code).toBe('notIdentifier');
    expect(judge('中文').error?.code).toBe('notIdentifier');
  });

  it('refuses the runner’s reserved names', () => {
    for (const name of ['names_a', 'shape_a', 'meta', 'names_result']) {
      expect(judge(name).error).toEqual({ code: 'reserved', name });
      expect(isReservedScriptName(name)).toBe(true);
    }
    expect(isReservedScriptName('name')).toBe(false);
  });

  it('refuses a duplicate on either panel, naming the panel it clashes with', () => {
    // Same panel (a port taking another port's name).
    expect(judge('A')).toEqual({
      error: { code: 'duplicate', panel: 'port', name: 'A' },
      warning: null,
    });
    // Other panel (a port taking the output's name).
    expect(judge('result')).toEqual({
      error: { code: 'duplicate', panel: 'output', name: 'result' },
      warning: null,
    });
    // …and the mirror image from the output side.
    expect(judge('A', 'output')).toEqual({
      error: { code: 'duplicate', panel: 'port', name: 'A' },
      warning: null,
    });
  });

  it('warns about a case-only twin and about a keyword, without refusing either', () => {
    expect(judge('a')).toEqual({ error: null, warning: { code: 'caseTwin', name: 'A' } });
    expect(checkScriptName({ name: 'for', panel: 'port', portNames: [], outputNames: [] })).toEqual({
      error: null,
      warning: { code: 'keyword', name: 'for' },
    });
    // A keyword that differs only by case is still just a warning.
    expect(
      checkScriptName({ name: 'For', panel: 'port', portNames: [], outputNames: [] }).error,
    ).toBeNull();
  });
});

describe('declaration pre-flight', () => {
  function cardWith(params: Record<string, unknown>, ports: number): FunctionCardModel {
    return {
      kind: 'formula',
      id: 1,
      title: '',
      x: 0,
      y: 0,
      width: 780,
      height: 640,
      z: 1,
      createdAt: 0,
      inputs: Array.from({ length: ports }, (_, index) => ({
        portId: `in:${index}`,
        target: { type: 'matrix' as const, cardId: 2, matrixId: 100 + index },
      })),
      signatureId: PYTHON_SIGNATURE,
      params,
      outputs: [{ outputId: 'out:0', resultMatrixId: -1 }],
      node: null,
      result: null,
      displayMatrixId: 900,
    };
  }

  it('accepts a declaration the backend would accept', () => {
    expect(
      scriptDeclarationError(cardWith({ script: 'result = 1', portNames: ['A'], outputs: ['result'] }, 1)),
    ).toBeNull();
  });

  it('blames the field the backend would blame', () => {
    // One port, no declared name: the runner would inject nothing.
    expect(scriptDeclarationError(cardWith({ script: '', portNames: [], outputs: ['r'] }, 1))).toBe(
      'portNames',
    );
    // Names that are not identifiers, or repeat, are refused before the wire.
    expect(
      scriptDeclarationError(cardWith({ script: '', portNames: ['A b'], outputs: ['r'] }, 1)),
    ).toBe('portNames');
    expect(
      scriptDeclarationError(cardWith({ script: '', portNames: ['A'], outputs: [] }, 1)),
    ).toBe('outputs');
    expect(
      scriptDeclarationError(cardWith({ script: '', portNames: ['A'], outputs: ['r', 'r'] }, 1)),
    ).toBe('outputs');
  });
});