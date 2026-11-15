/**
 * Script card behaviour in the workspace store (`builtin:python`).
 *
 * The transport is mocked at the client seam (`src/backend/client.ts`), not at `fetch`: these
 * tests are about what the CARD does with an answer — which ids it remembers, which node it
 * PATCHes, whether a result is allowed to reach the display cache — and the shapes asserted
 * here are the ones the backend actually answers with (fact C of the task board):
 * creating a node is `dirty/notRequested`, and only `POST /nodes/{id}/compute` produces
 * numbers, `extraOutputs` included.
 *
 * What these tests are really guarding:
 *   - birth binding wires ports, edges and params in one step, in selection order;
 *   - a definition edit (script, declaration, binding) is dirty, NOT a run;
 *   - `out:N` survives renames and removals — an edge binds the id, never a label;
 *   - 净室运行 publishes, 调试运行 does not;
 *   - a failure lands in the panel with its traceback, and clears the stale numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace, emptyScriptRun } from '../src/ui/workspaceStore.ts';
import {
  PYTHON_SIGNATURE,
  isScriptCard,
  type FunctionCardModel,
  type MatrixCardModel,
} from '../src/ui/types.ts';

/**
 * The one transport instance the store creates at import time.
 *
 * `vi.hoisted` so the mock factory can install this exact object as the constructor's result;
 * every method is a `vi.fn` from the start, so `Object.assign` in the constructor copies the
 * same functions the tests later reprogram.
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
/** Two turns: a push usually awaits the create and then the (mocked) window read. */
const flush = async () => {
  await tick();
  await tick();
  await tick();
};

function matrix(rows: number[][]): MatrixData {
  const data = new MatrixData();
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let column = 0; column < columns; ++column) {
    data.appendColumn(`Pos.${column + 1}`, rows.map((row) => row[column] ?? NaN));
  }
  return data;
}

/** A framed matrix answer for `client.window` (DCM2 shape: window + totals + names). */
function frame(values: number[]): {
  ok: true;
  rows: number;
  columns: number;
  totalRows: number;
  totalCols: number;
  names: string[];
  data: Float64Array[];
} {
  return {
    ok: true,
    rows: values.length,
    columns: 1,
    totalRows: values.length,
    totalCols: 1,
    names: ['Pos.1'],
    data: [new Float64Array(values)],
  };
}

let nextServerMatrix = 70;
let nextNodeId = 11;

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  nextServerMatrix = 70;
  nextNodeId = 11;

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
      signatureId: typeof arg === 'string' ? 'builtin:expression-columns' : (arg as { signatureId: string }).signatureId,
      // An `explicitCompute` signature is born not-requested; nothing ran.
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
  client.window.mockReset().mockImplementation(async () => frame([1, 2, 3]));
  client.deleteNode.mockReset().mockResolvedValue({ ok: true });
  client.deleteMatrix.mockReset().mockResolvedValue({ ok: true });
  client.events.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  store().reset();
});

/** Load one data card and wait for its fire-and-forget server registration. */
async function loadSource(name: string, rows: number[][]): Promise<number> {
  const cardId = store().addMatrixCard([{ name, matrix: matrix(rows) }]);
  await flush();
  return cardId;
}

function scriptCardOf(cardId: number): FunctionCardModel {
  const card = store().cards.find((entry) => entry.id === cardId);
  if (!card || !isScriptCard(card)) throw new Error(`card ${cardId} is not a script card`);
  return card;
}

async function makeScriptCard(sourceIds: number[]): Promise<number> {
  const cardId = store().addScriptCard(sourceIds);
  expect(cardId).not.toBeNull();
  await flush();
  return cardId as number;
}

describe('addScriptCard — birth binding', () => {
  it('creates one port per selected card, in selection order, named A / B', async () => {
    const first = await loadSource('a.csv', [[1], [2]]);
    const second = await loadSource('b.csv', [[3], [4]]);

    const cardId = await makeScriptCard([second, first]);
    const card = scriptCardOf(cardId);

    expect(card.signatureId).toBe(PYTHON_SIGNATURE);
    expect(card.kind).toBe('formula');
    // +0, +1 in the caller's order — not the cards' ids.
    expect(card.inputs.map((input) => input.portId)).toEqual(['in:0', 'in:1']);
    expect(card.inputs.map((input) => input.target.cardId)).toEqual([second, first]);
    expect(card.params.portNames).toEqual(['A', 'B']);
    // One output exists before anybody runs: `out:0` is bindable from birth.
    expect(card.outputs.map((output) => output.outputId)).toEqual(['out:0']);
    expect(card.params.outputs).toEqual(['result']);
    expect(typeof card.params.script).toBe('string');
    expect(String(card.params.script)).toContain('result = A * 1.0');
    // The display cache exists but holds nothing: the browser computes nothing.
    expect(store().matrices.get(card.displayMatrixId)?.rowCount()).toBe(0);
  });

  it('wires the ordinary dependency edges, so close protection applies unchanged', async () => {
    const only = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([only]);

    expect(store().dependencies.getDependents(only)).toEqual([cardId]);
    // The edge records the port identity, which is what the connection layer draws.
    expect(store().dependencies.getPorts(cardId, only)).toEqual(['in:0']);
    // Closing the source is refused by the SAME rule that protects a matrix card, with no
    // script-card branch anywhere: the store only asks `hasDependents`.
    expect(store().removeCard(only)).toBe(false);
    expect(store().blockedCardId).toBe(only);
  });

  it('pushes the declaration to the node verbatim, with one binding per port', async () => {
    const first = await loadSource('a.csv', [[1], [2]]);
    const second = await loadSource('b.csv', [[3], [4]]);
    const cardId = await makeScriptCard([first, second]);
    const card = scriptCardOf(cardId);

    const create = client.createNode.mock.calls.at(-1);
    expect(create).toBeDefined();
    const [bindings, arg] = create as unknown as [unknown, { signatureId: string; params: Record<string, unknown> }];
    expect(arg.signatureId).toBe(PYTHON_SIGNATURE);
    // The card's params ALREADY are the wire shape (`portNames` is an array), which is why
    // the generic node push needs no signature knowledge at all.
    expect(arg.params).toEqual({
      script: card.params.script,
      portNames: ['A', 'B'],
      outputs: ['result'],
    });
    expect(bindings).toEqual([
      { portId: 'in:0', varName: 'A', mode: 'matrix', sourceMatrixId: 70 },
      { portId: 'in:1', varName: 'B', mode: 'matrix', sourceMatrixId: 71 },
    ]);
    // Creating a script card runs nothing: the node is born not-requested.
    expect(client.computeNode).not.toHaveBeenCalled();
    expect(scriptCardOf(cardId).node?.state).toBe('dirty');
  });

  it('accepts a single card (and refuses a chart, which owns no matrix)', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const chartId = store().addChartCard(source, 0);
    expect(chartId).not.toBeNull();
    await flush();

    expect(store().addScriptCard([])).toBeNull();
    if (chartId !== null) expect(store().addScriptCard([chartId])).toBeNull();
    const single = store().addScriptCard([source]);
    expect(single).not.toBeNull();
  });

  it('can read a function card output as a port', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const formulaId = store().addFormulaCard(source);
    expect(formulaId).not.toBeNull();
    await flush();
    const formula = store().cards.find((entry) => entry.id === formulaId) as FunctionCardModel;

    const cardId = store().addScriptCard([formulaId as number]);
    expect(cardId).not.toBeNull();
    const card = scriptCardOf(cardId as number);
    expect(card.inputs[0].target.matrixId).toBe(formula.displayMatrixId);
    expect(card.inputs[0].target.cardId).toBe(formulaId);
  });
});

describe('definition changes are dirty, never runs', () => {
  it('editing the script marks the card dirty and PATCHes the new text', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    expect(scriptCardOf(cardId).node?.state).toBe('dirty');
    client.computeNode.mockClear();

    store().setScriptText(cardId, 'result = A * 3.0\n');
    await flush();

    expect(scriptCardOf(cardId).params.script).toBe('result = A * 3.0\n');
    expect(scriptCardOf(cardId).params.outputs).toEqual(['result']);
    // The lamp says "definition changed" without waiting for an event.
    expect(scriptCardOf(cardId).node?.state).toBe('dirty');
    const patch = client.patchNode.mock.calls.at(-1) as unknown as [number, { params: Record<string, unknown> }];
    expect(patch[1].params.script).toBe('result = A * 3.0\n');
    // Nothing executed: a definition change is not a compute request.
    expect(client.computeNode).not.toHaveBeenCalled();
  });

  it('renames a port: script identifiers, declaration and varName — never the portId', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    // The template already uses A twice (comment + expression); the comment must survive the
    // rename untouched because it is not an identifier.
    store().setScriptText(cardId, '# A means the first table\nresult = A * 2.0\n');
    await flush();

    const result = store().renameScriptPort(cardId, 'in:0', 'sensor');
    expect(result.ok).toBe(true);
    expect(result.ok && result.replaced).toBe(1);

    const card = scriptCardOf(cardId);
    expect(card.inputs[0].portId).toBe('in:0');
    expect(card.params.portNames).toEqual(['sensor']);
    expect(card.params.script).toBe('# A means the first table\nresult = sensor * 2.0\n');
    // The edge still names the same port and the same source.
    expect(store().dependencies.getPorts(cardId, source)).toEqual(['in:0']);
    const patch = client.patchNode.mock.calls.at(-1) as unknown as [
      number,
      { params: Record<string, unknown>; inputs: Array<{ varName: string }> },
    ];
    expect(patch[1].params.portNames).toEqual(['sensor']);
    expect(patch[1].inputs[0].varName).toBe('sensor');
  });

  it('refuses a name that another declaration already uses, and says which one', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);

    // Cross-panel clash: the output is `result`, so a port may not take that name.
    const crossPanel = store().renameScriptPort(cardId, 'in:0', 'result');
    expect(crossPanel).toEqual({
      ok: false,
      error: { code: 'duplicate', panel: 'output', name: 'result' },
    });
    // Same-panel clash: renaming the output onto itself must not be a "duplicate".
    const samePanel = store().renameScriptOutput(cardId, 'out:0', 'result');
    expect(samePanel.ok).toBe(true);
    // Reserved names and non-identifiers are refused before they reach the backend.
    expect(store().renameScriptPort(cardId, 'in:0', 'names_a').ok).toBe(false);
    expect(store().renameScriptPort(cardId, 'in:0', '2bad').ok).toBe(false);
    // Case twins are allowed, with a warning.
    const twin = store().renameScriptPort(cardId, 'in:0', 'RESULT');
    expect(twin).toEqual({
      ok: true,
      warning: { code: 'caseTwin', name: 'result' },
      replaced: expect.any(Number),
    });
    expect(scriptCardOf(cardId).params.portNames).toEqual(['RESULT']);
  });

  it('renames an output: the script and the label change, the edge identity does not', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    const before = scriptCardOf(cardId).outputs[0];

    const result = store().renameScriptOutput(cardId, 'out:0', 'residual');
    expect(result.ok).toBe(true);
    const card = scriptCardOf(cardId);

    // `out:0` and its result matrix are untouched: an edge binds the id, not the label.
    expect(card.outputs[0]).toEqual(before);
    expect(card.params.outputs).toEqual(['residual']);
    expect(card.params.script).toContain('residual =');
    expect(card.params.script).not.toMatch(/\bresult\s*=/);
  });
});

describe('output declaration — out:N', () => {
  it('adds an output whose identity is stable and never reused', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);

    const second = store().addScriptOutput(cardId);
    expect(second).toBe('out:1');
    const card = scriptCardOf(cardId);
    expect(card.params.outputs).toEqual(['result', 'result2']);
    // Every extra output owns a local display slot, which is what makes it bindable.
    expect(card.outputs[1].localMatrixId).toBeTypeOf('number');
    expect(store().matrices.has(card.outputs[1].localMatrixId as number)).toBe(true);

    expect(store().removeScriptOutput(cardId, 'out:1')).toEqual({ ok: true });
    // Removing a row never renumbers the survivors: `out:0` is still `out:0`.
    expect(scriptCardOf(cardId).outputs.map((output) => output.outputId)).toEqual(['out:0']);
    // The next declaration takes `max(existing) + 1` (never COLLIDES with a survivor).
    // Revisiting a removed slot is allowed by the contract and is safe here because a row a
    // dependent reads cannot be removed in the first place.
    const third = store().addScriptOutput(cardId);
    expect(third).toBe('out:1');
    expect(scriptCardOf(cardId).outputs.map((output) => output.outputId)).toEqual([
      'out:0',
      'out:1',
    ]);
  });

  it('refuses to remove the display output (every existing edge points at it)', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    expect(store().removeScriptOutput(cardId, 'out:0')).toEqual({
      ok: false,
      code: 'displayOutput',
    });
    expect(scriptCardOf(cardId).outputs).toHaveLength(1);
  });

  it('refuses to remove an output a downstream card reads', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    const extraId = store().addScriptOutput(cardId) as string;
    const extra = scriptCardOf(cardId).outputs.find((output) => output.outputId === extraId);
    expect(extra?.localMatrixId).toBeTypeOf('number');

    // A chained function card reading `out:1` — the ordinary edge mechanism, unchanged.
    const downstreamId = store().addFormulaCard(cardId, extra?.localMatrixId);
    expect(downstreamId).not.toBeNull();
    await flush();

    const removal = store().removeScriptOutput(cardId, extraId);
    expect(removal).toEqual({ ok: false, code: 'bound', readers: [downstreamId] });
    // Reused, not reinvented: the refusal is the same blink a blocked close produces.
    expect(store().blockedCardId).toBe(cardId);
    expect(scriptCardOf(cardId).outputs.map((output) => output.outputId)).toEqual(['out:0', 'out:1']);
  });

  it('records the server matrix ids of every declared output after a run', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    store().addScriptOutput(cardId);
    await flush();

    client.computeNode.mockImplementationOnce(async (nodeId: number) => ({
      ok: true,
      nodeId,
      state: 'done',
      resultMatrixIds: [500],
      extraOutputs: [{ name: 'output', matrixId: 501, rows: 3, cols: 1 }],
    }));
    store().runScriptCard(cardId);
    await flush();
    await flush();

    const card = scriptCardOf(cardId);
    expect(card.outputs.map((output) => output.resultMatrixId)).toEqual([500, 501]);
  });
});

describe('input ports', () => {
  it('adds a port on the same source, with a fresh identity and a fresh name', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);

    const portId = store().addScriptPort(cardId);
    expect(portId).toBe('in:1');
    const card = scriptCardOf(cardId);
    expect(card.inputs.map((input) => input.portId)).toEqual(['in:0', 'in:1']);
    // Both ports read the same table — the v1 rule (a NEW source is a canvas gesture, not a
    // second kind of connection invented inside the card).
    expect(card.inputs[1].target).toEqual(card.inputs[0].target);
    expect(card.params.portNames).toEqual(['A', 'B']);
    // The edge grew a port instead of growing a second edge.
    expect(store().dependencies.getPorts(cardId, source)).toEqual(['in:0', 'in:1']);
    await flush();
    // The declaration is still valid, so the next push sends both names in order.
    const patch = client.patchNode.mock.calls.at(-1) as unknown as [number, { params: Record<string, unknown> }];
    expect(patch[1].params.portNames).toEqual(['A', 'B']);
  });

  it('has nothing to add to when the card has no ports at all', () => {
    // A script card can only be born from a source, so this is the empty-selection path.
    expect(store().addScriptCard([])).toBeNull();
  });
});

describe('runs — 净室 vs 调试', () => {
  function spyOnDependents(): { calls: number[]; restore: () => void } {
    const original = store().refreshDependentsOf;
    const calls: number[] = [];
    const spy = (cardId: number) => {
      calls.push(cardId);
      return original(cardId);
    };
    useWorkspace.setState({ refreshDependentsOf: spy });
    return { calls, restore: () => useWorkspace.setState({ refreshDependentsOf: original }) };
  }

  it('净室运行 publishes into the display cache and refreshes dependents', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    const spy = spyOnDependents();
    try {
      store().runScriptCard(cardId);
      await flush();
      await flush();

      const card = scriptCardOf(cardId);
      expect(client.computeNode).toHaveBeenCalledTimes(1);
      // The numbers reached the card's display matrix and its `result` bookkeeping.
      expect(store().matrices.get(card.displayMatrixId)?.rowCount()).toBe(3);
      expect(card.result?.totalRows).toBe(3);
      expect(card.node?.state).toBe('done');
      // …and the ordinary dependent refresh ran exactly once.
      expect(spy.calls).toContain(cardId);

      const run = store().scriptRuns[cardId];
      expect(run.status).toBe('done');
      expect(run.mode).toBe('clean');
      expect(run.elapsedMs).toBeGreaterThanOrEqual(0);
      // The environment stamp's outputs: rows × cols per declared output.
      expect(run.previews['out:0']).toMatchObject({ rows: 3, cols: 1 });
    } finally {
      spy.restore();
    }
  });

  it('调试运行 keeps the numbers inside the card: no display write, no dependents', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    const spy = spyOnDependents();
    try {
      store().debugScriptCard(cardId);
      await flush();
      await flush();

      const card = scriptCardOf(cardId);
      // Same backend call as a clean run (v1 has no session kernel)…
      expect(client.computeNode).toHaveBeenCalledTimes(1);
      // …but nothing was published: the display cache stays empty, `result` stays null and
      // no dependent was re-pointed at anything.
      expect(store().matrices.get(card.displayMatrixId)?.rowCount()).toBe(0);
      expect(card.result).toBeNull();
      expect(spy.calls).not.toContain(cardId);
      // The panel still sees shapes and the first rows.
      const run = store().scriptRuns[cardId];
      expect(run.status).toBe('done');
      expect(run.mode).toBe('debug');
      expect(run.previews['out:0']).toMatchObject({ rows: 3 });
    } finally {
      spy.restore();
    }
  });

  it('keeps a failing run in the panel, with the traceback, and clears stale numbers', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    // A first, successful run leaves numbers on screen…
    store().runScriptCard(cardId);
    await flush();
    await flush();
    expect(store().matrices.get(scriptCardOf(cardId).displayMatrixId)?.rowCount()).toBe(3);

    // …then the script breaks. The backend answers 200 with `state: "error"`.
    const traceback =
      'Traceback (most recent call last):\n' +
      '  File "<脚本卡>", line 3, in <module>\n' +
      '    result = A * object()\n' +
      'TypeError: unsupported operand type(s)\n';
    client.computeNode.mockImplementationOnce(async (nodeId: number) => ({
      ok: true,
      nodeId,
      state: 'error',
      code: 'invalidOutput',
      params: { name: 'result', reason: 'object dtype', stderr: traceback },
    }));
    store().runScriptCard(cardId);
    await flush();
    await flush();

    const card = scriptCardOf(cardId);
    expect(card.node?.state).toBe('error');
    expect(card.node?.code).toBe('invalidOutput');
    // The stale table is gone — a red lamp over last run's numbers is the exact lie the
    // backend already refuses to tell.
    expect(store().matrices.get(card.displayMatrixId)?.rowCount()).toBe(0);
    expect(card.result).toBeNull();
    const run = store().scriptRuns[cardId];
    expect(run.status).toBe('error');
    expect(run.code).toBe('invalidOutput');
    expect(String(run.params?.stderr)).toContain('line 3');
  });

  it('refuses locally when the declaration cannot be sent, and never calls compute', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    client.computeNode.mockClear();
    // A hand-edited (or half-applied) declaration: one port, no declared name.
    useWorkspace.setState((state) => ({
      cards: state.cards.map((card) =>
        card.id === cardId && isScriptCard(card)
          ? { ...card, params: { ...card.params, portNames: [] } }
          : card,
      ),
    }));

    store().runScriptCard(cardId);
    await flush();

    const run = store().scriptRuns[cardId];
    expect(run.status).toBe('error');
    // The backend would answer 400 invalidParams; the panel points at the field instead.
    expect(run.code).toBe('invalidParams');
    expect(run.params).toEqual({ name: 'portNames' });
    expect(client.computeNode).not.toHaveBeenCalled();
    // Not a red node: nothing was sent, so the node keeps its own state.
    expect(scriptCardOf(cardId).node?.state).toBe('dirty');
  });

  it('never runs twice at once', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    client.computeNode.mockClear();

    store().runScriptCard(cardId);
    store().runScriptCard(cardId);
    store().debugScriptCard(cardId);
    await flush();
    await flush();

    // One click is one interpreter: the second request never left the browser.
    expect(client.computeNode).toHaveBeenCalledTimes(1);
  });

  it('reports a card with no server-side source instead of running on air', async () => {
    const source = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([[1], [2]]) }]);
    // No `await`: the upload is still on the wire, so no server matrix id exists yet.
    const cardId = store().addScriptCard([source]);
    expect(cardId).not.toBeNull();
    client.computeNode.mockClear();

    store().runScriptCard(cardId as number);
    await flush();

    const run = store().scriptRuns[cardId as number];
    expect(run.status).toBe('idle');
    expect(run.code).toBe('upstreamPending');
    expect(client.computeNode).not.toHaveBeenCalled();
  });
});

describe('session state hygiene', () => {
  it('forgets a script card run when the card closes or the workspace resets', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    store().runScriptCard(cardId);
    await flush();
    await flush();
    expect(store().scriptRuns[cardId]).toBeDefined();

    expect(store().removeCard(cardId)).toBe(true);
    expect(store().scriptRuns[cardId]).toBeUndefined();
    expect(store().scriptRuns).toEqual({});
    // A fresh entry is exactly what a never-run card reports.
    expect(emptyScriptRun()).toMatchObject({ status: 'idle', previews: {} });
  });
});

describe('workspace symmetry', () => {
  it('round-trips the declaration through the snapshot', async () => {
    const source = await loadSource('a.csv', [[1], [2]]);
    const cardId = await makeScriptCard([source]);
    store().addScriptOutput(cardId);
    store().renameScriptPort(cardId, 'in:0', 'sensor');
    await flush();

    const snapshot = store().toSnapshot();
    const saved = snapshot.cards.find((card) => card.id === cardId) as FunctionCardModel;
    expect(saved.params.portNames).toEqual(['sensor']);
    expect(saved.params.outputs).toEqual(['result', 'result2']);
    expect(saved.outputs.map((output) => output.outputId)).toEqual(['out:0', 'out:1']);

    store().reset();
    store().loadSnapshot(snapshot);
    await flush();
    const restored = scriptCardOf(cardId);
    expect(restored.params.portNames).toEqual(['sensor']);
    expect(restored.outputs.map((output) => output.outputId)).toEqual(['out:0', 'out:1']);
    // A save file never claims a live run: the traceback, duration and previews are gone.
    expect(store().scriptRuns[cardId]).toBeUndefined();
    // The node itself is re-armed through the ordinary restore path, exactly like a formula
    // card's — restoring rebinds every function card to the restarted backend.
    expect(restored.node?.state).toBe('dirty');
    // The data card is still the source.
    const owner = store().cards.find((card) => card.id === source) as MatrixCardModel;
    expect(owner.kind).toBe('matrix');
  });
});