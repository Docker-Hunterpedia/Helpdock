import { type Locale, SUPPORTED_LNGS } from '@helpdock/i18n';

/**
 * The two preferences that have to be known before React mounts, so the inline
 * script in `index.html` can set `lang`, `dir` and `color-scheme` without a
 * flash. Both files read these exact strings; `preferences.test.ts` compares
 * them against the HTML.
 */
export const LOCALE_STORAGE_KEY = 'helpdock.admin.locale';
export const THEME_STORAGE_KEY = 'helpdock.admin.theme';

/** What the user chose. `auto` follows `prefers-color-scheme`. */
export const THEME_PREFERENCES = ['light', 'dark', 'auto'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const isLocale = (value: string | null): value is Locale =>
  value !== null && (SUPPORTED_LNGS as readonly string[]).includes(value);

const isThemePreference = (value: string | null): value is ThemePreference =>
  value !== null && (THEME_PREFERENCES as readonly string[]).includes(value);

/**
 * Storage throws in a browser with site data blocked, and the admin still has
 * to render. A preference that cannot be read falls back to the default; one
 * that cannot be written is simply not remembered.
 */
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Not remembering the choice is better than failing the interaction.
  }
}

/** `ar` for an Arabic browser, English for everything else. */
export function localeFromNavigatorLanguage(language: string | undefined): Locale {
  return (language ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

function readStoredLocale(): Locale | undefined {
  const stored = readStored(LOCALE_STORAGE_KEY);

  return isLocale(stored) ? stored : undefined;
}

/** The stored locale, else the browser's, else English. */
export function resolveInitialLocale(
  navigatorLanguage: string | undefined = globalThis.navigator?.language,
): Locale {
  return readStoredLocale() ?? localeFromNavigatorLanguage(navigatorLanguage);
}

export function storeLocale(locale: Locale): void {
  writeStored(LOCALE_STORAGE_KEY, locale);
}

export function resolveInitialThemePreference(): ThemePreference {
  const stored = readStored(THEME_STORAGE_KEY);

  return isThemePreference(stored) ? stored : 'auto';
}

export function storeThemePreference(preference: ThemePreference): void {
  writeStored(THEME_STORAGE_KEY, preference);
}
