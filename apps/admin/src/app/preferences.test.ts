import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCALE_STORAGE_KEY,
  localeFromNavigatorLanguage,
  resolveInitialLocale,
  resolveInitialThemePreference,
  storeLocale,
  storeThemePreference,
  THEME_STORAGE_KEY,
} from './preferences.js';

describe('locale', () => {
  it.each([
    ['ar', 'ar'],
    ['ar-SA', 'ar'],
    ['AR-eg', 'ar'],
    ['en-GB', 'en'],
    ['fr', 'en'],
    [undefined, 'en'],
  ])('reads %s as %s', (language, expected) => {
    expect(localeFromNavigatorLanguage(language)).toBe(expected);
  });

  it('prefers what the user chose over what the browser reports', () => {
    storeLocale('ar');

    expect(resolveInitialLocale('en-GB')).toBe('ar');
  });

  it('ignores a stored value that is not a supported locale', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'de');

    expect(resolveInitialLocale('ar')).toBe('ar');
  });
});

describe('theme preference', () => {
  it('follows the system until the user picks a side', () => {
    expect(resolveInitialThemePreference()).toBe('auto');

    storeThemePreference('dark');

    expect(resolveInitialThemePreference()).toBe('dark');
  });
});

describe('the boot script in index.html', () => {
  const html = readFileSync(path.resolve(import.meta.dirname, '../../index.html'), 'utf8');

  // The script runs before the bundle, so it cannot import these constants. If
  // the keys ever diverge the app would boot in one language and render in
  // another, which this catches instead of a reviewer.
  it.each([LOCALE_STORAGE_KEY, THEME_STORAGE_KEY])('reads %s', (key) => {
    expect(html).toContain(`'${key}'`);
  });

  it('sets lang and dir before the module script runs', () => {
    expect(html.indexOf('root.dir')).toBeLessThan(html.indexOf('src/main.tsx'));
  });
});
