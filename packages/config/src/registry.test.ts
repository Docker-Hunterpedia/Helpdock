import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from './env.js';
import {
  isSettingKey,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  settingDefinitions,
  settingsSchema,
  toEnvKey,
} from './registry.js';

describe('toEnvKey', () => {
  it('prefixes HD_ and turns dots and camel case into underscores', () => {
    expect(toEnvKey('smtp.host')).toBe('HD_SMTP_HOST');
    expect(toEnvKey('oauth.google.clientId')).toBe('HD_OAUTH_GOOGLE_CLIENT_ID');
    expect(toEnvKey('auth.magicLinkTtlMinutes')).toBe('HD_AUTH_MAGIC_LINK_TTL_MINUTES');
    expect(toEnvKey('push.vapidPublicKey')).toBe('HD_PUSH_VAPID_PUBLIC_KEY');
  });
});

describe('the settings registry', () => {
  it('declares every key once', () => {
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
  });

  it('gives every key a default its own schema accepts', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(
        definition.schema.safeParse(definition.default),
        `default for ${definition.key}`,
      ).toMatchObject({ success: true });
    }
  });

  it('describes every key, because admin renders the description', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(definition.description.length, definition.key).toBeGreaterThan(0);
    }
  });

  it('derives a unique HD_ override name that cannot collide with a bootstrap key', () => {
    const envKeys = SETTING_DEFINITIONS.map((definition) => definition.envKey);

    expect(new Set(envKeys).size).toBe(envKeys.length);
    for (const envKey of envKeys) {
      expect(envKey.startsWith('HD_'), envKey).toBe(true);
      expect(ENV_KEYS).not.toContain(envKey);
    }
  });

  it('encrypts exactly the keys that hold a credential', () => {
    const secrets = SETTING_DEFINITIONS.filter((definition) => definition.secret).map(
      (definition) => definition.key,
    );

    expect(secrets).toEqual([
      'smtp.password',
      'oauth.google.clientSecret',
      'oauth.github.clientSecret',
      'auth.jwtSigningKey',
      'captcha.secret',
      'push.vapidPrivateKey',
    ]);
  });
});

describe('the lookups built from the registry', () => {
  it('exposes the same definitions by key', () => {
    for (const definition of SETTING_DEFINITIONS) {
      expect(settingDefinitions[definition.key]).toBe(definition);
      expect(settingsSchema[definition.key]).toBe(definition.schema);
    }
    expect(Object.keys(settingDefinitions)).toHaveLength(SETTING_DEFINITIONS.length);
    expect(Object.keys(settingsSchema)).toHaveLength(SETTING_DEFINITIONS.length);
  });

  it('recognises a known key and rejects anything else', () => {
    expect(isSettingKey('smtp.host')).toBe(true);
    expect(isSettingKey('smtp.nonsense')).toBe(false);
    expect(isSettingKey('toString')).toBe(false);
  });
});

describe('the schemas the registry declares', () => {
  it('bounds the SMTP port to a real port number', () => {
    expect(settingsSchema['smtp.port'].safeParse(465).success).toBe(true);
    expect(settingsSchema['smtp.port'].safeParse(0).success).toBe(false);
    expect(settingsSchema['smtp.port'].safeParse(70_000).success).toBe(false);
  });

  it('accepts only the CAPTCHA providers that have an adapter', () => {
    expect(settingsSchema['captcha.provider'].safeParse('turnstile').success).toBe(true);
    expect(settingsSchema['captcha.provider'].safeParse('hcaptcha').success).toBe(true);
    expect(settingsSchema['captcha.provider'].safeParse('none').success).toBe(true);
    expect(settingsSchema['captcha.provider'].safeParse('recaptcha').success).toBe(false);
  });

  it('caps embedding dimensions at what a pgvector index can cover', () => {
    expect(settingsSchema['embedding.dims'].safeParse(1536).success).toBe(true);
    expect(settingsSchema['embedding.dims'].safeParse(2_000).success).toBe(true);
    expect(settingsSchema['embedding.dims'].safeParse(3_072).success).toBe(false);
    expect(settingsSchema['embedding.dims'].safeParse(-1).success).toBe(false);
  });

  it('keeps a magic link short-lived', () => {
    expect(settingsSchema['auth.magicLinkTtlMinutes'].safeParse(10).success).toBe(true);
    expect(settingsSchema['auth.magicLinkTtlMinutes'].safeParse(0).success).toBe(false);
    expect(settingsSchema['auth.magicLinkTtlMinutes'].safeParse(120).success).toBe(false);
  });
});
