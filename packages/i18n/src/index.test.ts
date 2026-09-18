import { describe, expect, it } from 'vitest';
import { createI18n, dir, NAMESPACES, resources, SUPPORTED_LNGS } from './index.js';

describe('dir', () => {
  it.each([
    ['ar', 'rtl'],
    ['ar-SA', 'rtl'],
    ['AR', 'rtl'],
    ['en', 'ltr'],
    ['en-GB', 'ltr'],
    ['fr', 'ltr'],
    ['', 'ltr'],
  ])('reads %s as %s', (locale, expected) => {
    expect(dir(locale)).toBe(expected);
  });
});

describe('createI18n', () => {
  it('is ready to translate as soon as it returns', () => {
    expect(createI18n().isInitialized).toBe(true);
  });

  it('starts in English and resolves an unprefixed key from the common namespace', () => {
    const i18n = createI18n();

    expect(i18n.language).toBe('en');
    expect(i18n.t('actions.cancel')).toBe('Cancel');
  });

  it.each(SUPPORTED_LNGS.flatMap((lng) => NAMESPACES.map((ns) => [lng, ns] as const)))(
    'has %s loaded for the %s namespace',
    (lng, namespace) => {
      const i18n = createI18n({ lng });

      expect(Object.keys(i18n.getResourceBundle(lng, namespace) ?? {})).not.toEqual([]);
    },
  );

  it('translates with the namespace prefix', () => {
    const i18n = createI18n({ lng: 'ar' });

    expect(i18n.t('auth:signIn.title')).toBe('تسجيل الدخول');
    expect(i18n.t('staff:invite')).toBe('دعوة');
  });

  it('interpolates without escaping, because React escapes what it renders', () => {
    const i18n = createI18n();

    expect(i18n.t('staff:table.rowActions', { name: 'Ali & Co' })).toBe('Actions for Ali & Co');
  });

  it('falls back to English for a key Arabic has not translated', () => {
    const i18n = createI18n({ lng: 'ar', resources: { en: resources.en, ar: { common: {} } } });

    expect(i18n.t('actions.cancel')).toBe('Cancel');
  });

  it('accepts replacement catalogs', () => {
    const i18n = createI18n({ resources: { en: { common: { appName: 'Test desk' } } } });

    expect(i18n.t('appName')).toBe('Test desk');
  });

  it('returns the key rather than null when a string is missing', () => {
    const i18n = createI18n();

    // @ts-expect-error the key does not exist, which is the point of the typing
    expect(i18n.t('common:nope.not.here')).toBe('nope.not.here');
  });
});

describe('English plural selection', () => {
  const i18n = createI18n();

  it.each([
    [1, '1 person'],
    [2, '2 people'],
    [0, '0 people'],
  ])('renders %i as "%s"', (count, expected) => {
    expect(i18n.t('staff:peopleCount', { count })).toBe(expected);
  });

  it.each([
    [1, '1 attempt left'],
    [2, '2 attempts left'],
  ])('counts down %i remaining TOTP attempts', (count, expected) => {
    expect(i18n.t('auth:totp.mismatch', { count })).toContain(expected);
  });
});

describe('Arabic plural selection', () => {
  const i18n = createI18n({ lng: 'ar' });

  it.each([
    [0, 'لا أشخاص'],
    [1, 'شخص واحد'],
    [2, 'شخصان'],
    [3, '3 أشخاص'],
    [11, '11 شخصًا'],
    [100, '100 شخص'],
  ])('renders %i as "%s"', (count, expected) => {
    expect(i18n.t('staff:peopleCount', { count })).toBe(expected);
  });

  it('uses the dual form the Arabic artboard shows for two extra brands', () => {
    expect(i18n.t('auth:signIn.subtitle', { count: 2, domain: 'support.example.com' })).toBe(
      'دخول الموظفين إلى support.example.com وعلامتين تجاريتين أخريين.',
    );
  });
});
