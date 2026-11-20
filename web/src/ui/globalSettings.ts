/**
 * Application-level settings (units L1a, docs/tasks/2026-11-19-units-l1.md §1).
 *
 * Before this module every persisted value lived in a workspace snapshot; the decision
 * (docs/decisions/2026-11-19-units-awareness-p3-and-formula-output.md §五) asks for one
 * GLOBAL layer as well, because a workspace may one day be embedded as another workspace's
 * card and the two must not share confirmations. The global layer is the fallback every
 * workspace inherits: it is stored in `localStorage`, keyed by one versioned key, and it
 * deliberately holds only what the decision names.
 *
 * Rules that make the fallback safe:
 *   - **Corrupt or absent storage falls back to defaults**, never throws. A blocked
 *     `localStorage` (private mode, quota, a hand-edited value) must not stop the app from
 *     opening, so every read is defensive and a failed write is silent.
 *   - **Unknown values are dropped, not repaired by guessing**: an unrecognised policy id or
 *     a pre-confirmation naming an unregistered unit is discarded on load, exactly like the
 *     snapshot's `unitConfirmations` sanitiser.
 *   - The module is a tiny observable so React can subscribe to it; the store reads it
 *     through `effectiveUnitPolicy`.
 */

import { candidateByUnit } from '../core/units.ts';

// The three policy tiers of the decision §二. `strict` is the product default.
//
// The union itself lives in `types.ts` (units L2b) because the tier now also travels to the
// backend as a node parameter; it is re-exported here so every existing import keeps working
// and there is exactly one definition of it.
import type { UnitPolicy } from './types.ts';

export type { UnitPolicy };

export const UNIT_POLICIES: readonly UnitPolicy[] = ['strict', 'auto', 'free'];

export const DEFAULT_UNIT_POLICY: UnitPolicy = 'strict';

export interface GlobalSettings {
  /**
   * Conflict policy when a column's derived unit disagrees with an expectation.
   *
   * `strict` asks (and only when something actually changed/would conflict), `auto` will
   * convert same-dimension values in a later slice, `free` never checks. L1a consumes the
   * value only for the drift hint's "strict only" rule; the other behaviours are L1b/L2.
   */
  unitPolicy: UnitPolicy;
  /**
   * Ambiguous token → unit, the application-wide DEFAULT answer (decision §三).
   *
   * It is a pre-confirmation, not a confirmation: a workspace confirmation or a card
   * assertion always wins, so this map is only consulted where nothing else speaks. L1a
   * stores and validates it (the UI that edits it is L1b).
   */
  unitPreconfirm: Record<string, string>;
}

/** Storage key. Versioned so a future incompatible shape can be dropped instead of guessed. */
export const GLOBAL_SETTINGS_KEY = 'datacardforge.settings.v1';

export function defaultGlobalSettings(): GlobalSettings {
  return { unitPolicy: DEFAULT_UNIT_POLICY, unitPreconfirm: {} };
}

function isPolicy(value: unknown): value is UnitPolicy {
  return typeof value === 'string' && (UNIT_POLICIES as readonly string[]).includes(value);
}

/**
 * Coerce a parsed blob into the settings shape.
 *
 * Pure and total: every field is validated independently, so one bad key does not throw
 * away the rest. A pre-confirmation must name a registered unit — anything else would let
 * the global layer invent a unit the resolver cannot act on.
 */
export function normalizeGlobalSettings(raw: unknown): GlobalSettings {
  const settings = defaultGlobalSettings();
  if (typeof raw !== 'object' || raw === null) return settings;
  const record = raw as { unitPolicy?: unknown; unitPreconfirm?: unknown };
  if (isPolicy(record.unitPolicy)) settings.unitPolicy = record.unitPolicy;
  const preconfirm = record.unitPreconfirm;
  if (typeof preconfirm === 'object' && preconfirm !== null) {
    for (const [token, unit] of Object.entries(preconfirm as Record<string, unknown>)) {
      if (token === '' || typeof unit !== 'string') continue;
      if (!candidateByUnit(unit)) continue;
      settings.unitPreconfirm[token] = unit;
    }
  }
  return settings;
}

/** The browser's storage, or `null` when the environment has none (SSR, tests, blocked). */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Accessing `localStorage` throws outright when the browser has blocked it.
    return null;
  }
}

/** Read the persisted settings. Absent, unreadable or corrupt storage ⇒ defaults. */
export function loadGlobalSettings(): GlobalSettings {
  const store = storage();
  if (!store) return defaultGlobalSettings();
  let text: string | null;
  try {
    text = store.getItem(GLOBAL_SETTINGS_KEY);
  } catch {
    return defaultGlobalSettings();
  }
  if (text === null) return defaultGlobalSettings();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A truncated or hand-mangled value is not a reason to refuse to start.
    return defaultGlobalSettings();
  }
  return normalizeGlobalSettings(parsed);
}

/** Persist the settings. A refused write (quota, private mode) is silent, not fatal. */
export function saveGlobalSettings(settings: GlobalSettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(normalizeGlobalSettings(settings)));
  } catch {
    /* storage refused the write; the in-memory value still applies for this session */
  }
}

// ── live value + subscription ────────────────────────────────────────────────────────

let current: GlobalSettings | null = null;
const listeners = new Set<() => void>();

/** The live settings, loaded from storage on first access. */
export function getGlobalSettings(): GlobalSettings {
  if (current === null) current = loadGlobalSettings();
  return current;
}

/** Replace the settings (partial patch), normalise, persist and notify subscribers. */
export function setGlobalSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  current = normalizeGlobalSettings({ ...getGlobalSettings(), ...patch });
  saveGlobalSettings(current);
  for (const listener of [...listeners]) listener();
  return current;
}

/**
 * Subscribe to changes. Returns the unsubscribe function.
 *
 * The listener signature takes no argument: it is meant for `useSyncExternalStore`, whose
 * contract is "tell me something changed, I will re-read". Consumers that also need the live
 * object call `getGlobalSettings` in the same callback — the value is symmetric with the
 * subscription lifetime (it is read on use, never captured at subscribe time).
 */
export function subscribeGlobalSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop the in-memory copy so the next read re-loads from storage.
 *
 * For tests and for an explicit "reset settings" action; it also keeps a stale value from
 * surviving a storage clear performed elsewhere in the same tab.
 */
export function resetGlobalSettingsCache(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}