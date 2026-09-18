import { describe, expect, it } from 'vitest';
import { BRAND_FONTS, BrandThemeError, resolveBrandTheme, validateBrandTheme } from './brand.js';
import { hexToOklch, mixOver } from './color.js';
import { AA_TEXT, contrastRatio } from './contrast.js';
import { tokens } from './tokens.js';

/** Contrast against white is 3.74:1 — enough for the surface, not for text. */
const FLIPS_TO_N900 = '#0D9488';
/** Contrast against white is 1.44:1, below the 3:1 DESIGN §8 blocks at. */
const FAILS_ON_LIGHT_SURFACE = '#FFD166';
/** A mid grey: light enough that white fails on it, dark enough that n900 does too. */
const NO_READABLE_TEXT = '#7A7A7A';

describe('resolveBrandTheme defaults', () => {
  it('falls back to every default in DESIGN §8', () => {
    const brand = resolveBrandTheme();

    expect(brand.accent.light.base).toBe(tokens.palette.teal.teal500);
    expect(brand.surfaceTone).toBe('warm');
    expect(brand.radius.md).toBe(tokens.radius.md);
    expect(brand.font).toBe('ibm-plex');
    expect(brand.mode).toBe('auto');
  });

  it('normalises a short, lower-case accent', () => {
    expect(resolveBrandTheme({ accent: '#abc' }).accent.light.base).toBe('#AABBCC');
    expect(resolveBrandTheme({ accent: '0f766e' }).accent.light.base).toBe('#0F766E');
  });
});

describe('accent derivation', () => {
  it('derives hover and active by −0.06 and −0.12 OKLCH lightness', () => {
    const { light } = resolveBrandTheme({ accent: '#0F766E' }).accent;
    const base = hexToOklch(light.base).l;

    // Two places: rounding back to 8-bit sRGB moves lightness by up to 0.001.
    expect(hexToOklch(light.hover).l).toBeCloseTo(base - 0.06, 2);
    expect(hexToOklch(light.active).l).toBeCloseTo(base - 0.12, 2);
  });

  it('lifts the accent for dark mode, as teal500 pairs with teal300', () => {
    const { dark } = resolveBrandTheme({ accent: '#0F766E' }).accent;

    expect(hexToOklch(dark.base).l).toBeCloseTo(hexToOklch('#0F766E').l + 0.21, 2);
    expect(contrastRatio(dark.base, tokens.semantic.dark['bg.surface'])).toBeGreaterThan(
      contrastRatio('#0F766E', tokens.semantic.dark['bg.surface']),
    );
  });

  it('puts white on an accent that carries it', () => {
    const { light } = resolveBrandTheme({ accent: '#0F766E' }).accent;

    expect(light.text).toBe('#FFFFFF');
    expect(light.contrastOnAccent).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('flips to n900 when white would not reach AA', () => {
    const { light } = resolveBrandTheme({ accent: FLIPS_TO_N900 }).accent;

    expect(contrastRatio('#FFFFFF', FLIPS_TO_N900)).toBeLessThan(AA_TEXT);
    expect(light.text).toBe(tokens.palette.surfaceTone.warm.n900);
    expect(light.contrastOnAccent).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('takes n900 from the chosen ramp, not always the warm one', () => {
    const cool = resolveBrandTheme({ accent: FLIPS_TO_N900, surfaceTone: 'cool' });

    expect(cool.accent.light.text).toBe(tokens.palette.surfaceTone.cool.n900);
  });

  it('mixes the tint at 10 % over the surface of each mode', () => {
    const brand = resolveBrandTheme({ accent: '#0F766E' });

    expect(brand.accent.light.tint).toBe(
      mixOver('#0F766E', tokens.semantic.light['bg.surface'], 0.1),
    );
    expect(brand.accent.dark.tint).toBe(
      mixOver(brand.accent.dark.base, tokens.semantic.dark['bg.surface'], 0.1),
    );
  });

  it('reports the contrast the admin shows next to the colour picker', () => {
    const { light } = resolveBrandTheme({ accent: '#0F766E' }).accent;

    expect(light.contrastOnSurface).toBeCloseTo(
      contrastRatio('#0F766E', tokens.semantic.light['bg.surface']),
      10,
    );
  });
});

describe('surfaceTone', () => {
  it.each(['warm', 'neutral', 'cool'] as const)('returns the %s ramp', (tone) => {
    expect(resolveBrandTheme({ surfaceTone: tone }).neutral).toEqual(
      tokens.palette.surfaceTone[tone],
    );
  });
});

describe('radius', () => {
  it('scales md and lg proportionally and leaves full alone', () => {
    expect(resolveBrandTheme({ radius: 12 }).radius).toEqual({
      sm: tokens.radius.sm,
      md: 12,
      lg: 20,
      xl: tokens.radius.xl,
      full: 999,
    });
  });

  it('squares the corners at 0', () => {
    const radius = resolveBrandTheme({ radius: 0 }).radius;

    expect(radius.md).toBe(0);
    expect(radius.lg).toBe(0);
    expect(radius.full).toBe(999);
  });

  it('rejects a value outside 0–12', () => {
    expect(() => resolveBrandTheme({ radius: 13 })).toThrow(BrandThemeError);
    expect(validateBrandTheme({ radius: -1 })).toEqual([
      expect.objectContaining({ field: 'radius', code: 'radius.out-of-range', severity: 'error' }),
    ]);
  });
});

describe('font', () => {
  it.each(Object.keys(BRAND_FONTS) as Array<keyof typeof BRAND_FONTS>)(
    'resolves the %s stack',
    (font) => {
      expect(resolveBrandTheme({ font }).fontFamily.sans).toBe(BRAND_FONTS[font].sans);
    },
  );

  it('rejects a font outside the curated list', () => {
    expect(validateBrandTheme({ font: 'https://evil.example/font.css' })).toEqual([
      expect.objectContaining({ field: 'font', code: 'font.unknown' }),
    ]);
  });
});

describe('validateBrandTheme', () => {
  it('passes the stock brand', () => {
    expect(validateBrandTheme({})).toEqual([]);
  });

  it('blocks an accent below 3:1 against the light surface', () => {
    const problems = validateBrandTheme({ accent: FAILS_ON_LIGHT_SURFACE, mode: 'light' });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      field: 'accent',
      code: 'accent.contrast-below-minimum',
      severity: 'error',
      mode: 'light',
    });
    expect(problems[0]?.ratio).toBeLessThan(3);
  });

  it('checks both modes when the brand is on auto', () => {
    const problems = validateBrandTheme({ accent: FAILS_ON_LIGHT_SURFACE });

    expect(problems.map((problem) => problem.mode)).toEqual(['light']);
  });

  it('does not block an accent that only flips its text colour', () => {
    expect(validateBrandTheme({ accent: FLIPS_TO_N900 })).toEqual([]);
  });

  it('reports a malformed accent as an error rather than throwing', () => {
    expect(validateBrandTheme({ accent: 'teal' })).toEqual([
      expect.objectContaining({ field: 'accent', code: 'accent.invalid', severity: 'error' }),
    ]);
  });

  it('warns when neither white nor n900 reaches AA on the accent', () => {
    const problems = validateBrandTheme({ accent: NO_READABLE_TEXT, mode: 'light' });

    expect(problems).toEqual([
      expect.objectContaining({
        field: 'accent',
        code: 'accent.text-contrast-below-aa',
        severity: 'warning',
        mode: 'light',
      }),
    ]);
  });
});
