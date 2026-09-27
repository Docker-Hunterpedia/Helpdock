/**
 * `@helpdock/ui/resolve`: the brand resolver without the MUI theme or the RTL
 * caches, for a server that turns a brand's stored choices into tokens (the
 * widget config, M4-06) and must not load React to do it.
 */
export type {
  BrandAccent,
  BrandFont,
  BrandMode,
  BrandThemeInput,
  ResolvedBrandTheme,
} from './brand.js';
export { BRAND_FONTS, resolveBrandTheme } from './brand.js';
export type { FontFaceRule } from './font-faces.js';
export { FONT_FACES } from './font-faces.js';
export { resolveSemanticTokens } from './semantic.js';
