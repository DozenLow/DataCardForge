/**
 * Workspace trust — the rules the client enforces around "this file's scripts may run".
 *
 * The backend stores which FILE hashes the user blessed (see `src/trust_store.h`); this module
 * owns what those records mean to the UI, and one pure predicate: a script card is trusted
 * when it did not come from a file (authored in this session), when the file's hash is not
 * known yet (a fresh workspace has no hash), or when the user confirmed it. Everything that
 * executes a script — the Run/Debug buttons and, later, automatic reruns — asks this one
 * question, so there is no second place where "trusted" could drift.
 */
import type { TrustPersistenceName } from '../backend/client.ts';

/** `unknown` = the backend has not answered yet (treat as untrusted until it does). */
export type TrustPersistence = TrustPersistenceName | 'unknown';

export interface WorkspaceTrust {
  /** SHA-256 of the opened workspace file's bytes; null = this workspace has no file. */
  hash: string | null;
  persistence: TrustPersistence;
  /** Where the record lives when `persistence === 'persistent'`. */
  location: string | null;
  /** The record belongs to another machine/environment and is ignored. */
  envChanged: boolean;
  /** Script card ids confirmed this session (seeded from the backend record). */
  confirmed: number[];
  /** Script card ids that came from the file (anything else was authored here). */
  restoredScriptIds: number[];
  loading: boolean;
  /** Transport-level failure that produced the current (untrusted) state, if any. */
  error: string | null;
}

export function initialTrust(): WorkspaceTrust {
  return {
    hash: null,
    persistence: 'unknown',
    location: null,
    envChanged: false,
    confirmed: [],
    restoredScriptIds: [],
    loading: false,
    error: null,
  };
}

/**
 * May this script card execute?
 *
 * A card created in this session is the user's own work and never waits for a record; a card
 * restored from a file is trusted only after the file was known or the card was confirmed.
 */
export function scriptTrusted(trust: WorkspaceTrust, cardId: number): boolean {
  // While the file's record is being looked up, nothing may run automatically: an unknown
  // answer must not be read as consent.
  if (trust.loading) return false;
  if (trust.hash === null) return true;
  if (!trust.restoredScriptIds.includes(cardId)) return true;
  return trust.confirmed.includes(cardId);
}

/** SHA-256 hex of the exact bytes the workspace file was read from. */
export async function hashWorkspaceBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable: cannot hash the workspace file');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
