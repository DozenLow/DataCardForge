import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NO_UNIT,
  candidateByUnit,
  resolveConfirmed,
  resolveUnit,
  unitSignature,
} from '../src/core/units.ts';

interface FixtureCase {
  annotation: string;
  state: 'recognized' | 'ambiguous' | 'unknown';
  unit?: string;
  token?: string;
  candidates?: string[];
  scalar?: boolean;
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(fixtureDir, 'fixtures/units/parse.json'), 'utf8'),
) as { cases: FixtureCase[] };

describe('unit resolver — shared fixtures', () => {
  for (const testCase of fixture.cases) {
    it(`${testCase.annotation} → ${testCase.state}${testCase.unit ? ` (${testCase.unit})` : ''}`, () => {
      const resolution = resolveUnit(testCase.annotation);
      expect(resolution.state).toBe(testCase.state);
      if (testCase.unit !== undefined) expect(resolution.unit).toBe(testCase.unit);
      if (testCase.token !== undefined) expect(resolution.token).toBe(testCase.token);
      if (testCase.candidates !== undefined) {
        expect(resolution.candidates.map((candidate) => candidate.unit)).toEqual(testCase.candidates);
      }
      if (testCase.scalar !== undefined) expect(resolution.scalar).toBe(testCase.scalar);
    });
  }
});

describe('unit resolver — suffix shape', () => {
  it('reports where the unit sits so the convert card can rewrite the suffix', () => {
    const resolution = resolveUnit('vibration_mm_s');
    expect(resolution.span).toEqual({ start: 10, end: 14 });
  });

  it('reads a bracketed suffix as a unit', () => {
    const degrees = resolveUnit('温度（℃）');
    expect(degrees.state).toBe('recognized');
    expect(degrees.unit).toBe('°C');
    expect(degrees.scalar).toBe(false);

    const pressure = resolveUnit('压力 (MPa)');
    expect(pressure.state).toBe('recognized');
    expect(pressure.unit).toBe('MPa');

    const torr = resolveUnit('压力 (bar)');
    expect(torr.unit).toBe('bar');
  });

  it('does not read a header with no suffix as a unit', () => {
    // Deliberate v1 limit: a column literally named "kPa" or "ph" has no suffix, so it is
    // not auto-parsed. Guessing whole headers is how `x` and `y` become units.
    expect(resolveUnit('kPa').state).toBe('unknown');
    expect(resolveUnit('ph').state).toBe('unknown');
  });

  it('keeps a longer composite suffix from being split into a short wrong unit', () => {
    // `kwh_m2` must win over `m2`; otherwise irradiance would be read as an area.
    expect(resolveUnit('irradiance_kwh_m2').unit).toBe('kWh/m²');
    expect(resolveUnit('dose_mg_l').unit).toBe('mg/L');
    expect(resolveUnit('velocity_umol_min').unit).toBe('µmol/min');
  });

  it('normalises Greek mu to the micro sign and folds case only when unique', () => {
    expect(resolveUnit('dose_μm').unit).toBe('µm');
    expect(resolveUnit('pressure_KPA').unit).toBe('kPa');
    // `nm` and `Nm` are different units; the exact spelling decides, never case folding.
    expect(resolveUnit('wavelength_nm').unit).toBe('nm');
    expect(resolveUnit('扭矩_Nm').unit).toBe('N·m');
  });

  it('never auto-confirms a single ASCII letter', () => {
    for (const annotation of ['current_a', 'voltage_v', 'accel_x_g', 'head_m', 'time_s', 'temp_c']) {
      expect(resolveUnit(annotation).state).toBe('ambiguous');
    }
  });
});

describe('unit confirmations', () => {
  it('applies a remembered unit and marks the column recognised', () => {
    const resolution = resolveConfirmed('time_s', 's');
    expect(resolution.state).toBe('recognized');
    expect(resolution.unit).toBe('s');
    expect(resolution.scalar).toBe(true);
  });

  it('honours an explicit "no unit" confirmation', () => {
    const resolution = resolveConfirmed('time_s', NO_UNIT);
    expect(resolution.state).toBe('unknown');
    expect(resolution.unit).toBe('');
  });

  it('ignores an unknown confirmation instead of inventing a unit', () => {
    const resolution = resolveConfirmed('time_s', 'furlong');
    expect(resolution.state).toBe('ambiguous');
  });

  it('exposes the registry metadata the convert card needs', () => {
    expect(candidateByUnit('kPa')).toMatchObject({ dimension: 'pressure', scalar: true });
    expect(candidateByUnit('kPa')?.factor).toBeCloseTo(1e3, 12);
    expect(candidateByUnit('bar')?.factor).toBeCloseTo(1e5, 12);
    expect(candidateByUnit('°C')).toMatchObject({ dimension: null, scalar: false });
    expect(candidateByUnit('nope')).toBeNull();
  });
});

describe('unit signature', () => {
  it('is stable for the same headers and different for different ones', () => {
    const a = unitSignature(['time_s', 'pressure_kpa']);
    const b = unitSignature(['time_s', 'pressure_kpa']);
    const c = unitSignature(['time_s', 'pressure_mpa']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('includes the column count so a prefix/suffix pair cannot collide', () => {
    expect(unitSignature(['a'])).not.toBe(unitSignature(['a', '']));
  });
});
