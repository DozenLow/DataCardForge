/**
 * @vitest-environment jsdom
 *
 * The workspace-trust panel. The store owns the record; this suite pins what the user sees and
 * what each click does: the first-run question, the per-script confirmations, and the bulk
 * action that only appears after three scripts were confirmed one by one.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { PYTHON_SIGNATURE, type FunctionCardModel } from '../src/ui/types.ts';
import { initialTrust } from '../src/ui/workspaceTrust.ts';
import { TrustPanel } from '../src/ui/components/TrustPanel.tsx';

const client = vi.hoisted(() => ({
  trustStatus: vi.fn(async () => ({
    ok: true,
    persistence: 'undecided',
    location: '',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustDecidePersistence: vi.fn(async (persist: boolean) => ({
    ok: true,
    persistence: persist ? 'persistent' : 'session',
    location: persist ? '/tmp/trust.json' : '',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustLookup: vi.fn(async (hash: string) => ({
    ok: true,
    hash,
    known: false,
    envMatch: true,
    scripts: [] as string[],
    persistence: 'persistent',
  })),
  trustRecord: vi.fn(async () => true),
  trustRevoke: vi.fn(async () => true),
}));

vi.mock('../src/backend/client.ts', () => ({
  PROTOCOL_VERSION: 1,
  REQUIRED_CAPABILITIES: [],
  decodeMatrixFrame: () => ({ ok: false, code: 'badFrame' }),
  BackendClient: class {
    constructor() {
      Object.assign(this, client);
    }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];
const HASH = 'a'.repeat(64);

function scriptCard(id: number): FunctionCardModel {
  return {
    kind: 'formula',
    id,
    title: `script ${id}`,
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    z: 1,
    createdAt: 0,
    inputs: [],
    signatureId: PYTHON_SIGNATURE,
    params: { script: 'result = 1\n', portNames: [], outputs: ['result'] },
    outputs: [{ outputId: 'out:0', resultMatrixId: -1 }],
    node: null,
    result: null,
    displayMatrixId: 100 + id,
  };
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <TrustPanel />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button')];
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(host).find((entry) => entry.textContent?.includes(text));
  if (!found) throw new Error(`no button "${text}" (had: ${buttons(host).map((b) => b.textContent).join(' | ')})`);
  return found;
}

beforeEach(() => {
  roots.splice(0);
  document.body.innerHTML = '';
  store().reset();
  store().setLocale('zh');
  client.trustStatus.mockClear();
  client.trustDecidePersistence.mockClear();
  client.trustLookup.mockClear();
  client.trustRecord.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  store().reset();
});

describe('workspace trust panel', () => {
  it('renders nothing for a workspace that did not come from a file', async () => {
    useWorkspace.setState({ cards: [scriptCard(3)] });
    const host = await mount();
    expect(host.querySelector('.trust-panel')).toBeNull();
  });

  it('asks the first-run persistence question and applies the answer', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'undecided',
        restoredScriptIds: [3],
      },
    });
    const host = await mount();
    expect(host.textContent).toContain('是否保留');
    expect(host.textContent).toContain('脚本来自未信任的文件');

    await act(async () => button(host, '保留信任记录').click());
    await flush();
    expect(client.trustDecidePersistence).toHaveBeenCalledWith(true);
    expect(store().trust.persistence).toBe('persistent');
    // The record is re-read after the decision: still nothing confirmed for this file.
    expect(client.trustLookup).toHaveBeenCalledWith(HASH);
  });

  it('confirms one script and records it for this file', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'persistent',
        restoredScriptIds: [3],
      },
    });
    const host = await mount();
    await act(async () => button(host, '信任').click());
    await flush();
    expect(store().trust.confirmed).toEqual([3]);
    expect(client.trustRecord).toHaveBeenCalledWith(HASH, ['3']);
    // Once every script is confirmed the panel has nothing left to say.
    expect(host.querySelector('.trust-panel')).toBeNull();
  });

  it('offers the bulk action only after three individual confirmations', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3), scriptCard(4), scriptCard(5), scriptCard(6), scriptCard(7)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'persistent',
        // No bulk action yet: nothing confirmed by hand.
        restoredScriptIds: [3, 4, 5, 6, 7],
        confirmed: [],
      },
    });
    let host = await mount();
    expect(buttons(host).some((entry) => entry.textContent?.includes('信任其余全部'))).toBe(false);

    useWorkspace.setState({
      trust: { ...store().trust, confirmed: [3, 4, 5] },
    });
    host = await mount();
    expect(buttons(host).some((entry) => entry.textContent?.includes('信任其余全部'))).toBe(true);

    await act(async () => button(host, '信任其余全部').click());
    await flush();
    expect(store().trust.confirmed).toEqual([3, 4, 5, 6, 7]);
    expect(client.trustRecord).toHaveBeenCalledWith(HASH, ['6', '7']);
  });

  it('trusts the file the user just saved', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'persistent',
        restoredScriptIds: [3],
      },
    });
    const saved = 'b'.repeat(64);
    await act(async () => {
      store().recordSavedWorkspace(saved, [3]);
    });
    await flush();
    expect(store().trust.hash).toBe(saved);
    expect(store().trust.confirmed).toEqual([3]);
    expect(client.trustRecord).toHaveBeenCalledWith(saved, ['3']);
  });

  it('says when the record came from another environment', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'persistent',
        envChanged: true,
        restoredScriptIds: [3],
      },
    });
    const host = await mount();
    expect(host.textContent).toContain('另一台机器');
  });

  it('treats an unreachable trust service as no permission, not as consent', async () => {
    useWorkspace.setState({
      cards: [scriptCard(3)],
      trust: {
        ...initialTrust(),
        hash: HASH,
        persistence: 'unavailable',
        error: 'backendUnavailable',
        restoredScriptIds: [3],
      },
    });
    const host = await mount();
    expect(host.textContent).toContain('信任服务不可用');
    expect(store().trust.confirmed).toEqual([]);
  });
});
