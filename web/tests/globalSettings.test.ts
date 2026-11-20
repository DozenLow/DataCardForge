/**
 * Global settings layer (units L1a) — `web/src/ui/globalSettings.ts`.
 *
 * This is the ONE application-level store (everything else lives in a workspace snapshot),
 * so the contract it has to keep is small and absolute:
 *   - a value written is the value read back (round-trip), including after the in-memory
 *     cache is dropped — that is what "persisted" means for the next session;
 *   - storage that is absent, corrupt, blocked or holds unknown ids yields the documented
 *     defaults instead of throwing (a settings blob must never stop the app from opening);
 *   - an unknown unit in `unitPreconfirm` is dropped: the global layer is a DEFAULT, and a
 *     default that names an unregistered unit would make the resolver act on nothing.
 *
 * jsdom is required for the `localStorage` implementation.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_UNIT_POLICY,
  GLOBAL_SETTINGS_KEY,
  defaultGlobalSettings,
  getGlobalSettings,
  loadGlobalSettings,
  normalizeGlobalSettings,
  resetGlobalSettingsCache,
  saveGlobalSettings,
  setGlobalSettings,
  subscribeGlobalSettings,
} from '../src/ui/globalSettings.ts';

beforeEach(() => {
  localStorage.clear();
  resetGlobalSettingsCache();
});

afterEach(() => {
  localStorage.clear();
  resetGlobalSettingsCache();
});

describe('defaults', () => {
  it('starts strict with no pre-confirmations', () => {
    expect(defaultGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
    expect(DEFAULT_UNIT_POLICY).toBe('strict');
    expect(getGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
  });

  it('reads defaults from empty storage without writing anything', () => {
    expect(loadGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
    expect(localStorage.getItem(GLOBAL_SETTINGS_KEY)).toBeNull();
  });
});

describe('persistence round-trip', () => {
  it('writes on change and reads the same value back in a fresh session', () => {
    setGlobalSettings({ unitPolicy: 'auto', unitPreconfirm: { g: 'g', N: 'N' } });
    // The raw bytes are the persisted contract, not a side effect of the cache.
    expect(JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_KEY) ?? '{}')).toEqual({
      unitPolicy: 'auto',
      unitPreconfirm: { g: 'g', N: 'N' },
    });

    // A new session: nothing in memory, everything in storage.
    resetGlobalSettingsCache();
    expect(getGlobalSettings()).toEqual({ unitPolicy: 'auto', unitPreconfirm: { g: 'g', N: 'N' } });
  });

  it('patches one field without dropping the other', () => {
    setGlobalSettings({ unitPolicy: 'free' });
    setGlobalSettings({ unitPreconfirm: { ms: 'ms' } });
    resetGlobalSettingsCache();
    expect(getGlobalSettings()).toEqual({ unitPolicy: 'free', unitPreconfirm: { ms: 'ms' } });
  });

  it('saveGlobalSettings is the same persistence path as setGlobalSettings', () => {
    saveGlobalSettings({ unitPolicy: 'free', unitPreconfirm: {} });
    resetGlobalSettingsCache();
    expect(getGlobalSettings().unitPolicy).toBe('free');
  });

  it('notifies subscribers on change', () => {
    let calls = 0;
    const unsubscribe = subscribeGlobalSettings(() => {
      calls += 1;
    });
    setGlobalSettings({ unitPolicy: 'auto' });
    expect(calls).toBe(1);
    unsubscribe();
    setGlobalSettings({ unitPolicy: 'strict' });
    expect(calls).toBe(1);
  });
});

describe('corrupt / hostile storage falls back to defaults', () => {
  it('unparseable JSON', () => {
    localStorage.setItem(GLOBAL_SETTINGS_KEY, '{"unitPolicy": "auto"');
    expect(loadGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
  });

  it('JSON that is not an object', () => {
    localStorage.setItem(GLOBAL_SETTINGS_KEY, '"strict"');
    expect(loadGlobalSettings().unitPolicy).toBe('strict');
    localStorage.setItem(GLOBAL_SETTINGS_KEY, 'null');
    expect(loadGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
    localStorage.setItem(GLOBAL_SETTINGS_KEY, '[1,2]');
    // An array is an object to `typeof`; its fields are simply absent, so defaults apply.
    expect(loadGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
  });

  it('an unknown policy id is not repaired into a guess', () => {
    localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify({ unitPolicy: 'lenient' }));
    expect(loadGlobalSettings().unitPolicy).toBe('strict');
  });

  it('drops pre-confirmations that do not name a registered unit, keeps the rest', () => {
    localStorage.setItem(
      GLOBAL_SETTINGS_KEY,
      JSON.stringify({ unitPreconfirm: { g: 'g', bad: 'furlong', n: 5, '': 'm' } }),
    );
    expect(loadGlobalSettings().unitPreconfirm).toEqual({ g: 'g' });
  });

  it('keeps a non-scalar label unit (°C is a registered label, not convertible)', () => {
    expect(normalizeGlobalSettings({ unitPreconfirm: { c: '°C' } }).unitPreconfirm).toEqual({ c: '°C' });
  });

  it('a corrupted value never throws out of getGlobalSettings', () => {
    localStorage.setItem(GLOBAL_SETTINGS_KEY, '\u0000 not json');
    expect(() => getGlobalSettings()).not.toThrow();
    expect(getGlobalSettings().unitPolicy).toBe('strict');
  });

  it('survives a storage that throws on read and on write', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      expect(() => loadGlobalSettings()).not.toThrow();
      expect(loadGlobalSettings()).toEqual({ unitPolicy: 'strict', unitPreconfirm: {} });
      expect(() => setGlobalSettings({ unitPolicy: 'free' })).not.toThrow();
      // In-memory value still applies for this session: a blocked disk is not a broken app.
      expect(getGlobalSettings().unitPolicy).toBe('free');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      resetGlobalSettingsCache();
    }
  });
});