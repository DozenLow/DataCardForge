/**
 * @vitest-environment jsdom
 *
 * Unit-conversion card (`builtin:unit-convert`, units v1 P2) — the frontend half.
 *
 * The suite runs against the REAL store and a stubbed transport, because what has to be
 * right here is not the arithmetic (the backend owns it, and the fixture judge covers it)
 * but the CONTRACT this card puts on the wire:
 *
 *   - creating the card converts nothing (an `explicitCompute` signature is born
 *     dirty/`notRequested`, and the source table's numbers are never touched);
 *   - the picker lists only units of the SOURCE column's dimension, and an `ambiguous`
 *     source disables it with a hint pointing at the data card;
 *   - every `targets[]` entry carries an explicit `from` — the only way a confirmed
 *     ambiguous column (`current_a` → A) can be converted at all;
 *   - a structured error code renders as a localised sentence, and no table appears.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { columnUnitResolutions } from '../src/core/units.ts';
import { UNIT_CONVERT_SIGNATURE } from '../src/ui/migrate.ts';
import {
  buildTargets,
  UnitConvertCard,
} from '../src/ui/components/UnitConvertCard.tsx';
import {
  unitConvertTargets,
  useWorkspace,
  type UnitConvertTarget,
} from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel, MatrixCardModel } from '../src/ui/types.ts';
import type { NodeEvent } from '../src/backend/client.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

/** Input table: kPa / A / °C / hPa — one convertible, one confirmed, one non-scalar, one passthrough. */
const COL_PRESSURE = [100, 250, 50];
const COL_CURRENT = [2, 3, 4];
const COL_TEMP = [20, 21, 22];
const COL_OTHER = [1, 2, 3];

function sourceMatrix(): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', COL_PRESSURE);
  mat.setColumnAnnotation(0, 'pressure_kpa');
  mat.appendColumn('Pos.2', COL_CURRENT);
  mat.setColumnAnnotation(1, 'current_a');
  mat.appendColumn('Pos.3', COL_TEMP);
  mat.setColumnAnnotation(2, 'temp_c');
  mat.appendColumn('Pos.4', COL_OTHER);
  mat.setColumnAnnotation(3, 'hpa_alt');
  return mat;
}

/**
 * DCM2 dense frame, column-major, with the labels the "backend" would return.
 *
 * Deliberately NOT the source numbers: if these ever showed up on screen from a local
 * computation, the card would be converting in the browser, which backend-owned compute
 * forbids.
 */
function encodeFrame(columns: number[][], names: string[]): ArrayBuffer {
  const rows = columns[0]?.length ?? 0;
  const cols = columns.length;
  const namesBytes = new TextEncoder().encode(JSON.stringify(names));
  const buffer = new ArrayBuffer(24 + cols * rows * 8 + namesBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x44434d32, true); // DCM2
  view.setUint32(4, rows, true);
  view.setUint32(8, cols, true);
  view.setUint32(12, namesBytes.length, true);
  view.setUint32(16, rows, true);
  view.setUint32(20, cols, true);
  let offset = 24;
  for (const column of columns) {
    for (let r = 0; r < rows; ++r) view.setFloat64(offset + r * 8, column[r] ?? NaN, true);
    offset += rows * 8;
  }
  new Uint8Array(buffer, offset, namesBytes.length).set(namesBytes);
  return buffer;
}

const RESULT_PRESSURE = [1, 2.5, 0.5];
const RESULT_CURRENT = [2000, 3000, 4000];
const RESULT_TEMP = [20, 21, 22];
const RESULT_OTHER = [1, 2, 3];
/** What each column is called when nothing converted it (the pass-through half). */
const SOURCE_NAMES = ['pressure_kpa', 'current_a', 'temp_c', 'hpa_alt'];

interface Call {
  url: string;
  method: string;
  body?: string;
}

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

/**
 * Stub the transport: matrix upload, node create/patch, the explicit compute, the status
 * read and the result window. `error` makes `POST /compute` answer the refused shape the
 * real server sends for a rejected conversion (`code` + `params`).
 */
function stubBackend(opts: { error?: { code: string; params?: Record<string, unknown> } } = {}) {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 100;
  const resultOf = new Map<number, number>();
  /** The targets each node currently carries — the stub mirrors the real annotation rewrite. */
  const targetsOf = new Map<number, UnitConvertTarget[]>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

    if (url.endsWith('/api/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    if (url.endsWith('/api/nodes') && method === 'POST') {
      const nodeId = nextNodeId++;
      const resultMatrixId = nextMatrixId++;
      resultOf.set(nodeId, resultMatrixId);
      return json({
        nodeId,
        resultMatrixId,
        resultMatrixIds: [resultMatrixId],
        signatureId: UNIT_CONVERT_SIGNATURE,
        state: 'dirty',
        reason: 'notRequested',
      });
    }
    const push = /\/api\/nodes(?:\/(\d+))?$/.exec(url);
    if (push && (method === 'POST' || method === 'PATCH')) {
      const body = JSON.parse((init?.body as string | undefined) ?? '{}') as {
        params?: { targets?: UnitConvertTarget[] };
      };
      const nodeId = method === 'POST' ? nextNodeId : Number(push[1]);
      if (body.params?.targets) targetsOf.set(nodeId, body.params.targets);
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      if (opts.error) {
        // http_server.cpp answers a refused compute with HTTP 400 + { code, params }.
        const body = { code: opts.error.code, params: opts.error.params ?? {} };
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as unknown as Response;
      }
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'GET') {
      const nodeId = Number(nodePath[1]);
      // A node whose compute was refused IS in `error`, and its status carries the
      // structured code + params the sentence is built from (NodeStatusDto).
      if (opts.error) {
        return json({
          nodeId,
          state: 'error',
          resultMatrixId: resultOf.get(nodeId),
          code: opts.error.code,
          params: opts.error.params ?? {},
        });
      }
      return json({ nodeId, state: 'done', resultMatrixId: resultOf.get(nodeId) });
    }
    if (nodePath && method === 'PATCH') {
      return json({ nodeId: Number(nodePath[1]), state: 'dirty' });
    }
    if (url.includes('/window')) {
      // Which node produced this matrix decides the labels: the targeted columns carry the
      // canonical `to` unit in place of the parsed source suffix, every other column keeps
      // its annotation verbatim (the documented output shape, backend `units.cpp`).
      const nodeId = Number(/\/api\/nodes\/(\d+)\/compute$/.exec(url)?.[1] ?? -1);
      const owner = [...resultOf.entries()].find(([, matrixId]) => url.includes(`/matrices/${matrixId}/`))?.[0];
      const targets = targetsOf.get(owner ?? nodeId) ?? [];
      const names = SOURCE_NAMES.map((name, column) => {
        const target = targets.find((entry) => entry.column === column);
        if (!target) return `Pos.${column + 1} ${name}`;
        // Replace the trailing unit token, e.g. `pressure_kpa` → `pressure_bar`.
        return `Pos.${column + 1} ${name.replace(/_(?:[^_]+)$/, `_${target.to}`)}`;
      });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          encodeFrame(
            [RESULT_PRESSURE, RESULT_CURRENT, RESULT_TEMP, RESULT_OTHER],
            names,
          ),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(card: FunctionCardModel): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <UnitConvertCard
        card={store().cards.find((entry) => entry.id === card.id) as FunctionCardModel}
        resultMatrix={store().matrices.get(card.displayMatrixId)}
        sourceColumnNames={[]}
        active
        closeBlocked={false}
        onClose={() => {}}
        onCloseBlocked={() => {}}
        onActivate={() => {}}
      />,
    );
  });
  await settle();
  return host;
}

/** The same setup, but the source table's headers are the ones a case needs. */
async function setupWith(annotations: string[]): Promise<FunctionCardModel> {
  let sourceId = 0;
  await act(async () => {
    const mat = new MatrixData();
    annotations.forEach((annotation, index) => {
      mat.appendColumn(`Pos.${index + 1}`, [1, 2, 3]);
      mat.setColumnAnnotation(index, annotation);
    });
    sourceId = store().addMatrixCard([{ name: 'u.csv', matrix: mat }]);
  });
  await settle();
  let cardId: number | null = null;
  await act(async () => {
    cardId = store().addUnitConvertCard(sourceId);
  });
  await settle();
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

/** A data card holding the source table, plus a unit-convert card reading it. */
async function setup(): Promise<{ source: MatrixCardModel; card: FunctionCardModel }> {
  let sourceId = 0;
  await act(async () => {
    sourceId = store().addMatrixCard([{ name: 'u.csv', matrix: sourceMatrix() }]);
  });
  await settle();
  const source = store().cards.find((entry) => entry.id === sourceId) as MatrixCardModel;
  let cardId: number | null = null;
  await act(async () => {
    cardId = store().addUnitConvertCard(source.id);
  });
  await settle();
  return {
    source,
    card: store().cards.find((entry) => entry.id === cardId) as FunctionCardModel,
  };
}

/** The picker row for one column (`data-column` is the 0-based source column). */
function row(host: HTMLElement, column: number): HTMLElement {
  const element = host.querySelector<HTMLElement>(`.unit-convert__entry[data-column="${column}"]`);
  expect(element).not.toBeNull();
  return element!;
}

function picker(host: HTMLElement, column: number): HTMLSelectElement {
  return row(host, column).querySelector<HTMLSelectElement>('.unit-convert__target')!;
}

function optionValues(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll('option')].map((option) => option.value);
}

async function choose(host: HTMLElement, column: number, unit: string): Promise<void> {
  const select = picker(host, column);
  await act(async () => {
    select.value = unit;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function pressConvert(host: HTMLElement): Promise<void> {
  // The card flips "the picker has choices the card does not know" in a passive effect that
  // runs AFTER the click's act() returns, so the enablement settles one tick later.
  await settle();
  const button = host.querySelector<HTMLButtonElement>('.unit-convert__convert');
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
  await settle();
}

/** Result column headers, as `VirtualTable` draws them (one label per column). */
function resultHeaders(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.unit-convert__grid .vtable__colhead-label')].map(
    (cell) => cell.textContent ?? '',
  );
}

let backend: ReturnType<typeof stubBackend> | null = null;

beforeEach(async () => {
  store().reset();
  store().setLocale('zh');
  backend = stubBackend();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  backend?.restore();
  backend = null;
});

describe('unit-convert card — creation', () => {
  it('binds a node but converts nothing', async () => {
    const { card } = await setup();

    expect(card.signatureId).toBe(UNIT_CONVERT_SIGNATURE);
    // The card model the spec locks: one matrix port, one declared output, no target yet.
    expect(card.inputs.map((input) => input.portId)).toEqual(['src']);
    expect(card.inputs[0].target.type).toBe('matrix');
    expect(card.outputs.map((output) => output.outputId)).toEqual(['result']);
    expect(unitConvertTargets(card)).toEqual([]);
    // An `explicitCompute` signature is born dirty/notRequested…
    expect(card.node?.state).toBe('dirty');
    // …and the display cache starts empty.
    expect(store().matrices.get(card.displayMatrixId)?.columnCount() ?? 0).toBe(0);
    // No compute was requested: creating a card never rewrites anybody's numbers.
    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(0);
    // The source table is untouched: converting produces a NEW table, never a rewrite.
    const sourceMatrixId = store()
      .cards.find((entry) => entry.kind === 'matrix')!
      .sources[0].matrixId;
    expect(store().matrices.get(sourceMatrixId)!.cell(0, 0)).toBe(100);
  });

  it('refuses a matrix that is not the source card\'s own, leaving nothing behind', async () => {
    const { source, card } = await setup();
    // An id that names no matrix at all: the card must not be created half-wired.
    const before = store().cards.length;
    expect(store().addUnitConvertCard(source.id, 999_999)).toBeNull();
    expect(store().cards).toHaveLength(before);
    // A chart cannot be a source for a conversion (nothing to convert), and a closed card
    // is not one either.
    expect(store().addUnitConvertCard(4242)).toBeNull();
    // The chain in the legal direction still works — a converted table is a table.
    expect(store().addUnitConvertCard(card.id, card.displayMatrixId)).not.toBeNull();
  });
});

describe('unit-convert card — the picker', () => {
  it('offers "keep as-is" plus every unit of the source dimension', async () => {
    const { card } = await setup();
    const host = await mount(card);

    // pressure_kpa → pressure dimension. The first option is always 保持原样.
    const pressure = picker(host, 0);
    expect(optionValues(pressure)[0]).toBe('');
    expect(pressure.options[0].textContent).toBe('保持原样');
    expect(optionValues(pressure)).toContain('bar');
    expect(optionValues(pressure)).toContain('kPa');
    // A target of ANOTHER dimension is never offered (the backend would refuse it anyway).
    expect(optionValues(pressure)).not.toContain('mm');
    expect(optionValues(pressure)).not.toContain('A');
    // The source unit is derived the way the header chips derive it.
    expect(row(host, 0).querySelector('.unit-convert__source')?.textContent).toBe('kPa');
  });

  it('disables the picker for an ambiguous source and points at the data card', async () => {
    const { card } = await setup();
    const host = await mount(card);

    // `current_a` parses ambiguous (single letter): only the data card can confirm it.
    const current = picker(host, 1);
    expect(current.disabled).toBe(true);
    expect(row(host, 1).querySelector('.unit-convert__blocked')?.textContent).toBe(
      '先在数据卡确认单位',
    );
    expect(row(host, 1).querySelector('.unit-convert__source')?.textContent).toBe('待确认「a」');
  });

  it('says "not convertible" for a recognised non-scalar source', async () => {
    const card = await setupWith(['pressure_kpa', 'level_db']);
    const host = await mount(card);

    // `level_db` is a recognised logarithmic label: no multiplicative conversion exists, so
    // the picker offers nothing and the row says so (as opposed to "confirm it first").
    expect(picker(host, 1).disabled).toBe(true);
    expect(row(host, 1).querySelector('.unit-convert__blocked')?.textContent).toBe('不可换算');
    expect(picker(host, 0).disabled).toBe(false);
  });

  it('enables a confirmed ambiguous column (the confirmation is the input)', async () => {
    const { card, source } = await setup();
    const matrixId = source.sources[0].matrixId;
    await act(async () => {
      store().confirmUnitGroup(matrixId, 'a', 'A');
    });
    const host = await mount(card);

    const current = picker(host, 1);
    expect(current.disabled).toBe(false);
    expect(row(host, 1).querySelector('.unit-convert__source')?.textContent).toBe('A');
    expect(optionValues(current)).toContain('mA');
    expect(optionValues(current)).not.toContain('bar');
  });
});

describe('unit-convert card — converting', () => {
  it('sends an explicit from, converts one column and passes the rest through', async () => {
    const { card, source } = await setup();
    // Confirm the ambiguous column so both it and the recognised one can be targeted.
    await act(async () => {
      store().confirmUnitGroup(source.sources[0].matrixId, 'a', 'A');
    });
    const host = await mount(card);

    await choose(host, 0, 'bar');
    await choose(host, 1, 'mA');
    await pressConvert(host);

    const compute = backend!.calls.filter((call) => /\/compute$/.test(call.url));
    // Exactly one compute: the card is explicit and never converts on its own.
    expect(compute).toHaveLength(1);
    // The node already existed (creation binds it, computes nothing), so the parameters
    // travel on the PATCH that immediately precedes the compute.
    const pushedCall = backend!.calls[backend!.calls.indexOf(compute[0]) - 1];
    expect(pushedCall.method).toBe('PATCH');
    expect(pushedCall.url).toMatch(/\/api\/nodes\/\d+$/);
    const pushed = JSON.parse(pushedCall.body ?? '{}') as {
      params: { targets: UnitConvertTarget[] };
    };
    // THE rule: every target names its source unit explicitly, so a confirmed ambiguous
    // annotation (`current_a`) still carries the user's answer across the card boundary.
    expect(pushed.params.targets).toEqual([
      { column: 0, from: 'kPa', to: 'bar' },
      { column: 1, from: 'A', to: 'mA' },
    ]);

    // The result grid is what the backend returned: converted columns, passthrough verbatim.
    expect(resultHeaders(host)).toContain('pressure_bar');
    expect(resultHeaders(host)).toContain('current_mA');
    // The untargeted columns were never asked for: their headers are unchanged.
    expect(resultHeaders(host)).toContain('temp_c');
    expect(resultHeaders(host)).toContain('hpa_alt');
    // The card's own parameter now holds them, so a reload keeps the picker in sync.
    const updated = store().cards.find((entry) => entry.id === card.id) as FunctionCardModel;
    expect(unitConvertTargets(updated)).toEqual(pushed.params.targets);
  });

  it('reuses the node on a second conversion instead of creating another', async () => {
    const { card } = await setup();
    const host = await mount(card);

    await choose(host, 0, 'bar');
    await pressConvert(host);
    await choose(host, 0, 'kPa');
    await pressConvert(host);

    const creates = backend!.calls.filter(
      (call) => call.method === 'POST' && /\/api\/nodes$/.test(call.url),
    );
    const patches = backend!.calls.filter(
      (call) => call.method === 'PATCH' && /\/api\/nodes\/\d+$/.test(call.url),
    );
    // One node for the whole card; each conversion is one PATCH + one compute.
    expect(creates).toHaveLength(1);
    expect(patches).toHaveLength(2);
    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(2);
  });

  it('will not run with no target chosen (keep-as-is is not an action)', async () => {
    const { card } = await setup();
    const host = await mount(card);
    await settle();

    const button = host.querySelector<HTMLButtonElement>('.unit-convert__convert');
    expect(button?.disabled).toBe(true);
    expect(host.querySelector('.unit-convert__status')?.textContent).toBe(
      '尚未换算 — 选好目标单位后点「换算」',
    );
  });
});

describe('unit-convert card — never automatic', () => {
  it('goes stale (and keeps no numbers) when the upstream table changes', async () => {
    const { card } = await setup();
    const host = await mount(card);

    await choose(host, 0, 'bar');
    await pressConvert(host);
    expect(host.querySelector('.unit-convert__grid')).not.toBeNull();
    const nodeId = (
      store().cards.find((entry) => entry.id === card.id) as FunctionCardModel
    ).node!.nodeId;

    const computesBefore = backend!.calls.filter((call) => /\/compute$/.test(call.url)).length;
    // The backend's own push for "my input changed": the node is dirty and its result matrix
    // has already been emptied. The card must drop the table — and must NOT convert again.
    await act(async () => {
      store().applyNodeEvent({
        seq: 1,
        nodeId,
        state: 'dirty',
        reason: 'upstreamChanged',
      } as NodeEvent & { reason: 'upstreamChanged' });
    });
    await settle();

    expect(backend!.calls.filter((call) => /\/compute$/.test(call.url))).toHaveLength(
      computesBefore,
    );
    expect(host.querySelector('.unit-convert__grid')).toBeNull();
    expect(host.querySelector('.unit-convert__status')?.textContent).toBe(
      '上游已变 — 上次换算的结果已失效，点「换算」重算',
    );
    expect(host.querySelector('.unit-convert__convert')?.textContent).toBe('重新换算');
  });
});

describe('unit-convert card — errors', () => {
  it('renders the structured code as a localised sentence', async () => {
    backend?.restore();
    backend = stubBackend({ error: { code: 'unitMismatch', params: { column: 0, from: 'kPa', to: 'kN' } } });
    const { card } = await setup();
    const host = await mount(card);

    await choose(host, 0, 'bar');
    await pressConvert(host);

    const alert = host.querySelector('.unit-convert__error');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    // The sentence is i18n's, filled with the backend's structured params — never server prose.
    expect(alert?.textContent).toBe('第 0 列量纲不同：「kPa」不能换算为「kN」');
    // A refused conversion publishes no table (the backend emptied the matrix).
    expect(host.querySelector('.unit-convert__grid')).toBeNull();
    expect(host.querySelector('.unit-convert__status')?.textContent).toBe(
      '第 0 列量纲不同：「kPa」不能换算为「kN」',
    );
  });

  it('renders unitAmbiguous for a column confirmed nowhere', async () => {
    backend?.restore();
    backend = stubBackend({ error: { code: 'unitAmbiguous', params: { column: 1, token: 'a' } } });
    const { card } = await setup();
    const host = await mount(card);

    await choose(host, 0, 'bar');
    await pressConvert(host);

    expect(host.querySelector('.unit-convert__error')?.textContent).toBe(
      '第 1 列单位待确认「a」— 先在数据卡确认',
    );
  });
});

describe('unit-convert targets', () => {
  const resolutions = (annotations: string[]) =>
    columnUnitResolutions(annotations, {}).resolutions;

  it('always carries from = the derived unit, and only for scalar recognised columns', () => {
    const source = resolutions(['pressure_kpa', 'temp_c', 'current_a']);
    const targets = buildTargets(source, { 0: 'bar', 1: 'Pa', 2: 'A', 3: 'kPa' });
    // Column 1 is non-scalar and column 2 ambiguous: neither can become a target, and
    // column 3 does not exist. The survivor names `from` explicitly.
    expect(targets).toEqual([{ column: 0, from: 'kPa', to: 'bar' }]);
  });

  it('treats the empty choice as keep-as-is and sorts by column', () => {
    // `pressure_mpa` parses ambiguous (`mpa` is a single colliding token — that rule is
    // the resolver's, not this card's); a MISSING comment unit annotation does not exist
    // here on purpose, so the recognised pair is the two that resolve cleanly.
    const source = resolutions(['pressure_kpa', 'pressure_bar']);
    expect(buildTargets(source, { 0: '', 1: 'hPa' })).toEqual([
      { column: 1, from: 'bar', to: 'hPa' },
    ]);
    // Sorted by column, whatever order the picker was touched in.
    expect(buildTargets(source, { 1: 'hPa', 0: 'Pa' })).toEqual([
      { column: 0, from: 'kPa', to: 'Pa' },
      { column: 1, from: 'bar', to: 'hPa' },
    ]);
  });
});