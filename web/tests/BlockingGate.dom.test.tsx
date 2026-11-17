/**
 * @vitest-environment jsdom
 *
 * The blocking gate: an environment/structure problem freezes automatic propagation, raises
 * one dialog, and releases by itself when the cause disappears. Compute errors are NOT
 * blockers — a typo in one card must not turn the workspace into a modal.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { PINNED_WORKSPACE_ENV } from '../src/ui/types.ts';
import { BlockingGate } from '../src/ui/components/BlockingGate.tsx';
import { stopTitleFlash } from '../src/ui/alerts.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <BlockingGate />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

beforeEach(() => {
  roots.splice(0);
  document.body.innerHTML = '';
  store().reset();
  store().setLocale('zh');
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  stopTitleFlash();
  store().reset();
});

describe('blocking gate', () => {
  it('raises the dialog for an environment mismatch and freezes propagation', async () => {
    useWorkspace.setState({
      workspaceEnv: { ...PINNED_WORKSPACE_ENV, python: 'cpython 0.0.0-foreign' },
    });
    const host = await mount();
    expect(host.querySelector('.blocking-gate')).not.toBeNull();
    expect(host.textContent).toContain('环境戳');
    expect(store().propagationFrozen).toBe(true);
    expect(store().blockers.map((blocker) => blocker.kind)).toEqual(['envMismatch']);
  });

  it('acknowledging closes only the dialog; the latch stays until the cause is gone', async () => {
    useWorkspace.setState({
      workspaceEnv: { ...PINNED_WORKSPACE_ENV, python: 'cpython 0.0.0-foreign' },
    });
    const host = await mount();
    const ack = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('知道了'),
    )!;
    await act(async () => ack.click());
    await flush();
    expect(host.querySelector('.blocking-gate')).toBeNull();
    expect(store().propagationFrozen).toBe(true);

    // The cause disappears → the latch releases by itself.
    useWorkspace.setState({ workspaceEnv: { ...PINNED_WORKSPACE_ENV } });
    await flush();
    expect(store().propagationFrozen).toBe(false);
    expect(store().blockers).toHaveLength(0);
  });

  it('reopens for a new blocker of another kind', async () => {
    useWorkspace.setState({
      workspaceEnv: { ...PINNED_WORKSPACE_ENV, python: 'cpython 0.0.0-foreign' },
    });
    const host = await mount();
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('知道了'))!
        .click();
    });
    await flush();
    expect(host.querySelector('.blocking-gate')).toBeNull();

    useWorkspace.setState({ backend: { state: 'offline', error: 'unreachable' } });
    await flush();
    expect(host.querySelector('.blocking-gate')).not.toBeNull();
    expect(host.textContent).toContain('后端不可达');
  });

  it('is not raised by a compute error', async () => {
    store().reset();
    useWorkspace.setState({ backend: { state: 'online' } });
    const host = await mount();
    expect(host.querySelector('.blocking-gate')).toBeNull();
    expect(store().blockers).toHaveLength(0);
  });
});
