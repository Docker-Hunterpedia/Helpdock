import { WIDGET_SETTINGS_DEFAULTS, type WidgetAppearance } from '@helpdock/schemas';
import { resolveBrandTheme, resolveSemanticTokens } from '@helpdock/ui/resolve';
import { describe, expect, it } from 'vitest';
import { greetingIn, widgetThemeOf } from './widget-theme.js';

const appearance: WidgetAppearance = {
  ...WIDGET_SETTINGS_DEFAULTS.appearance,
  accent: '#1D4ED8',
  colorScheme: 'dark',
  position: 'start',
  launcher: 'icon_text',
  greetingEn: 'Hi there',
  greetingAr: '',
};

describe('widgetThemeOf', () => {
  it("resolves the brand's accent into both schemes' tokens, as DESIGN §8 does for every surface", () => {
    const theme = widgetThemeOf(appearance, 'https://support.example.com/');
    const brand = resolveBrandTheme({ accent: '#1D4ED8', mode: 'dark' });

    expect(theme.colorScheme).toBe('dark');
    expect(theme.tokens.light).toEqual(resolveSemanticTokens('light', brand));
    expect(theme.tokens.dark).toEqual(resolveSemanticTokens('dark', brand));
    expect(theme.tokens.light['action.primary']).toBe('#1D4ED8');
    expect(theme.radius).toEqual({ md: brand.radius.md, lg: brand.radius.lg });
    expect(theme.fontFamily).toEqual(brand.fontFamily);
    expect(theme.launcher).toEqual({ style: 'icon_text', label: null, position: 'start' });
  });

  it('lists the self-hosted fonts on the api origin', () => {
    const { fonts } = widgetThemeOf(appearance, 'https://support.example.com/');

    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(font.url).toMatch(/^https:\/\/support\.example\.com\/widget-fonts\/[\w-]+\.woff2$/);
    }
    expect(new Set(fonts.map((font) => font.family))).toEqual(
      new Set(['IBM Plex Sans', 'IBM Plex Sans Arabic', 'IBM Plex Mono']),
    );
  });
});

describe('greetingIn', () => {
  it('answers in the language asked, the Arabic falling back to the English', () => {
    expect(greetingIn(appearance, 'en')).toBe('Hi there');
    expect(greetingIn(appearance, 'ar')).toBe('Hi there');
    expect(greetingIn({ ...appearance, greetingAr: 'أهلاً' }, 'ar')).toBe('أهلاً');
  });

  it('has no greeting when the brand left it empty', () => {
    expect(greetingIn({ ...appearance, greetingEn: '' }, 'en')).toBeNull();
  });
});
