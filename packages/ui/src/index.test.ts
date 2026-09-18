import { describe, expect, it } from 'vitest';
import * as ui from './index.js';

/**
 * The barrel is the contract with the admin app, the help center and the
 * widget, none of which exist yet to break the build when a name moves.
 */
const PUBLIC_API = [
  'AA_LARGE_TEXT',
  'AA_TEXT',
  'BRAND_FONTS',
  'BRAND_FONT_NAMES',
  'BRAND_MODES',
  'BrandThemeError',
  'ELEVATION_LEVELS',
  'InvalidColorError',
  'NEUTRAL_STEPS',
  'SEMANTIC_TOKEN_NAMES',
  'STATUS_NAMES',
  'SURFACE_TONES',
  'TEAL_STEPS',
  'TYPE_STYLES',
  'brandThemeInputSchema',
  'clampToGamut',
  'contrastRatio',
  'createHelpdockTheme',
  'createLtrCache',
  'createRtlCache',
  'designTokensSchema',
  'formatHex',
  'hexToOklch',
  'mixOver',
  'oklchToHex',
  'oklchToRgb',
  'parseHex',
  'relativeLuminance',
  'resolveBrandTheme',
  'resolveSemanticTokens',
  'rgbToOklch',
  'shiftLightness',
  'srgbToLinear',
  'tokens',
  'tokensCssBundle',
  'tokensToCss',
  'validateBrandTheme',
];

describe('@helpdock/ui', () => {
  it('exports exactly the documented public API', () => {
    expect(Object.keys(ui).sort()).toEqual(PUBLIC_API);
  });
});
