import type { WidgetSettingsRow } from '@helpdock/db';
import { WIDGET_SETTINGS_DEFAULTS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { resolveCaptcha, resolveWidgetSettings } from './resolved-settings.js';

const row = (overrides: Partial<WidgetSettingsRow> = {}): WidgetSettingsRow => ({
  brandId: '0192c3f0-1a2b-7c3d-8e4f-0000000000b1',
  appearance: {},
  conversation: {},
  allowedOrigins: ['https://shop.example.com'],
  captchaEnabled: true,
  signedIdentityEnabled: true,
  signedIdentitySeesAllChannels: false,
  signingSecret: 'v1.k.sealed',
  signingSecretSetAt: new Date('2026-09-14T09:00:00.000Z'),
  signingSecretSetBy: null,
  updatedAt: new Date('2026-09-14T09:00:00.000Z'),
  ...overrides,
});

describe('resolveWidgetSettings', () => {
  it('is the defaults, with no origins, for a brand that never saved the tab', () => {
    const resolved = resolveWidgetSettings(undefined);

    expect(resolved.appearance).toEqual(WIDGET_SETTINGS_DEFAULTS.appearance);
    expect(resolved.allowedOrigins).toEqual([]);
    expect(resolved.captchaEnabled).toBe(false);
    expect(resolved.signingSecret).toBeNull();
  });

  it('lays what was stored over the defaults', () => {
    const resolved = resolveWidgetSettings(
      row({
        appearance: { mode: 'form', accent: '#1D4ED8' },
        conversation: { transcriptEnabled: true },
      }),
    );

    expect(resolved.appearance).toMatchObject({
      mode: 'form',
      accent: '#1D4ED8',
      launcher: 'icon',
    });
    expect(resolved.conversation.transcriptEnabled).toBe(true);
    expect(resolved.signingSecret).toBe('v1.k.sealed');
  });

  it('falls back to the defaults for a card that no longer parses, rather than failing', () => {
    const resolved = resolveWidgetSettings(row({ appearance: { accent: '#FFFFFF' } }));

    expect(resolved.appearance).toEqual(WIDGET_SETTINGS_DEFAULTS.appearance);
  });
});

describe('resolveCaptcha', () => {
  it('reads the JSON-encoded settings rows, Turnstile unless told otherwise', () => {
    expect(
      resolveCaptcha({
        provider: '"hcaptcha"',
        siteKey: '"site"',
        secret: 'v1.k.sealed',
        secretSetAt: new Date('2026-09-14T09:00:00.000Z'),
        secretSetBy: 'user',
      }),
    ).toMatchObject({
      provider: 'hcaptcha',
      siteKey: 'site',
      secret: 'v1.k.sealed',
      secretSetBy: 'user',
    });

    expect(
      resolveCaptcha({
        provider: 'not json',
        siteKey: undefined,
        secret: '',
        secretSetAt: new Date(),
        secretSetBy: 'user',
      }),
    ).toEqual({
      provider: 'turnstile',
      siteKey: '',
      secret: null,
      secretSetAt: null,
      secretSetBy: null,
    });
  });
});
