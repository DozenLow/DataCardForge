/**
 * @vitest-environment jsdom
 *
 * Chart card — the y-axis unit (units v1, task book item P1d).
 *
 * A unit is DERIVED at render time from the live matrices plus the confirmation memory; it is
 * never stored on the chart's `ChartSource` (decision §三). The rule under test is the
 * conservative one: the axis states a unit only when EVERY plotted y column resolves to the
 * same `recognized` unit. An axis title is a claim about every number on it, so a mixed set —
 * or one still waiting for the user — must keep the plain "Value" label.
 *
 * ECharts is imported lazily and jsdom has no layout, but the card still installs the real
 * instance and applies the option, and the package also publishes it on `window.echarts`.
 * The assertions therefore read the option the card actually applied, not a rebuilt one.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { ChartCardModel } from '../src/ui/types.ts';
import { ChartCard } from '../src/ui/components/ChartCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no canvas and no layout, so ECharts reports "can't get DOM width or height" and
 * "getContext is not implemented" while it initialises.
 *
 * This suite asserts on the option the card APPLIES, never on drawn pixels, so those two
 * messages are expected rather than diagnostic — and left unfiltered they would drown a real
 * failure in the log.
 */
const IGNORED = [/Can't get DOM width or height/, /HTMLCanvasElement's getContext/];
function muteExpectedConsole(): () => void {
  const methods = ['error', 'warn', 'log'] as const;
  const originals = methods.map((method) => console[method]);
  methods.forEach((method, index) => {
    console[method] = (...args: unknown[]) => {
      const text = args.map((entry) => String(entry)).join(' ');
      if (IGNORED.some((pattern) => pattern.test(text))) return;
      originals[index](...args as never[]);
    };
  });
  return () => {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  };
}
let unmute: (() => void) | null = null;

// ECharts probes a 2D context for its feature detection, and jsdom answers through its own
// virtual console — which bypasses `console.*`, so the filter above cannot see it. jsdom DOES
// define `getContext` (as a "not implemented" reporter), so it has to be replaced outright.
function stubCanvas(): () => void {
  const proto = globalThis.HTMLCanvasElement?.prototype as
    | { getContext?: unknown }
    | undefined;
  if (!proto) return () => {};
  const original = proto.getContext;
  proto.getContext = () => null;
  return () => {
    proto.getContext = original;
  };
}
let restoreCanvas: (() => void) | null = null;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(annotations: string[]): MatrixData {
  const mat = new MatrixData();
  annotations.forEach((annotation, index) => {
    mat.appendColumn(`Pos.${index + 1}`, [1, 2, 3, 4, 5, 6]);
    mat.setColumnAnnotation(index, annotation);
  });
  return mat;
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

/** Registration is fire-and-forget; answering it keeps the suite off the network. */
function stubBackend(): () => void {
  const originalFetch = globalThis.fetch;
  let nextMatrixId = 1;
  globalThis.fetch = (async () =>
    json({ matrixId: nextMatrixId++, revision: 1 })) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  store().reset();
  store().setLocale('en');
  restoreFetch = stubBackend();
  unmute = muteExpectedConsole();
  restoreCanvas = stubCanvas();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  restoreFetch?.();
  restoreFetch = null;
  unmute?.();
  unmute = null;
  restoreCanvas?.();
  restoreCanvas = null;
});

/** Wait for the lazy ECharts import and the instance creation that follows it. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * One data card holding `annotations`, and a line chart over `columnIndexes` of it.
 *
 * Returns the y-axis title read back from the LIVE chart instance, so an option that was
 * never re-applied after a confirm would fail here rather than pass on the module's output.
 */
async function mountChart(
  annotations: string[],
  columnIndexes: number[],
): Promise<{ yAxisName: () => string | undefined; card: ChartCardModel }> {
  let matrixCardId = -1;
  await act(async () => {
    matrixCardId = store().addMatrixCard([{ name: 'units.csv', matrix: matrix(annotations) }]);
  });
  const matrixId = (store().cards.find((entry) => entry.id === matrixCardId) as {
    sources: Array<{ matrixId: number }>;
  }).sources[0].matrixId;

  let chartId: number | null = null;
  await act(async () => {
    chartId = store().addChartCard(matrixCardId, columnIndexes[0], 'line');
  });
  const chartCardId = chartId as unknown as number;
  await act(async () => {
    for (const index of columnIndexes.slice(1)) {
      store().addChartSource(chartCardId, matrixId, index);
    }
  });

  const card = store().cards.find((entry) => entry.id === chartCardId) as ChartCardModel;
  // The chart must plot exactly the requested columns, or the assertion proves nothing.
  expect(card.config.sources.map((source) => source.columnIndex)).toEqual(columnIndexes);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <ChartCard
        card={card}
        active
        closeBlocked={false}
        onClose={() => {}}
        onCloseBlocked={() => {}}
        onActivate={() => {}}
      />,
    );
  });
  await settle();

  const yAxisName = (): string | undefined => {
    const plot = host.querySelector<HTMLElement>('.chart-card__plot');
    const namespace = (window as unknown as { echarts?: { getInstanceByDom: (el: unknown) => unknown } })
      .echarts;
    expect(namespace, 'echarts was never loaded').toBeDefined();
    const instance = namespace!.getInstanceByDom(plot) as
      | { getOption: () => { yAxis?: Array<{ name?: string }> } }
      | undefined;
    expect(instance, 'the chart instance was never created').toBeDefined();
    return instance!.getOption().yAxis?.[0]?.name;
  };

  return { yAxisName, card };
}

describe('chart y-axis unit', () => {
  it('states the unit when every plotted column resolves to the same recognized unit', async () => {
    const { yAxisName } = await mountChart(['pressure_kpa', 'tensile_kpa'], [0, 1]);
    expect(yAxisName()).toBe('Value (kPa)');
  });

  it('leaves the axis plain when the plotted columns disagree', async () => {
    // kPa and bar are both pressure, but the axis cannot claim either one.
    const { yAxisName } = await mountChart(['pressure_kpa', 'pressure_bar'], [0, 1]);
    expect(yAxisName()).toBe('Value');
  });

  it('leaves the axis plain when a plotted column is ambiguous', async () => {
    // `current_a` is a single letter: still waiting for the user (decision §二).
    const { yAxisName } = await mountChart(['current_a'], [0]);
    expect(yAxisName()).toBe('Value');
  });

  it('states the unit without any confirmation when the token is unambiguous', async () => {
    // No confirm was ever given here: `pressure_kpa` is recognized by the resolver alone.
    const { yAxisName } = await mountChart(['pressure_kpa'], [0]);
    expect(yAxisName()).toBe('Value (kPa)');
    expect(Object.keys(store().unitConfirmations)).toEqual([]);
  });
});