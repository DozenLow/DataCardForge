/**
 * Unit-drift detection (units L1a §3) — the pure comparison behind the strict-tier hint.
 *
 * The hint's whole value is that it is RARE: a workspace that prompts on every open trains
 * the user to dismiss it. So the cases that must stay silent are locked here with as much
 * weight as the ones that must speak:
 *   - the same units in the same names → no drift;
 *   - two headers that both carry no unit → still no drift ("nothing" twice is agreement);
 *   - a column that appears or disappears on one side → not a contradiction, no drift;
 *   - a column renamed → a different name, so not compared (the file's identity moved);
 *   - a unit that changed, or a header that became ambiguous → drift.
 */
import { describe, expect, it } from 'vitest';

import { NO_UNIT, unitSignature, type UnitConfirmations } from '../src/core/units.ts';
import { columnDriftKey, detectUnitDrift } from '../src/ui/unitDrift.ts';

/** One version of a table: annotations in column order, positional names like the backend's. */
function table(annotations: string[], confirmations: UnitConfirmations = {}) {
  return {
    columns: annotations.map((annotation, index) => ({
      posName: `Pos.${index + 1}`,
      annotation,
    })),
    confirmations,
  };
}

/** Confirmation memory that answers column `index` of one annotation list. */
function confirm(annotations: string[], index: number, unit: string): UnitConfirmations {
  return { [unitSignature(annotations)]: { [index]: unit } };
}

describe('detectUnitDrift', () => {
  it('is silent when the same columns resolve to the same units', () => {
    expect(detectUnitDrift(table(['pressure_kpa', 'time_s']), table(['pressure_kpa', 'time_s']))).toEqual([]);
  });

  it('reports a changed unit of the same quantity (same stem, new suffix)', () => {
    const drift = detectUnitDrift(table(['pressure_kpa']), table(['pressure_bar']));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toEqual({
      stem: 'pressure',
      before: { name: 'pressure_kpa', unit: 'kPa', ambiguous: false },
      after: { name: 'pressure_bar', unit: 'bar', ambiguous: false },
    });
  });

  it('reports a header that became ambiguous', () => {
    // `signal_value` says nothing; `signal_value_ms` collides (ms = milliseconds or m/s),
    // so the file now makes a claim the resolver cannot read.
    const drift = detectUnitDrift(table(['signal_value']), table(['signal_value_ms']));
    expect(drift).toHaveLength(1);
    expect(drift[0].stem).toBe('signal_value');
    expect(drift[0].before).toMatchObject({ unit: '', ambiguous: false });
    expect(drift[0].after).toMatchObject({ unit: '', ambiguous: true });
  });

  it('is silent when both sides have no unit (unknown twice is agreement)', () => {
    expect(detectUnitDrift(table(['sample_id']), table(['sample_id']))).toEqual([]);
    // …and when the same ambiguous token is present on both sides.
    expect(detectUnitDrift(table(['signal_value_ms']), table(['signal_value_ms']))).toEqual([]);
  });

  it('ignores columns that exist on only one side', () => {
    expect(detectUnitDrift(table(['pressure_kpa']), table(['pressure_kpa', 'temp_k']))).toEqual([]);
    expect(detectUnitDrift(table(['pressure_kpa', 'temp_k']), table(['pressure_kpa']))).toEqual([]);
  });

  it('does not compare a renamed quantity with the one it replaced', () => {
    // Same position, different stem: the card's column 0 is now a different measurement, so
    // there is no earlier claim for the new file to contradict.
    expect(detectUnitDrift(table(['pressure_kpa']), table(['force_n']))).toEqual([]);
  });

  it('reads each side with its own confirmation memory', () => {
    const annotations = ['signal_value_ms'];
    // The user once answered the collision ("bar"); the same answer applies to the new table.
    const before = table(annotations, confirm(annotations, 0, 'bar'));
    expect(detectUnitDrift(before, table(['signal_value_ms'], confirm(['signal_value_ms'], 0, 'bar')))).toEqual([]);

    // The answer is gone (a hand-edited file, or one answered for different headers): the
    // column is contested again, and that IS drift.
    const lost = detectUnitDrift(before, table(['signal_value_ms']));
    expect(lost).toHaveLength(1);
    expect(lost[0].before).toMatchObject({ unit: 'bar', ambiguous: false });
    expect(lost[0].after).toMatchObject({ unit: '', ambiguous: true });

    // An explicit "no unit" answer is a RESOLVED state, not an ambiguity.
    const rejected = detectUnitDrift(table(['signal_value_ms']), table(['signal_value_ms'], confirm(['signal_value_ms'], 0, NO_UNIT)));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].after).toMatchObject({ unit: '', ambiguous: false });
  });

  it('reports every changed column, in the new table’s column order', () => {
    const drift = detectUnitDrift(
      table(['pressure_kpa', 'wavelength_nm']),
      table(['pressure_bar', 'wavelength_um']),
    );
    expect(drift.map((entry) => [entry.stem, entry.after.name])).toEqual([
      ['pressure', 'pressure_bar'],
      ['wavelength', 'wavelength_um'],
    ]);
    expect(drift.map((entry) => [entry.before.unit, entry.after.unit])).toEqual([
      ['kPa', 'bar'],
      ['nm', 'µm'],
    ]);
  });

  it('does not mistake a token that is ambiguous on both sides for a change', () => {
    // `time_s` and `time_ms` both carry an ambiguous token (a single letter, and `ms`), so
    // neither side states a unit: unchanged uncertainty stays silent.
    expect(detectUnitDrift(table(['time_s']), table(['time_ms']))).toEqual([]);
  });

  it('pairs a bracketed unit suffix on its stem as well', () => {
    const drift = detectUnitDrift(table(['压力 (kPa)']), table(['压力 (MPa)']));
    expect(drift).toHaveLength(1);
    expect(drift[0].stem).toBe('压力');
    expect([drift[0].before.unit, drift[0].after.unit]).toEqual(['kPa', 'MPa']);
  });
});

describe('columnDriftKey', () => {
  it('removes the resolved unit suffix and keeps the quantity name', () => {
    expect(columnDriftKey({ posName: 'Pos.1', annotation: 'pressure_kpa' })).toBe('pressure');
    expect(columnDriftKey({ posName: 'Pos.1', annotation: 'vibration_mm_s' })).toBe('vibration');
    expect(columnDriftKey({ posName: 'Pos.1', annotation: '压力 (MPa)' })).toBe('压力');
  });

  it('falls back to the positional name when the file carries no annotation', () => {
    expect(columnDriftKey({ posName: 'Pos.1', annotation: '' })).toBe('Pos.1');
    expect(columnDriftKey({ posName: 'Pos.2', annotation: '   ' })).toBe('Pos.2');
  });

  it('keeps a header with no unit suffix as its own key', () => {
    expect(columnDriftKey({ posName: 'Pos.1', annotation: 'sample_id' })).toBe('sample_id');
  });

  it('trims so a stray space is not read as a rename', () => {
    expect(columnDriftKey({ posName: 'Pos.1', annotation: '  time_s  ' })).toBe('time');
  });
});
