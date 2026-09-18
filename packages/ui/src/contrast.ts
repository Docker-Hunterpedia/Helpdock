import { parseHex, srgbToLinear } from './color.js';

/**
 * WCAG 2.1 relative luminance, from the definition in the specification:
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);

  return (
    0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2])
  );
}

/**
 * WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). The order of
 * the two colours does not matter.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** AA for body text and for any UI text below 24 px (DESIGN §10). */
export const AA_TEXT = 4.5;

/** AA for text at 24 px or larger, and for the brand accent against its surface. */
export const AA_LARGE_TEXT = 3;
