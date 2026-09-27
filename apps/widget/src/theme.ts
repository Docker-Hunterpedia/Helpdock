import type { ColorScheme, WidgetTheme } from './transport/types.js';

/** `bg.canvas` → `--hd-bg-canvas`, the names `packages/ui` `tokensToCss` emits. */
export const cssName = (token: string): string =>
  `--hd-${token.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/**
 * Only values the server resolved from the brand's stored choices reach here,
 * but they end up inside a stylesheet, so anything that could close the
 * declaration or open a new rule is dropped rather than escaped.
 */
const SAFE_VALUE = /^[^;{}<>\\]*$/;

function declarations(entries: Iterable<[string, string]>): string {
  return [...entries]
    .filter(([, value]) => SAFE_VALUE.test(value))
    .map(([name, value]) => `${name}:${value};`)
    .join('');
}

/** The `:host` block that paints the widget in one scheme (DESIGN §8). */
export function themeCss(theme: WidgetTheme, scheme: ColorScheme, rtl: boolean): string {
  const tokens = Object.entries(theme.tokens[scheme]).map(
    ([token, value]) => [cssName(token), value] as [string, string],
  );
  const fonts = theme.font_family;

  return `:host{${declarations([
    ...tokens,
    ['--hd-radius-md', `${theme.radius.md}px`],
    ['--hd-radius-lg', `${theme.radius.lg}px`],
    ['--hd-font-sans', rtl ? fonts.arabic : fonts.sans],
    ['--hd-font-mono', fonts.mono],
    ['color-scheme', scheme],
  ])}}`;
}

export function resolveScheme(mode: WidgetTheme['mode'], prefersDark: boolean): ColorScheme {
  if (mode === 'auto') {
    return prefersDark ? 'dark' : 'light';
  }
  return mode;
}

/**
 * Fonts cannot be declared inside a shadow root, so the brand's self-hosted
 * files are added to the document through the FontFace API. A font that fails
 * to load leaves the system fallback in place, which is harmless.
 */
export function registerFonts(theme: WidgetTheme, fonts: FontFaceSet | undefined): void {
  if (!fonts || typeof FontFace === 'undefined') {
    return;
  }
  for (const file of theme.fonts) {
    const face = new FontFace(file.family, `url(${JSON.stringify(file.url)}) format('woff2')`, {
      weight: String(file.weight),
      display: 'swap',
      ...(file.unicode_range ? { unicodeRange: file.unicode_range } : {}),
    });
    fonts.add(face);
    face.load().catch(() => undefined);
  }
}
