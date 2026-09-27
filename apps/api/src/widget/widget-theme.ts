import type { WidgetAppearance, WidgetLocale, WidgetTheme } from '@helpdock/schemas';
import { FONT_FACES, resolveBrandTheme, resolveSemanticTokens } from '@helpdock/ui/resolve';

/**
 * The widget's theme (M4-06), resolved here so the widget ships no colour
 * maths: DESIGN §8's brand resolver turns the Widget tab's accent and colour
 * scheme into the semantic tokens of both schemes, and the widget writes them
 * into its shadow root as `--hd-*` properties.
 *
 * The brand does not pick a font or a radius on the Widget tab, so both are
 * the design system's defaults. The fonts are the files `packages/ui/fonts`
 * ships, which the widget build copies to `widget-fonts/` and the api serves
 * from its own origin (`widget-bundle.controller.ts`).
 */

/** Where the widget's font files are served, under the api's origin. */
export const WIDGET_FONTS_PATH = '/widget-fonts';

export const widgetThemeOf = (appearance: WidgetAppearance, assetOrigin: string): WidgetTheme => {
  const brand = resolveBrandTheme({ accent: appearance.accent, mode: appearance.colorScheme });
  const origin = assetOrigin.replace(/\/$/, '');

  return {
    colorScheme: appearance.colorScheme,
    tokens: {
      light: { ...resolveSemanticTokens('light', brand) },
      dark: { ...resolveSemanticTokens('dark', brand) },
    },
    radius: { md: brand.radius.md, lg: brand.radius.lg },
    fontFamily: { ...brand.fontFamily },
    fonts: FONT_FACES.map((face) => ({
      family: face.family,
      weight: face.weight,
      url: `${origin}${WIDGET_FONTS_PATH}/${face.file}`,
      unicodeRange: face.unicodeRange,
    })),
    launcher: { style: appearance.launcher, label: null, position: appearance.position },
  };
};

/** The greeting in `locale`: the Arabic falls back to the English, and empty is none. */
export const greetingIn = (appearance: WidgetAppearance, locale: WidgetLocale): string | null => {
  const greeting =
    locale === 'ar' && appearance.greetingAr !== '' ? appearance.greetingAr : appearance.greetingEn;
  return greeting === '' ? null : greeting;
};
