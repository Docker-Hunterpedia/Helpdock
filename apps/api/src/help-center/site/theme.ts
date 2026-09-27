import { HC_THEME_DEFAULTS, type HcTheme } from '@helpdock/schemas';
import { tokensCssBundle } from '@helpdock/ui/css';
import { resolveBrandTheme, validateBrandTheme } from '@helpdock/ui/resolve';

/**
 * A brand's help center theme (M5-06, DESIGN §8) as the `--hd-*` stylesheet
 * its pages start from: `resolveBrandTheme` derives the accent's hover,
 * active, tint and text colours, the surface tone's ramp, the radius scale
 * and the font pair, and `tokensCssBundle` writes them for light and dark.
 *
 * A theme is a handful of values shared by every page of a brand, so each
 * distinct one is resolved once per process.
 */

const cache = new Map<string, string>();
const CACHE_MAX = 200;

export const themeStylesheet = (theme: HcTheme): string => {
  const key = JSON.stringify(theme);
  const found = cache.get(key);
  if (found !== undefined) {
    return found;
  }
  let css: string;
  try {
    css = tokensCssBundle(resolveBrandTheme(theme));
  } catch {
    // A stored theme the resolver no longer accepts renders as the default.
    css = tokensCssBundle(resolveBrandTheme(HC_THEME_DEFAULTS));
  }
  if (cache.size >= CACHE_MAX) {
    cache.clear();
  }
  cache.set(key, css);
  return css;
};

/** Whether the admin may save this theme: DESIGN §8 blocks an accent below 3:1 on the surface. */
export const themeContrastError = (theme: HcTheme): boolean =>
  validateBrandTheme(theme).some((problem) => problem.severity === 'error');
