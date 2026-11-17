/**
 * The pure half of workspace trust: the file hash and the "may this script run?" predicate.
 *
 * The predicate is the one place every execution path asks (buttons, shortcut, store run, and
 * later the automatic rerun), so its three cases are pinned here: a workspace with no file,
 * a card authored in this session, and a card restored from a file.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { hashWorkspaceBytes, initialTrust, scriptTrusted } from '../src/ui/workspaceTrust.ts';

describe('hashWorkspaceBytes', () => {
  it('returns the SHA-256 hex of the exact bytes', async () => {
    const bytes = new TextEncoder().encode('{"version":1}').buffer;
    const expected = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    await expect(hashWorkspaceBytes(bytes)).resolves.toBe(expected);
  });

  it('changes when one byte changes', async () => {
    const a = await hashWorkspaceBytes(new TextEncoder().encode('abc').buffer);
    const b = await hashWorkspaceBytes(new TextEncoder().encode('abd').buffer);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('scriptTrusted', () => {
  const hash = 'a'.repeat(64);

  it('trusts every script of a workspace that has no file', () => {
    expect(scriptTrusted(initialTrust(), 7)).toBe(true);
  });

  it('trusts a card authored in this session even when the file is untrusted', () => {
    const trust = { ...initialTrust(), hash, restoredScriptIds: [3, 4] };
    expect(scriptTrusted(trust, 9)).toBe(true);
  });

  it('requires a confirmation for a script restored from an untrusted file', () => {
    const trust = { ...initialTrust(), hash, restoredScriptIds: [3, 4], confirmed: [4] };
    expect(scriptTrusted(trust, 3)).toBe(false);
    expect(scriptTrusted(trust, 4)).toBe(true);
  });
});
