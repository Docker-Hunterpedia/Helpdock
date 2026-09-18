import createCache, { type EmotionCache } from '@emotion/cache';
import rtlPlugin from '@mui/stylis-plugin-rtl';
import { type Middleware, prefixer } from 'stylis';

/**
 * Setting `stylisPlugins` replaces Emotion's defaults, so `prefixer` has to be
 * listed again or vendor prefixes disappear. This is MUI 9's documented RTL
 * setup.
 */
export const RTL_STYLIS_PLUGINS: readonly Middleware[] = [prefixer, rtlPlugin];

/**
 * Emotion caches for the two directions (DESIGN §7). Wrap the app in
 * `<CacheProvider value={cache}>` and give `createHelpdockTheme` the matching
 * `direction`; `dir` on `<html>` comes from the locale.
 *
 * Mirroring is a safety net for the third-party rules MUI still emits with
 * physical properties. Helpdock's own styles use logical properties, which need
 * no plugin at all.
 */
export function createRtlCache(key = 'hdrtl'): EmotionCache {
  return createCache({ key, stylisPlugins: [...RTL_STYLIS_PLUGINS] });
}

export function createLtrCache(key = 'hd'): EmotionCache {
  return createCache({ key });
}
