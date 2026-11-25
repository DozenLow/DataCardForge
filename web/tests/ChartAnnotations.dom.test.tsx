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
});
