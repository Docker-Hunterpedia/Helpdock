import { describe, expect, it } from 'vitest';
import {
  WIDGET_SETTINGS_DEFAULTS,
  whiteContrastOn,
  widgetAccessSchema,
  widgetAppearanceSchema,
  widgetConversationSettingsSchema,
  widgetOriginSchema,
} from './widget-settings.js';

describe('widgetOriginSchema', () => {
  it('keeps an origin as a browser sends it', () => {
    expect(widgetOriginSchema.parse('https://Shop.Example.com/')).toBe('https://shop.example.com');
    expect(widgetOriginSchema.parse('https://shop.example.com:443')).toBe(
      'https://shop.example.com',
    );
    expect(widgetOriginSchema.parse('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('refuses a path, a query, credentials, another scheme and a bare host', () => {
    for (const value of [
      'https://shop.example.com/checkout',
      'https://shop.example.com?x=1',
      'https://user:pw@shop.example.com',
      'ftp://shop.example.com',
      'shop.example.com',
    ]) {
      expect(widgetOriginSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('widgetAppearanceSchema', () => {
  it('upper-cases the accent and refuses one white text cannot be read on', () => {
    const base = { ...WIDGET_SETTINGS_DEFAULTS.appearance };

    expect(widgetAppearanceSchema.parse({ ...base, accent: '#0f766e' }).accent).toBe('#0F766E');
    expect(widgetAppearanceSchema.safeParse({ ...base, accent: '#FDE68A' }).success).toBe(false);
    expect(widgetAppearanceSchema.safeParse({ ...base, accent: 'teal' }).success).toBe(false);
  });
});

describe('whiteContrastOn', () => {
  it('is the WCAG ratio of white text on the colour', () => {
    expect(whiteContrastOn('#000000')).toBeCloseTo(21, 1);
    expect(whiteContrastOn('#FFFFFF')).toBeCloseTo(1, 5);
    expect(whiteContrastOn('#0F766E')).toBeCloseTo(5.47, 1);
  });
});

describe('widgetConversationSettingsSchema', () => {
  it('refuses a pre-chat field twice', () => {
    const base = { ...WIDGET_SETTINGS_DEFAULTS.conversation };

    expect(
      widgetConversationSettingsSchema.safeParse({
        ...base,
        prechatFields: [
          { kind: 'custom', key: 'plan', required: false },
          { kind: 'custom', key: 'plan', required: true },
        ],
      }).success,
    ).toBe(false);
    expect(widgetConversationSettingsSchema.parse(base)).toEqual(base);
  });
});

describe('widgetAccessSchema', () => {
  it('normalises every origin it holds', () => {
    expect(
      widgetAccessSchema.parse({
        allowedOrigins: ['https://A.example.com/'],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      }).allowedOrigins,
    ).toEqual(['https://a.example.com']);
  });
});
