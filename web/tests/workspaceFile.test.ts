import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { readWorkspace, serializeWorkspace } from '../src/ui/fileActions.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';

const store = useWorkspace.getState;
const registerMatrixWithBackend = store().registerMatrixWithBackend;

async function reopen(text = serializeWorkspace(store().toSnapshot())) {
  const file = new File([text], 'workspace.json', { type: 'application/json' });
  const { snapshot, hash } = await readWorkspace(file);
  expect(hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  store().reset();
  store().loadSnapshot(snapshot);
}

function addTable(data: number[], categories?: string[]) {
  const table = new MatrixData();
  table.appendColumn('Pos.1', data);
  if (categories) table.setColumnCategories(0, categories);
  store().addMatrixCard([{ name: '数据.csv', matrix: table }]);
}

function reopenedTable() {
  const [table] = store().matrices.values();
  return table;
}

describe('workspace file save and reopen', () => {
  beforeEach(() => {
    store().reset();
    useWorkspace.setState({ registerMatrixWithBackend: vi.fn().mockResolvedValue(null) });
  });

  afterEach(() => {
    store().reset();
    useWorkspace.setState({ registerMatrixWithBackend });
  });

  it('preserves categorical labels at their original codes', async () => {
    addTable([1, 0, 1], ['对照', '处理']);
    await reopen();
    expect(reopenedTable().column(0).data).toEqual([1, 0, 1]);
    expect(reopenedTable().categoricalLabel(0, 0)).toBe('处理');
    expect(reopenedTable().categoricalLabel(1, 0)).toBe('对照');
  });

  it('distinguishes positive and negative infinity from missing cells', async () => {
    addTable([NaN, Infinity, -Infinity, 0, 1.5]);
    await reopen();
    expect(reopenedTable().column(0).data).toEqual([NaN, Infinity, -Infinity, 0, 1.5]);
  });

  it('continues reading null cells as missing in older v2 files', async () => {
    addTable([NaN, 0, 1.5]);
    await reopen(JSON.stringify(store().toSnapshot()));
    expect(reopenedTable().column(0).data).toEqual([NaN, 0, 1.5]);
  });

  it.each(['matrix sources', 'chart config', 'formula outputs', 'unknown kind'])(
    'rejects malformed v2 %s without replacing the active workspace',
    async (defect) => {
      addTable([1, 2]);
      const sourceId = store().cards[0].id;
      const chartId = store().addChartCard(sourceId, 0)!;
      const formulaId = store().addFormulaCard(sourceId)!;
      const before = store();
      const snapshot = before.toSnapshot();
      const card = (id: number) => snapshot.cards.find((entry) => entry.id === id)!;
      switch (defect) {
        case 'matrix sources': Reflect.deleteProperty(card(sourceId), 'sources'); break;
        case 'chart config': Reflect.deleteProperty(card(chartId), 'config'); break;
        case 'formula outputs': Reflect.deleteProperty(card(formulaId), 'outputs'); break;
        case 'unknown kind': Reflect.set(card(sourceId), 'kind', 'unknown'); break;
      }
      const file = new File([serializeWorkspace(snapshot)], 'malformed.json');
      await expect(readWorkspace(file)).rejects.toMatchObject({ name: 'WorkspaceFormatError' });
      expect(() => before.loadSnapshot(snapshot)).toThrow('Invalid workspace card');
      expect(store().cards).toBe(before.cards);
      expect(store().matrices).toBe(before.matrices);
      expect(store().dependencies).toBe(before.dependencies);
    },
  );

  it('restores saved workspace unit confirmations, policy, and constants', async () => {
    const units = {
      unitConfirmations: { 'load [kg]': { 0: 'kg' } },
      unitPolicyOverride: 'strict' as const,
      unitConstants: { 'scale-token': { dimension: 'mass', factor: 5 } },
    };
    useWorkspace.setState(units);
    await reopen();
    expect(store()).toMatchObject(units);
  });
});
