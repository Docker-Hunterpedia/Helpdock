import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio, relativeLuminance } from './contrast.js';
import { tokens } from './tokens.js';
import { STATUS_NAMES, type ThemeMode } from './tokens.schema.js';

const MODES: readonly ThemeMode[] = ['light', 'dark'];

describe('relativeLuminance', () => {
  it('matches the WCAG endpoints', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
  });

  it('matches the published sRGB primaries', () => {
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 6);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 6);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#0F766E', '#0F766E')).toBeCloseTo(1, 10);
  });

  it('does not depend on the order of the two colours', () => {
    expect(contrastRatio('#16181C', '#F7F5F0')).toBeCloseTo(
      contrastRatio('#F7F5F0', '#16181C'),
      10,
    );
  });
});

/**
 * Every pair DESIGN §2.2 claims to have checked, in both modes. The document
 * quotes light-mode ratios; the assertions below are the AA minimums, so a
 * token may only move in the safe direction.
 */
describe.each(MODES)('AA contrast in %s mode', (mode) => {
  const semantic = tokens.semantic[mode];

  it.each([
    ['text.primary', 'bg.canvas'],
    ['text.secondary', 'bg.canvas'],
    ['text.primary', 'bg.surface'],
    ['text.secondary', 'bg.surface'],
    ['action.primary.text', 'action.primary'],
    ['text.link', 'bg.canvas'],
    ['text.inverse', 'bg.inverse'],
  ] as const)('%s on %s', (foreground, background) => {
    expect(contrastRatio(semantic[foreground], semantic[background])).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });

  it.each(STATUS_NAMES)('status.%s.text on its tint', (name) => {
    expect(
      contrastRatio(semantic[`status.${name}.text`], semantic[`status.${name}.tint`]),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('the ratios DESIGN §2.2 quotes for light mode', () => {
  const light = tokens.semantic.light;

  it.each([
    ['text.primary on bg.canvas', light['text.primary'], light['bg.canvas'], 15.9],
    ['text.secondary on bg.canvas', light['text.secondary'], light['bg.canvas'], 6.4],
    [
      'action.primary.text on action.primary',
      light['action.primary.text'],
      light['action.primary'],
      5.2,
    ],
    ['text.link on bg.canvas', light['text.link'], light['bg.canvas'], 4.8],
  ])('%s is at least the quoted ratio', (_name, foreground, background, quoted) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(quoted);
  });
});
