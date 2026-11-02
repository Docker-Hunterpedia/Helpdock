import { describe, expect, it } from 'vitest';
import { heatmapColour, heatmapThresholds } from './heatmap-scale.js';

const light = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'] as const;
const dark = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'] as const;

describe('heatmapColour', () => {
  const thresholds = heatmapThresholds(30);

  it('draws zero as the neutral cell in both themes, never a step of the scale', () => {
    expect(heatmapColour(0, thresholds, light, 'muted')).toBe('muted');
    expect(heatmapColour(0, thresholds, dark, 'muted')).toBe('muted');
  });

  it('rises with the count: the busiest cell takes the last step', () => {
    expect(heatmapColour(1, thresholds, light, 'muted')).toBe('l0');
    expect(heatmapColour(30, thresholds, light, 'muted')).toBe('l5');
    expect(heatmapColour(30, thresholds, dark, 'muted')).toBe('d5');
    const steps = [1, 6, 11, 16, 21, 26].map((count) =>
      light.indexOf(heatmapColour(count, thresholds, light, 'muted') as (typeof light)[number]),
    );
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});
