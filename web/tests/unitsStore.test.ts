/**
 * Column-unit confirmation memory (units v1, P1b).
 *
 * Locks the store contract from decisions/2026-11-18-units-v1.md §三:
 *   - a group confirm covers every UN-asked column of one matrix carrying the token,
 *   - it is idempotent and never invents an unregistered unit,
 *   - a single column can still be overridden / cleared,
 *   - memory is keyed by column-unit signature, so identical headers reuse the answer,
 *   - the snapshot carries the memory and a restore sanitises it (never guesses a unit).
 *
 * The matrix itself stores no unit: every assertion reads the DERIVED resolution.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { NO_UNIT, columnUnitResolutions, unitSignature } from '../src/core/units.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { MatrixCardModel, WorkspaceSnapshot } from '../src/ui/types.ts';

function matrix(rows: number[][], annotations: string[] = []): MatrixData {
  const mat = new MatrixData();
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let c = 0; c < columnCount; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, rows.map((row) => row[c] ?? NaN));
    if (annotations[c]) mat.setColumnAnnotation(c, annotations[c]);
  }
  return mat;
}

const store = () => useWorkspace.getState();

/** Add one matrix card and return its live matrix id. One row, one column per annotation. */
function addCard(annotations: string[]): number {
  const rows = [annotations.map(() => 1)];
  const id = store().addMatrixCard([{ name: 'u.txt', matrix: matrix(rows, annotations) }]);
  const card = store().cards.find((c) => c.id === id) as MatrixCardModel;
  return card.sources[0].matrixId;
}

function resolutionsOf(matrixId: number) {
  const mat = store().matrices.get(matrixId)!;
  return columnUnitResolutions(
    mat.columns().map((c) => c.annotation),
    store().unitConfirmations,
  );
}

beforeEach(() => {
  store().reset();
});

describe('confirmUnitGroup', () => {
  it('confirms every un-asked column carrying the token, and only those', () => {
    const matrixId = addCard(['current_a', 'cell_current_a', 'temp_c']);
    const affected = store().confirmUnitGroup(matrixId, 'a', 'A');
    expect(affected).toBe(2);

    const { resolutions } = resolutionsOf(matrixId);
    expect(resolutions[0].state).toBe('recognized');
    expect(resolutions[0].unit).toBe('A');
    expect(resolutions[1].unit).toBe('A');
    // A different token is a different question: it stays un-asked.
    expect(resolutions[2].state).toBe('ambiguous');
  });

  it('is idempotent — a second confirm touches nothing', () => {
    const matrixId = addCard(['current_a', 'cell_current_a']);
    expect(store().confirmUnitGroup(matrixId, 'a', 'A')).toBe(2);
    expect(store().confirmUnitGroup(matrixId, 'a', 'A')).toBe(0);
  });

  it('refuses an unregistered unit instead of inventing one', () => {
    const matrixId = addCard(['current_a']);
    expect(store().confirmUnitGroup(matrixId, 'a', 'furlong')).toBe(0);
    expect(resolutionsOf(matrixId).resolutions[0].state).toBe('ambiguous');
  });

  it('can confirm a non-scalar unit as a label (°C)', () => {
    const matrixId = addCard(['temp_c']);
    expect(store().confirmUnitGroup(matrixId, 'c', '°C')).toBe(1);
    const resolution = resolutionsOf(matrixId).resolutions[0];
    expect(resolution.state).toBe('recognized');
    expect(resolution.unit).toBe('°C');
    expect(resolution.scalar).toBe(false);
  });
});

describe('setColumnUnit', () => {
  it('overrides one column without touching its neighbours', () => {
    const matrixId = addCard(['current_a', 'cell_current_a']);
    store().setColumnUnit(matrixId, 0, 'A');
    const { resolutions } = resolutionsOf(matrixId);
    expect(resolutions[0].unit).toBe('A');
    expect(resolutions[1].state).toBe('ambiguous');
  });

  it('clears a unit with NO_UNIT', () => {
    const matrixId = addCard(['pressure_kpa']);
    expect(resolutionsOf(matrixId).resolutions[0].unit).toBe('kPa');
    store().setColumnUnit(matrixId, 0, NO_UNIT);
    expect(resolutionsOf(matrixId).resolutions[0].state).toBe('unknown');
  });
});

describe('signature reuse', () => {
  it('a second matrix with identical headers reuses the confirmation', () => {
    const first = addCard(['current_a', 'temp_c']);
    const second = addCard(['current_a', 'temp_c']);
    expect(first).not.toBe(second);

    store().confirmUnitGroup(first, 'a', 'A');
    // Same signature → the second matrix is already answered, no second confirm needed.
    const view = resolutionsOf(second);
    expect(view.resolutions[0].unit).toBe('A');
    expect(view.signature).toBe(unitSignature(['current_a', 'temp_c']));
  });

  it('different headers are a different signature and stay un-asked', () => {
    const first = addCard(['current_a']);
    const other = addCard(['voltage_a']);
    store().confirmUnitGroup(first, 'a', 'A');
    // Same token, different annotation sequence → different signature → still ambiguous.
    expect(resolutionsOf(other).resolutions[0].state).toBe('ambiguous');
  });
});

describe('snapshot round-trip', () => {
  it('toSnapshot carries the confirmation memory', () => {
    const matrixId = addCard(['current_a']);
    store().confirmUnitGroup(matrixId, 'a', 'A');
    const snapshot = store().toSnapshot();
    const signature = unitSignature(['current_a']);
    expect(snapshot.unitConfirmations?.[signature]?.[0]).toBe('A');
  });

  it('restore sanitises: keeps known units and NO_UNIT, drops the rest', () => {
    const signature = unitSignature(['current_a', 'temp_c']);
    const snapshot: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
      unitConfirmations: {
        [signature]: { 0: 'A', 1: 'furlong', 2: NO_UNIT },
      },
    };
    store().loadSnapshot(snapshot);
    const memory = store().unitConfirmations[signature];
    expect(memory[0]).toBe('A');
    expect(memory[1]).toBeUndefined(); // unregistered unit dropped
    expect(memory[2]).toBe(NO_UNIT);
  });

  it('a legacy snapshot without the block restores to empty memory', () => {
    const snapshot: WorkspaceSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    };
    store().loadSnapshot(snapshot);
    expect(store().unitConfirmations).toEqual({});
  });
});
