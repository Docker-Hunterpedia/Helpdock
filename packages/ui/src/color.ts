/**
 * sRGB, OKLCH and WCAG maths. Hand-written rather than pulled from a colour
 * library because the brand resolver and the contrast tests are the only
 * callers and both must stay dependency-free for the widget bundle.
 *
 * OKLCH conversion follows Björn Ottosson's original matrices; WCAG 2.1
 * relative luminance follows the definition in the specification.
 */

export interface Oklch {
  /** Perceptual lightness, 0 (black) to 1 (white). */
  readonly l: number;
  /** Chroma, 0 (grey) upwards. Around 0.37 is the sRGB maximum. */
  readonly c: number;
  /** Hue angle in degrees, 0–360. */
  readonly h: number;
}

/** Red, green and blue as 0–1 fractions. */
export type Rgb = readonly [number, number, number];

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export class InvalidColorError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(`Not a hex colour: ${JSON.stringify(value)}`);
    this.name = 'InvalidColorError';
    this.value = value;
  }
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Parses `#rgb` or `#rrggbb`, with or without the hash. */
export function parseHex(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match?.[1]) {
    throw new InvalidColorError(hex);
  }

  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  const value = Number.parseInt(full, 16);

  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** Formats 0–1 channels as an upper-case `#rrggbb`, clamping out-of-gamut values. */
export function formatHex(rgb: Rgb): string {
  const channels = rgb.map((channel) =>
    Math.round(clamp01(channel) * 255)
      .toString(16)
      .padStart(2, '0'),
  );

  return `#${channels.join('')}`.toUpperCase();
}

/** Undoes the sRGB transfer function for one 0–1 channel. */
export const srgbToLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const toGamma = (channel: number): number =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);

  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const bb = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;

  const c = Math.hypot(a, bb);
  // Below this chroma the hue angle is numerical noise, so report a grey.
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;

  return { l, c, h };
}

export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const bb = c * Math.sin(radians);

  const long = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;

  return [
    toGamma(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    toGamma(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    toGamma(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}

export const hexToOklch = (hex: string): Oklch => rgbToOklch(parseHex(hex));

const GAMUT_EPSILON = 1e-4;

const isInGamut = (rgb: Rgb): boolean =>
  rgb.every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);

/**
 * Reduces chroma until the colour fits inside sRGB, keeping lightness and hue.
 * Without this, moving a saturated colour towards black leaves the gamut and a
 * plain clamp would shift its hue: teal500 at −0.12 L clamps to a greener
 * `#00534C` instead of staying on the teal ramp.
 */
export function clampToGamut(oklch: Oklch): Oklch {
  if (isInGamut(oklchToRgb(oklch))) {
    return oklch;
  }

  let inside = 0;
  let outside = oklch.c;
  for (let step = 0; step < 24; step += 1) {
    const middle = (inside + outside) / 2;
    if (isInGamut(oklchToRgb({ ...oklch, c: middle }))) {
      inside = middle;
    } else {
      outside = middle;
    }
  }

  return { ...oklch, c: inside };
}

/** Converts back to sRGB, reducing chroma first if the colour is out of gamut. */
export const oklchToHex = (oklch: Oklch): string => formatHex(oklchToRgb(clampToGamut(oklch)));

/**
 * Moves a colour along the OKLCH lightness axis, keeping hue and chroma.
 * DESIGN §8 derives a brand's hover and active shades this way.
 */
export function shiftLightness(hex: string, delta: number): string {
  const { l, c, h } = hexToOklch(hex);

  return oklchToHex({ l: clamp01(l + delta), c, h });
}

/** Composites `foreground` at `alpha` over the opaque `background`. */
export function mixOver(foreground: string, background: string, alpha: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);

  return formatHex([
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ]);
}
