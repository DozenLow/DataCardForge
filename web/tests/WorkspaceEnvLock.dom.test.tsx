/**
 * @vitest-environment jsdom
 *
 * The environment-lock UX, as the user meets it: the global banners and the two things they
 * change on a script card.
 *
 * What these tests pin, and why each one is a behavioural claim rather than a snapshot:
 *
 *   - a matching workspace says NOTHING (a permanent banner would be noise);
 *   - a mismatched one names both python versions, and its button only closes the banner —
 *     the stamp keeps the file's values and no compute request is ever made;
 *   - the script card's stamp prints the WORKSPACE's versions, not this build's pinned ones;
 *   - "this workspace contains N user scripts, none auto-run" appears exactly once for the
 *     whole workspace, however many script cards it holds;
 *   - a missing runtime is a red band ON the card, while the declaration panels and the
 *     editor stay exactly as usable as they were — no blank card, no silent degradation.
 *
 * The transport is mocked at the client seam (as in `ScriptCard.dom.test.tsx`): these tests
 * are about what the UI says and what it does NOT do (run anything), not about HTTP.
 */
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { emptyScriptRun, useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  isScriptCard,
  type WorkspaceEnv,
  type WorkspaceSnapshot,
} from '../src/ui/types.ts';
import { ScriptCard } from '../src/ui/components/ScriptCard.tsx';
import { WorkspaceEnvBanner } from '../src/ui/components/WorkspaceEnvBanner.tsx';

const client = vi.hoisted(() => ({
  hello: vi.fn(async () => ({ ok: true })),
  signatures: vi.fn(async () => []),
  registerMatrix: vi.fn(async (_name: string) => ({ ok: true, matrixId: 70, revision: 1 })),
  patchCells: vi.fn(async () => ({ ok: true })),
  deleteMatrix: vi.fn(async () => ({ ok: true })),
  createNode: vi.fn(async (_inputs: unknown, arg: unknown) => ({
    ok: true,
    nodeId: 11,
    resultMatrixId: 111,
    resultMatrixIds: [111],
    signatureId:
      typeof arg === 'string'
        ? 'builtin:expression-columns'
        : (arg as { signatureId: string }).signatureId,
    state: 'dirty',
  })),
  patchNode: vi.fn(async (nodeId: number) => ({ ok: true, nodeId, state: 'dirty' })),
  deleteNode: vi.fn(async () => ({ ok: true })),
  getNode: vi.fn(async () => null),
  computeNode: vi.fn(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [111],
  })),
  checkAccuracy: vi.fn(async () => ({})),
  checkScript: vi.fn(async (_script: string) => ({ ok: true, impure: [] as string[] })),
  listNodes: vi.fn(async () => []),
  nodeResult: vi.fn(async () => ({ ok: false })),
  events: vi.fn(async () => []),
  window: vi.fn(async () => ({
    ok: true,
    rows: 2,
    columns: 1,
    totalRows: 2,
    totalCols: 1,
    names: ['Pos.1'],
    data: [new Float64Array([10, 20])],
  })),
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
const roots: Root[] = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** A stamp from another machine: same layout, different values. */
const FOREIGN_ENV: WorkspaceEnv = {
  python: '3.12.4',
  packages: [
    {
      name: 'numpy',
      version: '2.2.0',
      platform: 'cp312-manylinux_2_17_x86_64',
      sha256: 'aa'.repeat(32),
    },
  ],
};

function table(rows: number): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', Array.from({ length: rows }, (_, index) => index + 1));
  data.setColumnAnnotation(0, 'value');
  return data;
}

let sourceCardId = 0;
let scriptCardId = 0;

/** Mount anything into a fresh host and return it (unmounted by `afterEach`). */
async function mount(ui: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<StrictMode>{ui}</StrictMode>);
  });
  await flush();
  return host;
}

/** The store holds the authority; the mounted card follows it, like CardCanvas does. */
function ScriptHarness({ cardId }: { cardId: number }) {
  const card = useWorkspace((state) => state.cards.find((entry) => entry.id === cardId));
  if (!card || !isScriptCard(card)) return null;
  return (
    <ScriptCard
      card={card}
      active
      closeBlocked={false}
      onActivate={() => {}}
      onClose={() => {}}
      onCloseBlocked={() => {}}
    />
  );
}

beforeEach(async () => {
  store().reset();
  store().setLocale('zh');
  sourceCardId = store().addMatrixCard([{ name: 'a.csv', matrix: table(2) }]);
  await flush();
  scriptCardId = store().addScriptCard([sourceCardId]) as number;
  await flush();
  client.computeNode.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  store().reset();
});

/** A snapshot of what is on screen right now, with its `env` block replaced. */
function snapshotWithEnv(env: WorkspaceEnv): WorkspaceSnapshot {
  return { ...store().toSnapshot(), env };
}

/** Reload the current workspace from a snapshot (the "open a saved file" path). */
async function reload(snapshot: WorkspaceSnapshot): Promise<void> {
  store().reset();
  store().loadSnapshot(snapshot);
  await flush();
}

const scriptCardIdInStore = (): number => store().cards.find(isScriptCard)!.id;

describe('environment stamp mismatch banner', () => {
  it('says nothing when the workspace matches this machine', async () => {
    const host = await mount(<WorkspaceEnvBanner />);
    expect(host.querySelector('[data-banner]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('names both python versions and closes without running anything', async () => {
    await reload(snapshotWithEnv(FOREIGN_ENV));
    const host = await mount(<WorkspaceEnvBanner />);

    const banner = host.querySelector('[data-banner="env-mismatch"]');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('alert');
    expect(banner!.textContent).toContain('工作区环境戳与本机不一致');
    expect(banner!.textContent).toContain('工作区 python 3.12.4');
    expect(banner!.textContent).toContain('本机 python 3.13.18');

    const button = [...host.querySelectorAll('button')].find(
      (entry) => entry.textContent === '以当前环境重算',
    ) as HTMLButtonElement;
    expect(button).toBeDefined();
    await act(async () => {
      button.click();
    });
    await flush();

    // The banner closes…
    expect(host.querySelector('[data-banner="env-mismatch"]')).toBeNull();
    // …the stamp keeps the file's values…
    expect(store().workspaceEnv.python).toBe('3.12.4');
    // …and nothing was executed, before or after closing it.
    expect(client.computeNode).not.toHaveBeenCalled();
  });

  it('prints the workspace stamp on the card, not this build’s pinned versions', async () => {
    await reload(snapshotWithEnv(FOREIGN_ENV));
    const host = await mount(<ScriptHarness cardId={scriptCardIdInStore()} />);

    const stamp = host.querySelector('.script-card__env');
    expect(stamp?.textContent).toContain('python 3.12.4');
    expect(stamp?.textContent).toContain('numpy 2.2.0');
    expect(stamp?.textContent).not.toContain('3.13.18');
  });
});

describe('“this workspace contains N scripts” notice', () => {
  it('appears exactly once for the whole workspace and runs nothing', async () => {
    // Two script cards: the sentence must still be ONE, with the correct count.
    store().addScriptCard([sourceCardId]);
    await flush();
    const snapshot = store().toSnapshot();
    expect(snapshot.cards.filter(isScriptCard)).toHaveLength(2);

    await reload(snapshot);
    const host = await mount(<WorkspaceEnvBanner />);

    const notices = host.querySelectorAll('[data-banner="script-notice"]');
    expect(notices).toHaveLength(1);
    expect(notices[0].getAttribute('role')).toBe('status');
    expect(notices[0].textContent).toContain('本工作区包含 2 段用户脚本');
    // The count is a count of cards — nothing was executed to produce it.
    expect(client.computeNode).not.toHaveBeenCalled();
  });

  it('can be dismissed, and stays gone for that workspace', async () => {
    const snapshot = snapshotWithEnv(FOREIGN_ENV);
    await reload(snapshot);
    expect(store().scriptNotice).toBe(1);

    const host = await mount(<WorkspaceEnvBanner />);
    const dismiss = [...host.querySelectorAll('button')].find(
      (entry) => entry.textContent === '知道了',
    ) as HTMLButtonElement;
    await act(async () => {
      dismiss.click();
    });
    await flush();

    expect(host.querySelector('[data-banner="script-notice"]')).toBeNull();
    // The mismatch banner is a different notice and is unaffected by the dismissal.
    expect(host.querySelector('[data-banner="env-mismatch"]')).not.toBeNull();
  });

  it('stays silent for a workspace without scripts', async () => {
    await reload({ ...store().toSnapshot(), cards: [], matrices: [], nextCardId: 1, nextMatrixId: 1 });
    const host = await mount(<WorkspaceEnvBanner />);
    expect(host.querySelector('[data-banner="script-notice"]')).toBeNull();
  });
});

describe('missing Python runtime', () => {
  /** The exact shape the store writes when compute fails with `runtimeMissing`. */
  function markRuntimeMissing(cardId: number): void {
    useWorkspace.setState({
      scriptRuns: {
        [cardId]: {
          ...emptyScriptRun(),
          status: 'error',
          mode: 'clean',
          code: 'runtimeMissing',
          params: { detail: 'no python in third_party/pyruntime' },
        },
      },
    });
  }

  it('renders a red band, keeps the card usable, and retries nothing', async () => {
    markRuntimeMissing(scriptCardId);
    const host = await mount(<ScriptHarness cardId={scriptCardId} />);

    const band = host.querySelector('[data-script-runtime-missing]');
    expect(band).not.toBeNull();
    expect(band!.getAttribute('role')).toBe('alert');
    expect(band!.textContent).toContain('未检测到 Python 运行时');
    // The one-line explanation names the script that fetches the runtime.
    expect(band!.textContent).toContain('scripts/fetch-python-runtime.sh');

    // The rest of the card is still there: declaration panels, editor, editable names.
    expect(host.querySelectorAll('.script-card__panel')).toHaveLength(2);
    expect(host.querySelector('.script-card__editor .cm-editor')).not.toBeNull();
    const nameInput = host.querySelector('input[aria-label="输入端口 1"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.disabled).toBe(false);
    expect(nameInput.value).toBe('A');
    // The run buttons are NOT disabled: a manual run after fixing the machine must be
    // possible — the band reports a state, it does not lock the card.
    const runButton = host.querySelector('.script-card__run') as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);

    // No silent retry: showing the state executes nothing.
    expect(client.computeNode).not.toHaveBeenCalled();
  });

  it('keeps the debug panel’s detail visible with the band', async () => {
    markRuntimeMissing(scriptCardId);
    const host = await mount(<ScriptHarness cardId={scriptCardId} />);

    const debug = host.querySelector('.script-card__debug');
    expect(debug).not.toBeNull();
    expect(debug!.textContent).toContain('未找到 Python 运行时');
    expect(debug!.textContent).toContain('no python in third_party/pyruntime');
  });

  it('shows no band while the previous run is a different failure', async () => {
    useWorkspace.setState({
      scriptRuns: {
        [scriptCardId]: {
          ...emptyScriptRun(),
          status: 'error',
          mode: 'clean',
          code: 'syntaxError',
          params: { msg: 'invalid syntax', line: 3 },
        },
      },
    });
    const host = await mount(<ScriptHarness cardId={scriptCardId} />);
    expect(host.querySelector('[data-script-runtime-missing]')).toBeNull();
  });
});

describe('the card’s environment stamp', () => {
  it('shows the pinned toolchain for a workspace that matches', async () => {
    const host = await mount(<ScriptHarness cardId={scriptCardId} />);
    const stamp = host.querySelector('.script-card__env');
    expect(stamp?.textContent).toBe('python 3.13.18 · numpy 2.5.4');
  });

  it('appends the last run’s duration without changing the versions', async () => {
    useWorkspace.setState({
      scriptRuns: {
        [scriptCardId]: {
          ...emptyScriptRun(),
          status: 'done',
          mode: 'clean',
          elapsedMs: 1234,
        },
      },
    });
    const host = await mount(<ScriptHarness cardId={scriptCardId} />);
    const stamp = host.querySelector('.script-card__env');
    expect(stamp?.textContent).toBe('python 3.13.18 · numpy 2.5.4 · 1234 ms');
  });
});
