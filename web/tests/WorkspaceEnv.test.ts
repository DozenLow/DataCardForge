/**
 * Workspace environment lock — the top-level `env` block of a save file.
 *
 * Three rules are pinned here, all of them about NOT lying to the user:
 *
 *   - a save always carries the stamp (scripts or not), and reading it back returns the same
 *     field values — the block is data, not a decoration on the JSON;
 *   - a workspace written before the lock existed gets the pinned stamp silently (nothing to
 *     ask), while a workspace that already HAS one keeps it verbatim — a difference from this
 *     machine is reported in the UI (`env.mismatch`), never repaired behind the user's back;
 *   - loading a workspace never executes a script, and acknowledging the mismatch banner
 *     neither changes the stamp nor starts a run.
 *
 * The transport is mocked at the client seam for the same reason the other store suites do
 * it: the tests are about the file/stamp plumbing, not about HTTP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { migrateWorkspace, readWorkspaceEnv } from '../src/ui/migrate.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  PINNED_WORKSPACE_ENV,
  isScriptCard,
  workspaceEnvIsPinned,
  type WorkspaceEnv,
  type WorkspaceSnapshot,
} from '../src/ui/types.ts';

const client = vi.hoisted(() => ({
  hello: vi.fn(),
  signatures: vi.fn(),
  registerMatrix: vi.fn(),
  patchCells: vi.fn(),
  deleteMatrix: vi.fn(),
  createNode: vi.fn(),
  patchNode: vi.fn(),
  deleteNode: vi.fn(),
  getNode: vi.fn(),
  computeNode: vi.fn(),
  checkAccuracy: vi.fn(),
  listNodes: vi.fn(),
  nodeResult: vi.fn(),
  events: vi.fn(),
  window: vi.fn(),
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

const store = () => useWorkspace.getState();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  await tick();
  await tick();
  await tick();
};

/**
 * The v1 stamp, spelled out independently of `PINNED_WORKSPACE_ENV`.
 *
 * A test that compared the save file against the same constant it was built from would pass
 * even if both drifted to a wrong value; these literals are the ones
 * `scripts/fetch-python-runtime.sh` pins.
 */
const EXPECTED_ENV = {
  python: '3.13.18',
  packages: [
    {
      name: 'numpy',
      version: '2.5.4',
      platform: 'cp313-manylinux_2_27_x86_64',
      sha256: '6ffa07666f8da0eef81d149934a626d0d95fbd6838432a33e66245423a9062c0',
    },
  ],
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

function matrix(rows: number[][]): MatrixData {
  const data = new MatrixData();
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let column = 0; column < columns; ++column) {
    data.appendColumn(`Pos.${column + 1}`, rows.map((row) => row[column] ?? NaN));
  }
  return data;
}

function emptySnapshot(env?: WorkspaceEnv): WorkspaceSnapshot {
  return {
    version: 2,
    savedAt: '2026-11-20T00:00:00.000Z',
    ...(env ? { env } : {}),
    cards: [],
    matrices: [],
    nextCardId: 1,
    nextMatrixId: 1,
  };
}

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  client.hello.mockReset().mockResolvedValue({ ok: true });
  client.signatures.mockReset().mockResolvedValue([]);
  client.registerMatrix
    .mockReset()
    .mockResolvedValue({ ok: true, matrixId: 70, revision: 1 });
  client.patchCells.mockReset().mockResolvedValue({ ok: true });
  client.deleteMatrix.mockReset().mockResolvedValue({ ok: true });
  client.createNode.mockReset().mockImplementation(async (_inputs: unknown, arg: unknown) => ({
    ok: true,
    nodeId: 11,
    resultMatrixId: 111,
    resultMatrixIds: [111],
    signatureId: (arg as { signatureId: string }).signatureId,
    state: 'dirty',
  }));
  client.patchNode
    .mockReset()
    .mockImplementation(async (nodeId: number) => ({ ok: true, nodeId, state: 'dirty' }));
  client.deleteNode.mockReset().mockResolvedValue({ ok: true });
  client.getNode.mockReset().mockResolvedValue(null);
  client.computeNode.mockReset().mockImplementation(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [111],
  }));
  client.checkAccuracy.mockReset().mockResolvedValue({});
  client.listNodes.mockReset().mockResolvedValue([]);
  client.nodeResult.mockReset().mockResolvedValue({ ok: false });
  client.events.mockReset().mockResolvedValue([]);
  client.window.mockReset().mockResolvedValue({
    ok: true,
    rows: 0,
    columns: 0,
    totalRows: 0,
    totalCols: 0,
    names: [],
    data: [],
  });
});

describe('env block on save and load', () => {
  it('writes the pinned stamp and reads every field back unchanged', async () => {
    const sourceId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([[1], [2]]) }]);
    const cardId = store().addScriptCard([sourceId]);
    expect(cardId).not.toBeNull();
    await flush();

    const saved = store().toSnapshot();
    // Field by field against the literals `scripts/fetch-python-runtime.sh` pins.
    expect(saved.env?.python).toBe(EXPECTED_ENV.python);
    expect(saved.env?.packages).toHaveLength(1);
    expect(saved.env?.packages[0].name).toBe(EXPECTED_ENV.packages[0].name);
    expect(saved.env?.packages[0].version).toBe(EXPECTED_ENV.packages[0].version);
    expect(saved.env?.packages[0].platform).toBe(EXPECTED_ENV.packages[0].platform);
    expect(saved.env?.packages[0].sha256).toBe(EXPECTED_ENV.packages[0].sha256);

    // JSON is the real transport: nothing may be lost to serialisation.
    const parsed = JSON.parse(JSON.stringify(saved)) as WorkspaceSnapshot;
    expect(parsed.env).toEqual(EXPECTED_ENV);

    store().reset();
    store().loadSnapshot(parsed);
    await flush();

    expect(store().workspaceEnv.python).toBe(EXPECTED_ENV.python);
    expect(store().workspaceEnv.packages).toHaveLength(1);
    expect(store().workspaceEnv.packages[0]).toEqual(EXPECTED_ENV.packages[0]);
    expect(workspaceEnvIsPinned(store().workspaceEnv)).toBe(true);
  });

  it('writes the stamp even when the workspace holds no script card', () => {
    // An empty workspace carries the block too: "always write it" is what keeps the schema
    // independent of the card mix.
    expect(store().toSnapshot().env).toEqual(EXPECTED_ENV);
    store().addMatrixCard([{ name: 'a.csv', matrix: matrix([[1]]) }]);
    const saved = store().toSnapshot();
    expect(saved.env).toEqual(EXPECTED_ENV);
    expect(saved.cards.some(isScriptCard)).toBe(false);
  });

  it('fills in the stamp for a workspace saved before the lock existed', () => {
    const v2 = migrateWorkspace({
      version: 2,
      savedAt: '2026-10-01T00:00:00.000Z',
      cards: [],
      matrices: [],
      nextCardId: 1,
      nextMatrixId: 1,
    });
    expect(v2.env).toEqual(EXPECTED_ENV);

    const v1 = migrateWorkspace({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', cards: [], matrices: [] });
    expect(v1.env).toEqual(EXPECTED_ENV);
  });

  it('never rewrites a stamp that disagrees with this machine', () => {
    const migrated = migrateWorkspace({
      ...emptySnapshot(),
      env: FOREIGN_ENV,
    });
    expect(migrated.env).toEqual(FOREIGN_ENV);
    expect(migrated.env?.python).toBe('3.12.4');
    expect(workspaceEnvIsPinned(migrated.env!)).toBe(false);

    store().loadSnapshot(migrated);
    expect(store().workspaceEnv).toEqual(FOREIGN_ENV);
    // Saving it back keeps the file's own stamp: the mismatch is information, not a defect.
    expect(store().toSnapshot().env).toEqual(FOREIGN_ENV);
  });

  it('treats a block that cannot describe an environment as absent', () => {
    expect(readWorkspaceEnv(undefined)).toBeNull();
    expect(readWorkspaceEnv('3.13.18')).toBeNull();
    expect(readWorkspaceEnv({ packages: [] })).toBeNull();
    expect(readWorkspaceEnv({ python: '' })).toBeNull();
    // Entries without a name are dropped; the rest is read verbatim.
    expect(readWorkspaceEnv({ python: '3.13.18', packages: [{ version: '2.5.4' }] })).toEqual({
      python: '3.13.18',
      packages: [],
    });
    const migrated = migrateWorkspace({ ...emptySnapshot(), env: { packages: [] } });
    expect(migrated.env).toEqual(EXPECTED_ENV);
  });
});

describe('mismatch noticing', () => {
  /** A mismatched workspace that also holds one script card. */
  async function foreignWorkspaceWithScript(): Promise<WorkspaceSnapshot> {
    const sourceId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([[1], [2]]) }]);
    store().addScriptCard([sourceId]);
    await flush();
    return { ...store().toSnapshot(), env: FOREIGN_ENV };
  }

  it('keeps the mismatch until acknowledged, and acknowledging runs nothing', async () => {
    const snapshot = await foreignWorkspaceWithScript();
    store().reset();
    store().loadSnapshot(snapshot);
    await flush();

    expect(store().workspaceEnv.python).toBe('3.12.4');
    expect(store().envMismatchAcknowledged).toBe(false);
    // Loading a workspace is not a run: nothing was computed, in either mode.
    expect(client.computeNode).not.toHaveBeenCalled();

    store().acknowledgeEnvMismatch();
    expect(store().envMismatchAcknowledged).toBe(true);
    await flush();
    expect(client.computeNode).not.toHaveBeenCalled();
    // The stamp still describes the machine the file came from.
    expect(store().workspaceEnv).toEqual(FOREIGN_ENV);
  });

  it('reports a mismatch again after another workspace is loaded', async () => {
    store().loadSnapshot({ ...emptySnapshot(FOREIGN_ENV) });
    store().acknowledgeEnvMismatch();
    expect(store().envMismatchAcknowledged).toBe(true);

    store().loadSnapshot({ ...emptySnapshot(FOREIGN_ENV) });
    // "Acknowledged" is session state about ONE load, not a saved preference.
    expect(store().envMismatchAcknowledged).toBe(false);
  });
});

describe('script notice', () => {
  async function workspaceWithScripts(count: number): Promise<WorkspaceSnapshot> {
    const sourceId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([[1], [2]]) }]);
    for (let index = 0; index < count; ++index) store().addScriptCard([sourceId]);
    await flush();
    return store().toSnapshot();
  }

  it('counts the script cards of the loaded workspace, once per load', async () => {
    const snapshot = await workspaceWithScripts(2);
    const scriptCards = snapshot.cards.filter(isScriptCard);
    expect(scriptCards).toHaveLength(2);

    store().reset();
    store().loadSnapshot(snapshot);
    await flush();
    expect(store().scriptNotice).toBe(2);
    // A count of cards, not of runs: nothing was executed to produce it.
    expect(client.computeNode).not.toHaveBeenCalled();

    store().dismissScriptNotice();
    expect(store().scriptNotice).toBeNull();

    // A later load is a later load: the sentence returns, exactly once.
    store().reset();
    store().loadSnapshot(snapshot);
    await flush();
    expect(store().scriptNotice).toBe(2);
  });

  it('stays silent for a workspace without scripts', () => {
    store().loadSnapshot(emptySnapshot());
    expect(store().scriptNotice).toBeNull();
  });

  it('forgets the notice when the workspace is closed or reset', async () => {
    const snapshot = await workspaceWithScripts(1);
    store().reset();
    store().loadSnapshot(snapshot);
    await flush();
    expect(store().scriptNotice).toBe(1);

    store().closeAllCards();
    await flush();
    // The sentence counted cards that no longer exist.
    expect(store().scriptNotice).toBeNull();
    expect(store().cards).toHaveLength(0);
  });
});

describe('the pinned constant', () => {
  it('is the single table both the save file and the card stamp read', () => {
    // The workspaceStore derives its display stamp from this object; keeping the literal
    // asserted here means a drift is a failing test rather than a silently wrong label.
    expect(PINNED_WORKSPACE_ENV.python).toBe(EXPECTED_ENV.python);
    expect(PINNED_WORKSPACE_ENV.packages).toEqual(EXPECTED_ENV.packages);
  });
});