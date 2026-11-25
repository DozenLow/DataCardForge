/**
 * @vitest-environment jsdom
 *
 * Chart card — what the fit panel actually says (review of the stage-one delivery).
 *
 * The card used to print the backend's wire code, and — worse — turned every refused fit into
 * `internalError outputSchema`: the node answers 200 with `state:"error"`, which the run had
 * treated as success, so it fetched two empty matrices and reported the client's own confusion.
 *
 * These cases read the rendered panel, in Chinese, and demand a sentence a user can act on plus
 * the numbers the backend already computed. They run against the real `ChartCard`, so a wiring
 * mistake between the store's run state and the popup fails here rather than in the browser.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { ChartCardModel } from '../src/ui/types.ts';
import type { ChartAnalysisRun } from '../src/ui/types.ts';
import { ChartCard } from '../src/ui/components/ChartCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no layout and no canvas; ECharts says so loudly while still building its option. */
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

function stubBackend(): () => void {
  const originalFetch = globalThis.fetch;
  let nextMatrixId = 1;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '{"matrixId":1,"revision":1}',
      json: async () => ({ matrixId: nextMatrixId++, revision: 1 }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as Response) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

let restoreFetch: (() => void) | null = null;
let unmute: (() => void) | null = null;
let restoreCanvas: (() => void) | null = null;

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
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

function matrix(): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', [1, 2, 3, 4, 5]);
  mat.setColumnAnnotation(0, 'X');
  mat.appendColumn('Pos.2', [2, 4, 6, 8, 11]);
  mat.setColumnAnnotation(1, 'Y');
  return mat;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * A scatter chart over X/Y with a linear backend fit configured, then the run state the store
 * would hold — injected directly, because the point under test is what the panel does with a
 * finished or refused run, not how the node protocol produces one (the store suite covers it).
 */
async function mountFitPanel(run: ChartAnalysisRun): Promise<string> {
  let matrixCardId = -1;
  await act(async () => {
    matrixCardId = store().addMatrixCard([{ name: 'fit.csv', matrix: matrix() }]);
  });
  // The chart card can only be built once the matrix has been registered (an add is
  // fire-and-forget), and a scatter needs its pair — a line over one column is enough here.
  await settle();
  let chartId = -1;
  await act(async () => {
    chartId = store().addChartCard(matrixCardId, 1, 'line')!;
  });
  expect(chartId, 'the chart card was not created').toBeGreaterThan(0);
  await act(async () => {
    store().setChartConfig(chartId, {
      analysis: {
        model: 'linear',
        throughOrigin: false,
        weighting: 'none',
        initial: null,
        lower: null,
        upper: null,
        confidence: 0.95,
        bands: 'both',
      },
    });
    useWorkspace.setState({ chartAnalyses: { [chartId]: run } });
  });

  const card = store().cards.find((entry) => entry.id === chartId) as ChartCardModel;
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

  // The fit controls live behind the "Axes" popup; opening it is part of the path a user takes.
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button.chart-card__tbutton'));
  const axes = buttons.find((button) => button.textContent?.includes('坐标轴'));
  expect(axes, 'the axes button was not rendered').toBeDefined();
  await act(async () => {
    axes!.click();
  });
  await settle();

  return document.body.textContent ?? '';
}

describe('the fit panel', () => {
  it('says why a refused fit was refused, in words', async () => {
    const text = await mountFitPanel({
      nodeId: 77,
      resultMatrixIds: [101, 102],
      state: 'error',
      code: 'fitFailed',
      params: { reason: 'tooFewPoints' },
    });

    expect(text).toContain('点数不够');
    // The two failure modes this used to report instead of the truth.
    expect(text).not.toContain('outputSchema');
    expect(text).not.toContain('internalError');
    expect(text).not.toContain('tooFewPoints');
  });

  it('shows the fitted numbers, not only R²', async () => {
    const text = await mountFitPanel({
      nodeId: 77,
      resultMatrixIds: [101, 102],
      state: 'done',
      output: {
        summary: {
          n: 5,
          r2: 0.9918,
          slope: 2.2,
          intercept: -0.4,
          residualStandardError: 0.3651,
          lod: 0.5477,
          loq: 1.6598,
        },
        x: [1, 2, 3, 4, 5],
        y: [2, 4, 6, 8, 11],
        fitted: [1.8, 4, 6.2, 8.4, 10.6],
        residual: [0.2, 0, -0.2, -0.4, 0.4],
        standardizedResidual: [0.5, 0, -0.5, -1, 1],
        confidenceLower: [1, 3, 5, 7, 9],
        confidenceUpper: [2, 4, 7, 9, 11],
        predictionLower: [0, 2, 4, 6, 8],
        predictionUpper: [3, 5, 8, 10, 12],
        qqTheoretical: [-1, -0.3, 0, 0.3, 1],
        qqResidual: [-0.4, -0.2, 0, 0.2, 0.4],
      },
    });

    expect(text).toContain('n=5 · R²=0.9918');
    expect(text).toContain('y = 2.2 x − 0.4');
    // Four significant digits are the panel's one number format, so the equation and the
    // limits read the same way.
    expect(text).toContain('LOD=0.5477 · LOQ=1.66');
    // The legend is drawn by ECharts, not by this component, so its names are the ones that
    // used to leak untranslated English into a Chinese UI.
    expect(text).toContain('后端拟合线');
    expect(text).not.toContain('backend fit');
    expect(text).not.toContain('confidence band');
  });

  it('does not report a detection limit of zero for a perfect fit', async () => {
    const text = await mountFitPanel({
      nodeId: 77,
      resultMatrixIds: [101, 102],
      state: 'done',
      output: {
        summary: {
          n: 5,
          r2: 1,
          slope: 1,
          intercept: 0,
          residualStandardError: 0,
          lod: 0,
          loq: 0,
        },
        x: [1, 2, 3, 4, 5],
        y: [1, 2, 3, 4, 5],
        fitted: [1, 2, 3, 4, 5],
        residual: [0, 0, 0, 0, 0],
        standardizedResidual: [0, 0, 0, 0, 0],
        confidenceLower: [1, 2, 3, 4, 5],
        confidenceUpper: [1, 2, 3, 4, 5],
        predictionLower: [1, 2, 3, 4, 5],
        predictionUpper: [1, 2, 3, 4, 5],
        qqTheoretical: [-1, -0.3, 0, 0.3, 1],
        qqResidual: [0, 0, 0, 0, 0],
      },
    });

    expect(text).toContain('估不出来');
    expect(text).not.toContain('LOD=0');
  });
});