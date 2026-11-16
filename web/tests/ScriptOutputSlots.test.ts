/**
 * Output slots beyond ordinal 0 — the generic (kind-blind) half of multi-output cards.
 *
 * The backend has always published every declared output (`extraOutputs`); what was missing
 * was the browser side: only ordinal 0 had a reader. `out:1` kept an empty local slot, a
 * chart bound to it plotted nothing, and `refreshDependentsOf` re-pointed every dependent
 * back onto `displayMatrixId` — so a second output could be declared and never fed.
 *
 * What these tests guard, all through the ordinary matrix/edge machinery (no card kind is
 * inspected anywhere):
 *   - a clean run fills the extra slot, not just the display cache;
 *   - a chart can be attached to a named output and keeps reading that slot;
 *   - a full pull is per slot (a chart on `out:1` gets the whole column);
 *   - birth binding can name an output, and two outputs of one card are two ports;
 *   - the old defaults are untouched: no output id ⇒ display slot, one port per table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace, outputMatrixId } from '../src/ui/workspaceStore.ts';
import { isScriptCard, type ChartCardModel, type FunctionCardModel } from '../src/ui/types.ts';

/**
 * The one transport instance the store creates at import time (`vi.hoisted` so the mock
 * factory can install this exact object as the constructor's result).
 */
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
/** A run awaits compute and then several window reads — three turns is the house margin. */
const flush = async () => {
  await tick();
  await tick();
  await tick();
};

/** Server matrix ids the mocked backend answers for: `out:0` and the extra output. */
const PRIMARY_MATRIX = 111;
const EXTRA_MATRIX = 222;

/**
 * The rows behind each server result matrix.
 *
 * A real window is paged (`offset`, `limit`), and the preview/full distinction is only
 * visible through it: a 150-row table served to a 100-row preview must come back cut short,
 * or "the chart pulled the whole column" would be untestable.
 */
const served = new Map<number, number[]>();

function frameOf(values: number[], totalRows: number): {
  ok: true;
  rows: number;
  columns: number;
  totalRows: number;
  totalCols: number;
  names: string[];
  data: number[][];
} {
  return {
    ok: true,
    rows: values.length,
    columns: 1,
    totalRows,
    totalCols: 1,
    names: ['Pos.1'],
    data: [values],
  };
}

function matrix(rows: number[][]): MatrixData {
  const data = new MatrixData();
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let column = 0; column < columns; ++column) {
    data.appendColumn(`Pos.${column + 1}`, rows.map((row) => row[column] ?? NaN));
  }
  return data;
}

let nextServerMatrix = 70;
let nextNodeId = 11;

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  served.clear();
  nextServerMatrix = 70;
  nextNodeId = 11;
  client.window.mockClear();

  client.registerMatrix.mockReset().mockImplementation(async () => ({
    ok: true,
    matrixId: nextServerMatrix++,
    revision: 1,
  }));
  client.createNode.mockReset().mockImplementation(async (_inputs, arg: unknown) => {
    const nodeId = nextNodeId++;
    return {
      ok: true,
      nodeId,
      resultMatrixId: 100 + nodeId,
      resultMatrixIds: [100 + nodeId],
      signatureId: typeof arg === 'string' ? arg : (arg as { signatureId: string }).signatureId,
      state: 'dirty',
      reason: 'notRequested',
    };
  });
  client.patchNode.mockReset().mockImplementation(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'dirty',
  }));
  client.computeNode.mockReset().mockImplementation(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [100 + nodeId],
  }));
  client.window.mockReset().mockImplementation(async (matrixId: number, offset: number, limit: number) => {
    const all = served.get(matrixId);
    if (!all) return { ok: false, code: 'notFound' };
    return frameOf(all.slice(offset, offset + limit), all.length);
  });
  client.deleteNode.mockReset().mockResolvedValue({ ok: true });
  client.deleteMatrix.mockReset().mockResolvedValue({ ok: true });
  client.events.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  store().reset();
});

async function loadSource(name: string, rows: number[][]): Promise<number> {
  const cardId = store().addMatrixCard([{ name, matrix: matrix(rows) }]);
  await flush();
  return cardId;
}

function scriptCardOf(cardId: number): FunctionCardModel {
  const card = store().cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) throw new Error(`card ${cardId} is not a function card`);
  return card;
}

function chartCardOf(cardId: number): ChartCardModel {
  const card = store().cards.find((entry) => entry.id === cardId);
  if (!card || card.kind !== 'chart') throw new Error(`card ${cardId} is not a chart`);
  return card;
}

/**
 * A two-output card after one clean run.
 *
 * `out:0` and the extra output carry different values on purpose: a regression that reads
 * the display slot where the extra one was asked for shows up as the wrong numbers, not as
 * an empty chart that could be blamed on timing.
 */
async function runTwoOutputCard(
  primary: number[],
  extra: number[],
): Promise<{ cardId: number; primarySlot: number; extraSlot: number }> {
  const source = await loadSource('a.csv', [[1], [2]]);
  const cardId = store().addScriptCard([source]) as number;
  expect(cardId).not.toBeNull();
  await flush();
  // Declaring the second output allocates its local slot — the thing a dependent binds to.
  expect(store().addScriptOutput(cardId)).toBe('out:1');
  await flush();

  const declared = scriptCardOf(cardId);
  expect(declared.outputs.map((output) => output.outputId)).toEqual(['out:0', 'out:1']);
  const extraSlot = declared.outputs[1].localMatrixId;
  expect(extraSlot).toBeTypeOf('number');

  served.set(PRIMARY_MATRIX, [...primary]);
  served.set(EXTRA_MATRIX, [...extra]);
  client.computeNode.mockImplementationOnce(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [PRIMARY_MATRIX],
    extraOutputs: [{ name: 'b', matrixId: EXTRA_MATRIX, rows: extra.length, cols: 1 }],
  }));
  store().runScriptCard(cardId);
  await flush();
  await flush();

  return { cardId, primarySlot: declared.displayMatrixId, extraSlot: extraSlot as number };
}

describe('output slots are filled by a run', () => {
  it('mirrors every declared output into its own slot', async () => {
    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);

    // The server ids land on the declarations…
    expect(scriptCardOf(cardId).outputs.map((output) => output.resultMatrixId)).toEqual([
      PRIMARY_MATRIX,
      EXTRA_MATRIX,
    ]);
    // …and the rows behind the extra one reach the local slot a dependent would read.
    const slotMatrix = store().matrices.get(extraSlot);
    expect(slotMatrix?.rowCount()).toBe(3);
    expect(slotMatrix?.column(0).data).toEqual([10, 20, 30]);
    // First screenful, like ordinal 0: the preview budget, not the whole table.
    const extraReads = client.window.mock.calls.filter((call) => call[0] === EXTRA_MATRIX);
    expect(extraReads.length).toBeGreaterThan(0);
    expect(extraReads.some((call) => call[1] === 0 && call[2] === 100)).toBe(true);
  });
});

describe('charts attached to a named output', () => {
  it('reads the slot the output id names, with an edge to the owning card', async () => {
    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);

    const chartId = store().addChartCard(cardId, 0, 'line', 'out:1');
    expect(chartId).not.toBeNull();
    await flush();
    const chart = chartCardOf(chartId as number);

    expect(chart.config.sources[0].matrixId).toBe(extraSlot);
    expect(chart.config.sources[0].raw).toEqual([10, 20, 30]);
    // The edge is derived from the config (one rule for every matrix id), so it names the
    // same slot the curve reads.
    expect(chart.inputs[0].target.matrixId).toBe(extraSlot);
    expect(store().dependencies.getPorts(chartId as number, cardId).length).toBeGreaterThan(0);
  });

  it('keeps the named slot when the owner refreshes its dependents', async () => {
    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);
    const chartId = store().addChartCard(cardId, 0, 'line', 'out:1') as number;
    await flush();

    // The rows change; the binding must not. This is the regression: the re-point used to
    // rewrite every dependent's matrix id to `displayMatrixId`, which moved the curve onto
    // output 0 (here: 1/2/3) without saying so.
    const refreshed = new MatrixData();
    refreshed.appendColumn('Pos.1', [70, 80, 90]);
    useWorkspace.setState((state) => {
      const matrices = new Map(state.matrices);
      matrices.set(extraSlot, refreshed);
      return { matrices };
    });
    store().refreshDependentsOf(cardId);

    const chart = chartCardOf(chartId);
    expect(chart.config.sources[0].matrixId).toBe(extraSlot);
    expect(chart.config.sources[0].raw).toEqual([70, 80, 90]);
    expect(chart.inputs[0].target.matrixId).toBe(extraSlot);
  });
});

describe('full pull is per slot', () => {
  it('gives a chart bound to the extra output the whole column', async () => {
    const whole = Array.from({ length: 150 }, (_, index) => index + 1);
    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], whole);

    // The clean run mirrors the preview only…
    expect(store().matrices.get(extraSlot)?.rowCount()).toBe(100);
    client.window.mockClear();

    const chartId = store().addChartCard(cardId, 0, 'line', 'out:1');
    expect(chartId).not.toBeNull();
    await flush();

    // …and opening a chart on that slot pulls the rest. `MAX_CACHE_ROWS` is paged through
    // `WINDOW_ROWS` (5000), so the full-budget page — not the 100-row preview — is the
    // observable difference.
    expect(client.window).toHaveBeenCalledWith(EXTRA_MATRIX, 0, 5000);
    expect(store().matrices.get(extraSlot)?.rowCount()).toBe(150);
    // The freshly pulled rows reached the curve, not just the cache.
    expect(chartCardOf(chartId as number).config.sources[0].raw.length).toBe(150);
  });
});

/**
 * A result the display cache cannot hold in full: 250 000 rows against the 200 000-row cap.
 *
 * `shownRows` can never reach `totalRows` there, so a slot that answered "complete" only on
 * equality stayed incomplete forever: the refresh after every pull asked for the slot again,
 * pulled the same capped table again, and refreshed again. The evidence of that loop is the
 * number of window reads, not the shape of any matrix — hence the assertion below.
 */
describe('a result taller than the cache cap', () => {
  it('stops pulling once the cache cap is reached', async () => {
    // Served as synthetic pages: the whole table is never in memory on either side, which is
    // also why `frameOf` cannot be handed 250 000 values here.
    const totalRows = 250_000;
    client.window.mockImplementation(async (matrixId: number, offset: number, limit: number) => {
      if (matrixId !== EXTRA_MATRIX) {
        const all = served.get(matrixId);
        if (!all) return { ok: false, code: 'notFound' };
        return frameOf(all.slice(offset, offset + limit), all.length);
      }
      const rows = Math.max(0, Math.min(limit, 5000, totalRows - offset));
      return frameOf(
        Array.from({ length: rows }, (_, index) => offset + index + 1),
        totalRows,
      );
    });

    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);
    // The clean run mirrored the first screenful and hit no cap: 100 of 250 000 rows.
    expect(store().matrices.get(extraSlot)?.rowCount()).toBe(100);

    // A chart on that slot asks for the whole column, so the store pulls up to its cap…
    const chartId = store().addChartCard(cardId, 0, 'line', 'out:1');
    expect(chartId).not.toBeNull();
    await flush();
    await flush();
    // The capped pull has landed before counting starts, so every read counted below would
    // be a re-pull rather than the first one still paging.
    expect(store().matrices.get(extraSlot)?.rowCount()).toBeGreaterThan(100);

    // …and the question is whether it stops there. A pull that leaves the slot incomplete
    // restarts on the very next refresh, so "no new read arrives" is the property to hold:
    // a timeout would only prove the loop was slow, not that it ended.
    const settled = client.window.mock.calls.length;
    for (let index = 0; index < 20; index += 1) await tick();
    expect(client.window.mock.calls.length).toBe(settled);

    // What landed is the capped table — past the preview, short of the whole result.
    const slot = store().matrices.get(extraSlot);
    expect(slot).toBeDefined();
    expect(slot?.rowCount()).toBeGreaterThan(100);
    expect(slot?.rowCount()).toBeLessThanOrEqual(200_000);
  });
});

describe('birth binding can name an output', () => {
  it('wires a port to the output the caller named', async () => {
    const { cardId, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);

    const chainedId = store().addScriptCard([{ cardId, outputId: 'out:1' }]);
    expect(chainedId).not.toBeNull();
    await flush();
    const chained = scriptCardOf(chainedId as number);

    expect(chained.inputs[0].target.matrixId).toBe(extraSlot);
    expect(chained.inputs[0].portId).toBe('in:0');
    expect(chained.params.portNames).toEqual(['A']);
    // The binding resolves to the server copy of THAT slot, like any other matrix.
    const create = client.createNode.mock.calls.at(-1) as unknown as [
      Array<{ sourceMatrixId: number }>,
    ];
    expect(create[0][0].sourceMatrixId).toBe(EXTRA_MATRIX);
  });

  it('skips an output the card does not declare', async () => {
    const { cardId } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);
    expect(store().addScriptCard([{ cardId, outputId: 'out:9' }])).toBeNull();
  });
});

describe('the single-output defaults are untouched', () => {
  it('still collapses a repeated card into one port', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = store().addScriptCard([source, source]) as number;
    await flush();
    const card = scriptCardOf(cardId);

    expect(card.inputs).toHaveLength(1);
    expect(card.params.portNames).toEqual(['A']);
  });

  it('still reads the display slot when no output is named', async () => {
    const { cardId, primarySlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);
    const chartId = store().addChartCard(cardId, 0, 'line') as number;
    await flush();

    const chart = chartCardOf(chartId);
    expect(chart.config.sources[0].matrixId).toBe(primarySlot);
    expect(chart.config.sources[0].raw).toEqual([1, 2, 3]);
  });
});

describe('outputMatrixId', () => {
  it('resolves ordinal 0, an extra output, and an id nobody declares', async () => {
    const { cardId, primarySlot, extraSlot } = await runTwoOutputCard([1, 2, 3], [10, 20, 30]);
    const card = scriptCardOf(cardId);

    expect(outputMatrixId(card, 'out:0')).toBe(primarySlot);
    expect(outputMatrixId(card, 'out:1')).toBe(extraSlot);
    expect(outputMatrixId(card, 'out:9')).toBeNull();
  });
});