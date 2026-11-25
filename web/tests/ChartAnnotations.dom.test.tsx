// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import * as echarts from 'echarts';

import { buildOption, type BuildContext } from '../src/charts/chartOptions.ts';
import { chartToSvgString } from '../src/charts/export.ts';
import { defaultChartConfig } from '../src/charts/chartModel.ts';
import { DEFAULT_SMOOTHING } from '../src/core/Smoothing.ts';

const instances: echarts.ECharts[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  document.body.replaceChildren();
});

describe('chart annotation SVG export', () => {
  it('serializes reference lines, interval shading, limit points and labels as vectors', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 640 });
    Object.defineProperty(container, 'clientHeight', { value: 420 });
    document.body.appendChild(container);

    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 640,
      height: 420,
    });
    instances.push(chart);

    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    const config = {
      ...defaultChartConfig('line', [
        { matrixId: 1, columnIndex: 0, label: 'Signal', raw: [1, 7, 2] },
      ]),
      referenceLines: [{ id: 'line', axis: 'y' as const, value: 5, label: 'Limit' }],
      acceptedRanges: [
        { id: 'area', axis: 'y' as const, lower: 1.5, upper: 2.5, label: 'Accepted' },
      ],
      limitRange: { axis: 'y' as const, lower: 0, upper: 5 },
      pointLabels: 'value' as const,
    };
    chart.setOption(buildOption({ config, smoothing: DEFAULT_SMOOTHING, strings }));

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('Limit');
    expect(svg).toContain('Accepted');
  });

  it('aligns 2x2 panel pixels and exports all panels in one SVG', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 640 });
    Object.defineProperty(container, 'clientHeight', { value: 420 });
    document.body.appendChild(container);
    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 640,
      height: 420,
    });
    instances.push(chart);
    const config = {
      ...defaultChartConfig('line', [
        { matrixId: 1, columnIndex: 0, label: 'First', raw: [1, 2, 3] },
        { matrixId: 1, columnIndex: 1, label: 'Second', raw: [3, 2, 1] },
      ]),
      composition: {
        columns: 2 as const,
        shareXTicks: true,
        shareXRange: true,
        panels: ['A', 'B', 'C', 'D'].map((label, index) => ({
          id: label.toLowerCase(),
          label,
          type: 'line' as const,
          sources: [{ matrixId: 1, columnIndex: index % 2 }],
        })),
      },
    };
    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    chart.setOption(buildOption({ config, smoothing: DEFAULT_SMOOTHING, strings }));

    const model = (
      chart as unknown as {
        getModel: () => {
          getComponent: (
            mainType: string,
            index: number,
          ) => { coordinateSystem: { getRect: () => { x: number; width: number } } };
        };
      }
    ).getModel();
    const gridRect = (index: number) =>
      model.getComponent('grid', index).coordinateSystem.getRect();

    expect(gridRect(0).x).toBeCloseTo(gridRect(2).x, 5);
    expect(gridRect(1).x).toBeCloseTo(gridRect(3).x, 5);
    expect(gridRect(0).width).toBeCloseTo(gridRect(2).width, 5);
    expect(gridRect(1).width).toBeCloseTo(gridRect(3).width, 5);

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg).not.toContain('<image');
    for (const label of ['A', 'B', 'C', 'D']) expect(svg).toContain(`>${label}<`);
  });

  it('exports field cells, contours, and the colourbar unit as SVG', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 640 });
    Object.defineProperty(container, 'clientHeight', { value: 420 });
    document.body.appendChild(container);
    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 640,
      height: 420,
    });
    instances.push(chart);
    const config = {
      ...defaultChartConfig('heatmap', [
        { matrixId: 1, columnIndex: 0, label: 'Temperature', raw: [0, 1, 0, 1] },
        { matrixId: 1, columnIndex: 1, label: 'Field', raw: [0, 0, 1, 1] },
        { matrixId: 1, columnIndex: 2, label: 'Signal_K', raw: [1, 2, 2, 3] },
      ]),
      heatmapMode: 'field' as const,
      showFieldContours: true,
      fieldColorRange: { min: 0, max: 4 },
    };
    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    chart.setOption(
      buildOption({
        config,
        smoothing: DEFAULT_SMOOTHING,
        strings,
        colorAxisUnit: 'K',
      }),
    );

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('K');
    expect(svg).toContain('<path');
  });

  it('exports categorical factor series and legend labels as SVG', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 640 });
    Object.defineProperty(container, 'clientHeight', { value: 420 });
    document.body.appendChild(container);
    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 640,
      height: 420,
    });
    instances.push(chart);
    const config = {
      ...defaultChartConfig('scatter', [
        { matrixId: 1, columnIndex: 0, label: 'X', raw: [1, 2, 3, 4] },
        { matrixId: 1, columnIndex: 1, label: 'Y', raw: [4, 8, 5, 9] },
      ]),
      showFitLine: false,
      factorSource: {
        matrixId: 1,
        columnIndex: 2,
        label: 'group',
        raw: [0, 1, 0, 1],
        categories: ['control', 'treated'],
      },
      factorMapping: { color: true, shape: true, facet: false, heatmapStrip: false },
    };
    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    chart.setOption(buildOption({ config, smoothing: DEFAULT_SMOOTHING, strings }));

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('control');
    expect(svg).toContain('treated');
  });

  it('renders a heatmap factor annotation strip with vector shapes', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 500 });
    Object.defineProperty(container, 'clientHeight', { value: 400 });
    document.body.appendChild(container);
    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 500,
      height: 400,
    });
    instances.push(chart);
    const config = {
      ...defaultChartConfig('heatmap', [
        { matrixId: 1, columnIndex: 0, label: 'A', raw: [1, 2, 3] },
        { matrixId: 1, columnIndex: 1, label: 'B', raw: [3, 2, 1] },
      ]),
      factorSource: {
        matrixId: 1,
        columnIndex: 2,
        label: 'group',
        raw: [0, 1],
        categories: ['control', 'treated'],
      },
      factorMapping: { color: false, shape: false, facet: false, heatmapStrip: true },
    };
    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    chart.setOption(buildOption({ config, smoothing: DEFAULT_SMOOTHING, strings }));

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('<path');
    expect(chart.getOption().series).toHaveLength(2);
  });

  it('exports backend fit bands and all four diagnostic panels without raster images', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 720 });
    Object.defineProperty(container, 'clientHeight', { value: 520 });
    document.body.appendChild(container);
    const chart = echarts.init(container, undefined, {
      renderer: 'svg',
      width: 720,
      height: 520,
    });
    instances.push(chart);
    const config = {
      ...defaultChartConfig('regression', [
        { matrixId: 1, columnIndex: 0, label: 'X', raw: [1, 2, 3, 4] },
        { matrixId: 1, columnIndex: 1, label: 'Y', raw: [2, 4.2, 5.7, 8.1] },
      ]),
      analysis: {
        model: 'linear' as const,
        throughOrigin: false,
        weighting: 'none' as const,
        initial: null,
        lower: null,
        upper: null,
        confidence: 0.95 as const,
        bands: 'both' as const,
      },
      showAnalysisDiagnostics: true,
    };
    const analysis = {
      summary: {
        n: 4,
        r2: 0.98,
        residualStandardError: 0.5,
        lod: 0.825,
        loq: 2.5,
      },
      x: [1, 2, 3, 4],
      y: [2, 4.2, 5.7, 8.1],
      fitted: [2, 4, 6, 8],
      residual: [0, 0.2, -0.3, 0.1],
      standardizedResidual: [0, 0.4, -0.6, 0.2],
      confidenceLower: [1.8, 3.7, 5.6, 7.5],
      confidenceUpper: [2.2, 4.3, 6.4, 8.5],
      predictionLower: [1.5, 3.4, 5.3, 7.2],
      predictionUpper: [2.5, 4.6, 6.7, 8.8],
      qqTheoretical: [-1.2, -0.3, 0.3, 1.2],
      qqResidual: [-0.3, 0, 0.1, 0.2],
    };
    const strings: BuildContext['strings'] = {
      rowIndex: 'No.',
      value: 'Value',
      count: 'Count',
      density: 'Density',
      binCentre: 'Bin centre',
      correlation: 'r',
      quartiles: 'IQR',
      mean: 'Mean',
      outliers: 'Outliers',
      secondAxis: 'Second',
      drawnOfTotal: (drawn, total) => `Drawn ${drawn} / total ${total}`,
    };
    chart.setOption(
      buildOption({ config, smoothing: DEFAULT_SMOOTHING, strings, analysis }),
    );

    const svg = chartToSvgString(container, '#ffffff');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('A · Fit');
    expect(svg).toContain('D · QQ');
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
  });
});
