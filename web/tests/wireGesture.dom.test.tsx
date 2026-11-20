/**
 * @vitest-environment jsdom
 *
 * Right-drag wiring, end to end over the real DOM seam (G3).
 *
 * The pure drop matrix and the arbiter's states are unit-tested in `wireGesture.test.ts`; this
 * file covers what only a mounted app can show:
 *   - the **trigger**: a right press on the title bar arms, a left press does not, and neither
 *     react-rnd's activation nor the pointer-only arming is disturbed;
 *   - the **draft wire**: it is painted by the connection layer (background SVG, pointer-events
 *     none) with an arrowhead, and it vanishes when the sequence ends;
 *   - the **cancels**: Escape, pointercancel, lost pointer capture and window blur abandon the
 *     drag without a write, and a late release cannot resurrect it;
 *   - the **commit**: a release over a port row re-binds that port, a release over the card body
 *     adds one, a chart refuses, and a multi-output source opens a chooser instead of guessing.
 *
 * jsdom has no layout, so every measurement is stubbed (`cardMetrics` reads
 * `getBoundingClientRect`): the cards are plain divs registered with explicit rects, and a port
 * row is a child carrying `data-port-id` — the very attribute `ScriptCard` puts on its rows.
 * The canvas origin is stubbed at (0,0) with zoom 1, so client and plane coordinates coincide
 * and one number names both.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  invalidateLayout,
  registerCard,
  resetMetrics,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
} from '../src/ui/cardMetrics.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { CardShell } from '../src/ui/components/CardShell.tsx';
import { ConnectionLayer } from '../src/ui/ConnectionLayer.tsx';
import { IDLE_WIRE_STATE, getWireState, resetWireGesture } from '../src/ui/wireGesture.ts';
import {
  PYTHON_SIGNATURE,
  scriptParams,
  type CardModel,
  type FunctionCardModel,
  type MatrixCardModel,
} from '../src/ui/types.ts';

// React 19 wants this set so act() works outside its test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Give an element a fixed rect — jsdom reports zeros otherwise. */
function stubRect(element: HTMLElement, box: Box): void {
  element.getBoundingClientRect = () =>
    ({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      right: box.x + box.width,
      bottom: box.y + box.height,
      x: box.x,
      y: box.y,
      toJSON: () => ({}),
    }) as DOMRect;
}

function matrix(values: number[]): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', values);
  return data;
}

function pointerEvent(
  type: string,
  init: { clientX: number; clientY: number; button?: number; pointerId?: number },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
    clientY: init.clientY,
    pointerId: init.pointerId ?? 1,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ── scene ────────────────────────────────────────────────────────────────────────────
//
// A: the data card that publishes `c.csv` (100,100,300,200).
// B: the script card that receives it   (600,100,320,320); its `in:0` row is at (610,150,…).
// C: the data card B's port already reads (published, never dropped on).
// H: a chart card, which accepts no input (660,470,300,200).

const A_AT: Box = { x: 100, y: 100, width: 300, height: 200 };
const B_AT: Box = { x: 600, y: 100, width: 320, height: 320 };
const C_AT: Box = { x: 100, y: 500, width: 300, height: 200 };
const H_AT: Box = { x: 660, y: 470, width: 300, height: 200 };
const PORT_ROW: Box = { x: 610, y: 150, width: 300, height: 26 };

interface Scene {
  a: MatrixCardModel;
  b: FunctionCardModel;
  chart: number;
  /** Matrix id `c.csv` publishes (the wire's source). */
  cCsv: number;
  /** Matrix id B's `in:0` reads before any drop. */
  aCsv: number;
}

/** Register a measured card element, optionally with a `data-port-id` row inside it. */
function measuredCard(
  id: number,
  box: Box,
  ports: Array<{ portId: string; box: Box }> = [],
): HTMLElement {
  const element = document.createElement('div');
  stubRect(element, box);
  for (const port of ports) {
    const row = document.createElement('div');
    row.dataset.portId = port.portId;
    stubRect(row, port.box);
    element.appendChild(row);
  }
  document.body.appendChild(element);
  registerCard(id, element);
  return element;
}

function scriptCard(
  id: number,
  at: Box,
  overrides: Partial<FunctionCardModel> = {},
): FunctionCardModel {
  return {
    kind: 'formula',
    id,
    title: '',
    ...at,
    z: 5,
    createdAt: Date.now(),
    inputs: [],
    signatureId: PYTHON_SIGNATURE,
    params: { script: '', portNames: [], outputs: ['result'] },
    outputs: [{ outputId: 'out:0', resultMatrixId: -1 }],
    node: null,
    result: null,
    displayMatrixId: 500 + id,
    ...overrides,
  };
}

function buildScene(): Scene {
  const aId = store().addMatrixCard([{ name: 'c.csv', matrix: matrix([1, 2, 3]) }]);
  store().setBounds(aId, A_AT);
  const a = store().cards.find((card) => card.id === aId) as MatrixCardModel;

  const cId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([9, 8, 7]) }]);
  store().setBounds(cId, C_AT);
  const c = store().cards.find((card) => card.id === cId) as MatrixCardModel;
  const aCsv = c.sources[0].matrixId;

  const chartId = store().addChartCard(aId, 0) ?? 0;
  if (chartId !== 0) store().setBounds(chartId, H_AT);

  // The script card is appended with an id the store will never hand out again, so the only
  // thing under test is the gesture — not id allocation (which `workspaceStore.test.ts` owns).
  const bId = 500;
  const b = scriptCard(bId, B_AT, {
    inputs: [{ portId: 'in:0', target: { type: 'matrix', cardId: cId, matrixId: aCsv } }],
    params: { script: 'print(A)\n', portNames: ['A'], outputs: ['result'] },
  });
  useWorkspace.setState({ cards: [...store().cards, b] });
  // The edge the card claims, in the graph the store keeps — a restored workspace is built this
  // way (`rebuildDependencies`), and a re-bind has to *re-sync* it, not just edit `inputs[]`.
  store().dependencies.addDependency(bId, cId, 'in:0');

  // Measured elements: A and C render no port, B renders its input row, the chart neither.
  measuredCard(aId, A_AT);
  measuredCard(cId, C_AT);
  measuredCard(bId, B_AT, [{ portId: 'in:0', box: PORT_ROW }]);
  if (chartId !== 0) measuredCard(chartId, H_AT);

  return {
    a,
    b: store().cards.find((card) => card.id === bId) as FunctionCardModel,
    chart: chartId,
    cCsv: a.sources[0].matrixId,
    aCsv,
  };
}

/** The script card's inputs, straight from the store (never a local copy). */
function inputsOf(cardId: number) {
  const card = store().cards.find((entry) => entry.id === cardId);
  return card?.inputs ?? [];
}

// ── mounting ─────────────────────────────────────────────────────────────────────────

/** How often the shell asked the app to raise/select the card (react-rnd `onMouseDown`). */
let activateCalls = 0;

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  // The canvas origin is (0,0) at zoom 1: client px == plane px, so one number names both.
  const viewport = document.createElement('div');
  stubRect(viewport, { x: 0, y: 0, width: 1400, height: 900 });
  const world = document.createElement('div');
  stubRect(world, { x: 0, y: 0, width: 20000, height: 20000 });
  setCanvasElement(viewport);
  setWorldElement(world);
  setCanvasZoom(1);
  activateCalls = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  resetWireGesture();
  resetMetrics();
  document.body.innerHTML = '';
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

/** Mount the connection layer — the only painter of the draft wire. */
async function mountLayer(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  function Harness() {
    const cards = useWorkspace((state) => state.cards);
    const dependencies = useWorkspace((state) => state.dependencies);
    const view = useWorkspace((state) => state.view);
    return (
      <ConnectionLayer
        cards={cards}
        selectedId={null}
        blockedCardId={null}
        blockNonce={0}
        view={view}
        dependencies={dependencies}
      />
    );
  }

  await act(async () => {
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

/**
 * Mount a real card shell — the wiring trigger.
 *
 * Its react-rnd root is what `CardShell` registers with `cardMetrics`, and jsdom gives it a
 * zero rectangle, so the scene's box is stamped onto that element afterwards (the same rect the
 * scene's plain div carries) and the layout version is bumped so the layer re-measures.
 */
async function mountShell(card: CardModel): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <CardShell
          card={card}
          title="script"
          active
          variant="card--formula"
          onActivate={() => {
            activateCalls += 1;
          }}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onBounds={() => {}}
          closeBlocked={false}
          closeLabel="close"
        >
          <span />
        </CardShell>
      </StrictMode>,
    );
  });
  const rootElement = host.querySelector<HTMLElement>('.card');
  if (rootElement) stubRect(rootElement, card);
  invalidateLayout();
  await flush();
  return host;
}

function titlebarOf(host: HTMLElement): HTMLElement {
  const element = host.querySelector('.card__titlebar');
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

/** Press the right button on the title bar, then drag to `to`. */
async function rightDrag(
  titlebar: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await act(async () => {
    titlebar.dispatchEvent(
      pointerEvent('pointerdown', {
        button: 2,
        clientX: from.x,
        clientY: from.y,
        pointerId: 1,
      }),
    );
  });
  await act(async () => {
    window.dispatchEvent(pointerEvent('pointermove', { clientX: to.x, clientY: to.y, pointerId: 1 }));
  });
}

async function release(to: { x: number; y: number }): Promise<void> {
  await act(async () => {
    window.dispatchEvent(pointerEvent('pointerup', { clientX: to.x, clientY: to.y, pointerId: 1 }));
  });
  await flush();
}

/** Every input target in the workspace, as one comparable string. */
function inputsSnapshot(): string {
  return JSON.stringify(store().cards.map((card) => card.inputs));
}

// ── the trigger ──────────────────────────────────────────────────────────────────────

describe('the wiring trigger lives on the title bar', () => {
  it('arms on a right press and paints nothing until the pointer moves 4px', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.b);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);

    await act(async () => {
      titlebar.dispatchEvent(
        pointerEvent('pointerdown', { button: 2, clientX: 620, clientY: 112, pointerId: 1 }),
      );
    });
    expect(getWireState().phase).toBe('candidate');
    expect(getWireState().client).toEqual({ x: 620, y: 112 });
    expect(layer.querySelector('.connection--draft')).toBeNull();

    // 2px is not a drag yet: still a candidate, still nothing drawn.
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 622, clientY: 112, pointerId: 1 }));
    });
    expect(getWireState().phase).toBe('candidate');
    expect(layer.querySelector('.connection--draft')).toBeNull();
    expect(document.querySelector('.wire-drop-label')).toBeNull();
  });

  it('leaves the left button completely alone (activate / drag / resize unchanged)', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.b);
    const titlebar = titlebarOf(shell);

    // The eight resize handles react-rnd renders are untouched by this lane (4 edges + 4
    // corners; this react-resizable version marks them by cursor, not by class).
    const handles = [...shell.querySelectorAll<HTMLElement>('div')].filter((element) =>
      element.style.cursor.endsWith('-resize'),
    );
    expect(handles).toHaveLength(8);

    await act(async () => {
      titlebar.dispatchEvent(
        pointerEvent('pointerdown', { button: 0, clientX: 620, clientY: 112, pointerId: 1 }),
      );
    });
    expect(getWireState().phase).toBe('idle');

    // react-rnd listens for `mousedown`; the left button must still reach it (raise/select).
    await act(async () => {
      titlebar.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 620, clientY: 112 }),
      );
    });
    expect(activateCalls).toBeGreaterThan(0);
  });

  it('paints the card a live wire would land on: accept vs refuse', async () => {
    const scene = buildScene();
    const sourceShell = await mountShell(scene.a);
    const targetShell = await mountShell(scene.b);
    await mountLayer();
    const titlebar = titlebarOf(sourceShell);
    const target = targetShell.querySelector<HTMLElement>('.card');
    const source = sourceShell.querySelector<HTMLElement>('.card');

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 350 });
    expect(target?.className).toContain('card--wire-accept');
    const accept = target?.style.outline ?? '';
    expect(accept).toContain('solid');

    // Hovering the source itself is a refusal (a card cannot feed itself), and the ring says so
    // before the release — the decision's "red before you let go".
    await act(async () => {
      window.dispatchEvent(
        pointerEvent('pointermove', { clientX: 200, clientY: 112, pointerId: 1 }),
      );
    });
    expect(source?.className).toContain('card--wire-refuse');
    expect(source?.style.outline).toContain('solid');
    expect(source?.style.outline).not.toBe(accept);
    // Only one card is highlighted at a time.
    expect(target?.className).not.toContain('card--wire-accept');
  });

  it('does not arm from a contextmenu or a keyboard menu key (pointer only)', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.b);
    const titlebar = titlebarOf(shell);

    await act(async () => {
      titlebar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      titlebar.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }),
      );
    });

    expect(getWireState().phase).toBe('idle');
  });

  it('a right press that never moves is a click: no gesture, no write', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.b);
    const titlebar = titlebarOf(shell);
    const before = inputsSnapshot();

    await rightDrag(titlebar, { x: 620, y: 112 }, { x: 621, y: 112 });
    await release({ x: 621, y: 112 });

    expect(getWireState().phase).toBe('idle');
    expect(inputsSnapshot()).toBe(before);
  });
});

// ── the draft wire ──────────────────────────────────────────────────────────────────

describe('the draft wire', () => {
  it('runs from the source card to the pointer, with an arrowhead showing the direction', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 350 });

    const path = layer.querySelector('.connection--draft .connection__wire--draft');
    expect(path).not.toBeNull();
    // A cubic from the source frame to the pointer.
    expect(path?.getAttribute('d')).toMatch(/^M [\d.-]+ [\d.-]+ C /);
    const arrow = layer.querySelector('.connection--draft .connection__arrow');
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute('d')).toMatch(/^M .+ L .+ L .+ Z$/);
    expect(arrow?.getAttribute('fill')).toBeTruthy();
    expect(arrow?.getAttribute('d')).not.toBe('');
    // The label states the action and the direction BEFORE the release (决策 §六).
    const label = document.querySelector('.wire-drop-label');
    expect(label?.textContent).toContain('新增端口');
    expect(label?.getAttribute('data-wire-drop')).toBe('add');
  });

  it('turns dashed and says "取消" over the bare canvas', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 1200, y: 800 });

    const path = layer.querySelector('.connection--draft .connection__wire--draft');
    expect(path?.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(document.querySelector('.wire-drop-label')?.getAttribute('data-wire-drop')).toBe('cancel');
  });

  it('vanishes when the sequence ends and never intercepts the pointer', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 1200, y: 800 });
    expect(layer.querySelector('.connection--draft')).not.toBeNull();

    await release({ x: 1200, y: 800 });

    expect(layer.querySelector('.connection--draft')).toBeNull();
    expect(document.querySelector('.wire-drop-label')).toBeNull();
    // The draft lives in the same background SVG as every settled wire.
    expect(layer.querySelector('svg.connection-layer')).not.toBeNull();
  });
});

// ── the commit ──────────────────────────────────────────────────────────────────────

describe('the release commits the drop through the store', () => {
  it('replaces the port whose row the wire was dropped on', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 160 });
    // Before the release: the label promises a REPLACE on `in:0`, and the draft is still drawn.
    const label = document.querySelector('.wire-drop-label');
    expect(label?.getAttribute('data-wire-drop')).toBe('replace');
    expect(label?.getAttribute('data-wire-port')).toBe('in:0');
    expect(label?.textContent).toContain('替换端口');
    expect(layer.querySelector('.connection--draft')).not.toBeNull();

    await release({ x: 700, y: 160 });

    const inputs = inputsOf(scene.b.id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].portId).toBe('in:0');
    expect(inputs[0].target).toMatchObject({
      type: 'matrix',
      cardId: scene.a.id,
      matrixId: scene.cCsv,
    });
    // The declaation was not touched: a re-bind is a data change (决策 §二).
    const card = store().cards.find((entry) => entry.id === scene.b.id) as FunctionCardModel;
    expect(scriptParams(card).portNames).toEqual(['A']);
    expect(scriptParams(card).script).toBe('print(A)\n');
  });

  it('adds a port when the wire is dropped on the card body', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 350 });
    expect(document.querySelector('.wire-drop-label')?.textContent).toContain('新增端口');

    await release({ x: 700, y: 350 });

    const inputs = inputsOf(scene.b.id);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].portId).toBe('in:1');
    expect(inputs[1].target).toMatchObject({
      type: 'matrix',
      cardId: scene.a.id,
      matrixId: scene.cCsv,
    });
    const card = store().cards.find((entry) => entry.id === scene.b.id) as FunctionCardModel;
    expect(scriptParams(card).portNames).toEqual(['A', 'B']);
  });

  it('refuses a chart: the label says so, the release writes nothing', async () => {
    const scene = buildScene();
    const shell = await mountShell(scene.a);
    const layer = await mountLayer();
    const titlebar = titlebarOf(shell);
    const before = inputsSnapshot();

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 800, y: 560 });

    expect(document.querySelector('.wire-drop-label')?.textContent).toContain('不接受新输入');
    const path = layer.querySelector('.connection--draft .connection__wire--draft');
    expect(path?.getAttribute('stroke')).toBe('rgb(200, 50, 50)');

    await release({ x: 800, y: 560 });

    expect(inputsSnapshot()).toBe(before);
    expect(getWireState().phase).toBe('idle');
  });

  it('asks which output of a multi-output source, and commits only after a pick', async () => {
    // A script card with two declared outputs is the source; nothing may be guessed.
    const source = scriptCard(
      61,
      { x: 100, y: 100, width: 300, height: 200 },
      {
        params: { script: '', portNames: [], outputs: ['residual', 'fitted'] },
        outputs: [
          { outputId: 'out:0', resultMatrixId: -1 },
          { outputId: 'out:1', resultMatrixId: -1, localMatrixId: 777 },
        ],
        displayMatrixId: 601,
      },
    );
    const target = scriptCard(62, B_AT);
    useWorkspace.setState({ cards: [...store().cards, source, target] });
    measuredCard(source.id, { x: 100, y: 100, width: 300, height: 200 });
    measuredCard(target.id, B_AT, [{ portId: 'in:0', box: PORT_ROW }]);

    const shell = await mountShell(source);
    await mountLayer();
    const titlebar = titlebarOf(shell);

    await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 350 });
    await release({ x: 700, y: 350 });

    // Nothing written, and a chooser is open at the drop point.
    expect(inputsOf(target.id)).toHaveLength(0);
    const chooser = document.querySelector('[data-wire-choice]');
    expect(chooser).not.toBeNull();
    expect(chooser?.getAttribute('data-wire-choice')).toBe(String(target.id));
    const items = [...document.querySelectorAll<HTMLElement>('.wire-choice__item')];
    expect(items.map((item) => item.dataset.matrixId)).toEqual(['601', '777']);

    // Picking the SECOND output commits that one — out:0 is never assumed.
    await act(async () => {
      items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const inputs = inputsOf(target.id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].target).toMatchObject({ cardId: source.id, matrixId: 777 });
    expect(document.querySelector('.wire-choice')).toBeNull();
  });
});

// ── the cancels ─────────────────────────────────────────────────────────────────────

describe('a gesture can always be abandoned without a write', () => {
  const cases: Array<[string, () => void]> = [
    [
      'Escape',
      () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        ),
    ],
    [
      'pointercancel',
      () =>
        window.dispatchEvent(pointerEvent('pointercancel', { clientX: 700, clientY: 350 })),
    ],
    [
      'lost pointer capture',
      () =>
        window.dispatchEvent(pointerEvent('lostpointercapture', { clientX: 700, clientY: 350 })),
    ],
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
  ];

  for (const [name, abandon] of cases) {
    it(`${name} discards the wire and nothing is written afterwards`, async () => {
      const scene = buildScene();
      const shell = await mountShell(scene.a);
      const layer = await mountLayer();
      const titlebar = titlebarOf(shell);
      const before = inputsSnapshot();

      await rightDrag(titlebar, { x: 200, y: 112 }, { x: 700, y: 350 });
      expect(layer.querySelector('.connection--draft')).not.toBeNull();

      await act(async () => {
        abandon();
      });

      expect(getWireState()).toEqual(IDLE_WIRE_STATE);
      expect(layer.querySelector('.connection--draft')).toBeNull();

      // A release that arrives after the cancel must not resurrect the drop.
      await release({ x: 700, y: 350 });
      expect(inputsSnapshot()).toBe(before);
      expect(inputsOf(scene.b.id)).toHaveLength(1);
    });
  }
});