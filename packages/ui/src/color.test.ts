import { describe, expect, it } from 'vitest';
import {
  clampToGamut,
  formatHex,
  hexToOklch,
  InvalidColorError,
  mixOver,
  oklchToHex,
  oklchToRgb,
  parseHex,
  shiftLightness,
} from './color.js';

describe('parseHex', () => {
  it('reads six digits, three digits and a missing hash', () => {
    expect(parseHex('#FFFFFF')).toEqual([1, 1, 1]);
    expect(parseHex('#000')).toEqual([0, 0, 0]);
    expect(parseHex('0F766E')).toEqual(parseHex('#0f766e'));
  });

  it('rejects anything else', () => {
    expect(() => parseHex('teal')).toThrow(InvalidColorError);
    expect(() => parseHex('#12345')).toThrow(InvalidColorError);
  });

  it('never puts the rejected value in the message unescaped', () => {
    expect(() => parseHex('nope')).toThrow('Not a hex colour: "nope"');
  });
});

describe('formatHex', () => {
  it('clamps out-of-range channels and upper-cases the result', () => {
    expect(formatHex([-1, 0.5, 2])).toBe('#0080FF');
  });
});

/**
 * The expected values are the ones published with the OKLab colour space, so
 * they check the matrices rather than restating this implementation.
 * https://bottosson.github.io/posts/oklab/
 */
describe('hexToOklch', () => {
  it.each([
    ['#FF0000', 0.6279554, 0.2576833, 29.2339],
    ['#0000FF', 0.4520137, 0.3132145, 264.052],
  ])('converts %s to the published OKLCH values', (hex, l, c, h) => {
    const oklch = hexToOklch(hex);

    expect(oklch.l).toBeCloseTo(l, 6);
    expect(oklch.c).toBeCloseTo(c, 6);
    expect(oklch.h).toBeCloseTo(h, 3);
  });

  it('reports white as fully light and achromatic', () => {
    const white = hexToOklch('#FFFFFF');

    expect(white.l).toBeCloseTo(1, 6);
    expect(white.c).toBeCloseTo(0, 6);
    expect(white.h).toBe(0);
  });

  it('round-trips every step of the teal ramp', () => {
    for (const hex of ['#ECF7F5', '#5FB8AC', '#0F766E', '#05231F']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });
});

describe('clampToGamut', () => {
  it('leaves an in-gamut colour alone', () => {
    const teal = hexToOklch('#0F766E');

    expect(clampToGamut(teal)).toEqual(teal);
  });

  it('reduces chroma instead of letting a channel clip', () => {
    const impossible = { l: 0.3, c: 0.3, h: 150 };

    const mapped = clampToGamut(impossible);

    expect(mapped.c).toBeLessThan(impossible.c);
    expect(mapped.l).toBe(impossible.l);
    expect(mapped.h).toBe(impossible.h);
    for (const channel of oklchToRgb(mapped)) {
      expect(channel).toBeGreaterThanOrEqual(-1e-4);
      expect(channel).toBeLessThanOrEqual(1 + 1e-4);
    }
  });
});

describe('shiftLightness', () => {
  it('moves lightness by the delta and keeps the hue', () => {
    const lighter = shiftLightness('#0F766E', 0.21);

    // Rounding back to 8-bit sRGB moves lightness by up to 0.001 and the hue
    // by well under a degree, so neither is asserted exactly.
    expect(hexToOklch(lighter).l).toBeCloseTo(hexToOklch('#0F766E').l + 0.21, 2);
    expect(Math.abs(hexToOklch(lighter).h - hexToOklch('#0F766E').h)).toBeLessThan(1);
  });

  it('lands on the teal ramp step DESIGN pairs with teal500 in dark mode', () => {
    expect(shiftLightness('#0F766E', 0.21)).toBe('#5FB7AD');
  });

  it('clamps at black and white', () => {
    expect(shiftLightness('#FFFFFF', 0.5)).toBe('#FFFFFF');
    expect(shiftLightness('#000000', -0.5)).toBe('#000000');
  });
});

describe('mixOver', () => {
  it('returns the background at 0 and the foreground at 1', () => {
    expect(mixOver('#0F766E', '#FFFFFF', 0)).toBe('#FFFFFF');
    expect(mixOver('#0F766E', '#FFFFFF', 1)).toBe('#0F766E');
  });

  it('composites a 10 % tint over white', () => {
    expect(mixOver('#0F766E', '#FFFFFF', 0.1)).toBe('#E7F1F1');
  });
});
