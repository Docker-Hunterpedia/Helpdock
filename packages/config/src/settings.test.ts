import { describe, expect, it, vi } from 'vitest';
import { createKeyring, SecretDecryptionError } from './crypto.js';
import type { EnvSource } from './env.js';
import { type Invalidation, LocalInvalidation } from './invalidation.js';
import {
  createSettings,
  EnvOverrideError,
  InMemorySettingsStore,
  SettingDecodeError,
  SettingLockedError,
  type Settings,
  type SettingsStore,
  SettingValidationError,
} from './settings.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });
const otherKeyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 6).toString('base64') });

const by = { updatedBy: 'user-1' };

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );

interface Harness {
  readonly settings: Settings;
  readonly store: SettingsStore;
}

const harness = (
  env: EnvSource = {},
  store: SettingsStore = new InMemorySettingsStore(),
  invalidation: Invalidation = new LocalInvalidation(),
): Harness => ({
  settings: createSettings({ env, store, keyring, invalidation }),
  store,
});

describe('InMemorySettingsStore', () => {
  it('reads back what it wrote and lists every row once', async () => {
    const store = new InMemorySettingsStore();
    const row = {
      key: 'smtp.host',
      value: '"smtp.example.com"',
      updatedAt: new Date(),
      updatedBy: 'user-1',
    } as const;

    await store.write(row);
    await store.write({ ...row, value: '"second.example.com"' });

    await expect(store.read('smtp.host')).resolves.toMatchObject({
      value: '"second.example.com"',
    });
    await expect(store.read('smtp.port')).resolves.toBeUndefined();
    await expect(store.list()).resolves.toHaveLength(1);
  });
});

describe('resolution order', () => {
  it('falls back to the registry default when nothing is stored', async () => {
    const { settings } = harness();

    await expect(settings.get('smtp.port')).resolves.toBe(587);
    await expect(settings.get('captcha.provider')).resolves.toBe('none');
    await expect(settings.get('roles.viewerEnabled')).resolves.toBe(true);
  });

  it('returns a stored value in preference to the default', async () => {
    const { settings } = harness();

    await settings.set('smtp.host', 'smtp.example.com', by);
    await settings.set('smtp.port', 465, by);
    await settings.set('auth.require2fa', true, by);

    await expect(settings.get('smtp.host')).resolves.toBe('smtp.example.com');
    await expect(settings.get('smtp.port')).resolves.toBe(465);
    await expect(settings.get('auth.require2fa')).resolves.toBe(true);
  });

  it('returns an environment override in preference to a stored value', async () => {
    const store = new InMemorySettingsStore();
    await harness({}, store).settings.set('smtp.host', 'stored.example.com', by);

    const { settings } = harness({ HD_SMTP_HOST: 'env.example.com' }, store);

    await expect(settings.get('smtp.host')).resolves.toBe('env.example.com');
    expect(settings.isLockedByEnv('smtp.host')).toBe(true);
    expect(settings.isLockedByEnv('smtp.port')).toBe(false);
  });
});

describe('environment overrides', () => {
  it('reads the string, number and boolean shapes out of the environment', async () => {
    const { settings } = harness({
      HD_SMTP_HOST: 'env.example.com',
      HD_SMTP_PORT: '2525',
      HD_AUTH_REQUIRE2FA: 'true',
      HD_ROLES_VIEWER_ENABLED: 'false',
      HD_CAPTCHA_PROVIDER: 'turnstile',
    });

    await expect(settings.get('smtp.host')).resolves.toBe('env.example.com');
    await expect(settings.get('smtp.port')).resolves.toBe(2525);
    await expect(settings.get('auth.require2fa')).resolves.toBe(true);
    await expect(settings.get('roles.viewerEnabled')).resolves.toBe(false);
    await expect(settings.get('captcha.provider')).resolves.toBe('turnstile');
  });

  it('ignores a blank override, so a key left empty in .env stays editable', async () => {
    const { settings } = harness({ HD_SMTP_HOST: '   ' });

    expect(settings.isLockedByEnv('smtp.host')).toBe(false);
    await expect(settings.get('smtp.host')).resolves.toBe('');
  });

  it('refuses to start when an override does not satisfy its schema', () => {
    const attempt = (): Settings =>
      harness({ HD_SMTP_PORT: 'smtp', HD_AUTH_REQUIRE2FA: 'yes' }).settings;

    expect(attempt).toThrow(EnvOverrideError);
    expect(attempt).toThrow(/HD_SMTP_PORT, HD_AUTH_REQUIRE2FA/);
  });

  it('refuses to change a locked key', async () => {
    const { settings } = harness({ HD_SMTP_HOST: 'env.example.com' });

    await expect(settings.set('smtp.host', 'other.example.com', by)).rejects.toThrow(
      SettingLockedError,
    );
    await expect(settings.get('smtp.host')).resolves.toBe('env.example.com');
  });
});

describe('writing a setting', () => {
  it('validates against the key schema before it reaches the store', async () => {
    const { settings, store } = harness();
    // The admin API hands over whatever the client sent, so the cast is what a
    // bad request looks like from here.
    const bad = settings.set('smtp.port', 'not-a-port' as unknown as number, by);

    await expect(bad).rejects.toThrow(SettingValidationError);
    await expect(store.read('smtp.port')).resolves.toBeUndefined();
  });

  it('reports what was wrong without quoting the value, which may be a secret', async () => {
    const { settings } = harness();

    const error = await rejection(settings.set('smtp.password', 42 as unknown as string, by));

    expect(error).toBeInstanceOf(SettingValidationError);
    const failure = error as SettingValidationError;
    expect(failure.key).toBe('smtp.password');
    expect(failure.issues.length).toBeGreaterThan(0);
    expect(failure.message).not.toContain('42');
  });

  it('records who changed it and when', async () => {
    const { settings, store } = harness();
    const before = Date.now();

    await settings.set('smtp.host', 'smtp.example.com', { updatedBy: 'user-7' });
    const row = await store.read('smtp.host');

    expect(row?.updatedBy).toBe('user-7');
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('secret settings', () => {
  it('encrypts at rest and decrypts on the way out', async () => {
    const { settings, store } = harness();

    await settings.set('smtp.password', 'hunter2', by);
    const row = await store.read('smtp.password');

    expect(row?.value.startsWith('v1.')).toBe(true);
    expect(row?.value).not.toContain('hunter2');
    await expect(settings.get('smtp.password')).resolves.toBe('hunter2');
  });

  it('withholds secrets from getAll unless they are asked for explicitly', async () => {
    const { settings } = harness();
    await settings.set('smtp.password', 'hunter2', by);

    const withoutSecrets = await settings.getAll();
    const withSecrets = await settings.getAll({ includeSecrets: true });

    expect(withoutSecrets).not.toHaveProperty('smtp.password');
    expect(withoutSecrets['smtp.host']).toBe('');
    expect(withSecrets['smtp.password']).toBe('hunter2');
  });

  it('fails loudly when the master key can no longer read a stored secret', async () => {
    const store = new InMemorySettingsStore();
    const writer = createSettings({
      env: {},
      store,
      keyring,
      invalidation: new LocalInvalidation(),
    });
    await writer.set('smtp.password', 'hunter2', by);

    const reader = createSettings({
      env: {},
      store,
      keyring: otherKeyring,
      invalidation: new LocalInvalidation(),
    });

    await expect(reader.get('smtp.password')).rejects.toThrow(SecretDecryptionError);
  });
});

describe('getAll', () => {
  it('returns every non-secret key when no scope is given', async () => {
    const { settings } = harness();

    const all = await settings.getAll();

    expect(all['smtp.port']).toBe(587);
    expect(all['embedding.dims']).toBe(0);
    expect(all['auth.magicLinkTtlMinutes']).toBe(10);
  });

  it('filters by scope', async () => {
    const { settings } = harness();

    const install = await settings.getAll({ scope: 'install' });
    const brand = await settings.getAll({ scope: 'brand' });

    expect(install).toHaveProperty('auth.require2fa');
    expect(install).not.toHaveProperty('smtp.host');
    expect(brand).toHaveProperty('smtp.host');
    expect(brand).not.toHaveProperty('auth.require2fa');
  });
});

describe('caching and invalidation', () => {
  it('reads the store once and serves later calls from memory', async () => {
    const store = new InMemorySettingsStore();
    const read = vi.spyOn(store, 'read');
    const { settings } = harness({}, store);

    await settings.get('smtp.host');
    await settings.get('smtp.host');

    expect(read).toHaveBeenCalledOnce();
  });

  it('never touches the store for a key the environment has locked', async () => {
    const store = new InMemorySettingsStore();
    const read = vi.spyOn(store, 'read');
    const { settings } = harness({ HD_SMTP_HOST: 'env.example.com' }, store);

    await settings.get('smtp.host');

    expect(read).not.toHaveBeenCalled();
  });

  it('refreshes another instance that shares the store and the channel', async () => {
    const store = new InMemorySettingsStore();
    const invalidation = new LocalInvalidation();
    const { settings: writer } = harness({}, store, invalidation);
    const { settings: reader } = harness({}, store, invalidation);

    await expect(reader.get('smtp.host')).resolves.toBe('');
    await writer.set('smtp.host', 'smtp.example.com', by);

    await expect(reader.get('smtp.host')).resolves.toBe('smtp.example.com');
  });

  it('tells subscribers which key changed', async () => {
    const store = new InMemorySettingsStore();
    const invalidation = new LocalInvalidation();
    const { settings: writer } = harness({}, store, invalidation);
    const { settings: reader } = harness({}, store, invalidation);
    const listener = vi.fn();
    const unsubscribe = reader.subscribe(listener);

    await writer.set('smtp.host', 'smtp.example.com', by);
    unsubscribe();
    await writer.set('smtp.port', 2525, by);

    expect(listener).toHaveBeenCalledExactlyOnceWith('smtp.host');
  });

  it('stops listening once closed', async () => {
    const store = new InMemorySettingsStore();
    const invalidation = new LocalInvalidation();
    const { settings: writer } = harness({}, store, invalidation);
    const { settings: reader } = harness({}, store, invalidation);
    const listener = vi.fn();
    reader.subscribe(listener);

    await reader.close();
    await writer.set('smtp.host', 'smtp.example.com', by);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('a stored row that no longer fits its key', () => {
  const writeRaw = async (store: SettingsStore, value: string): Promise<void> => {
    await store.write({
      key: 'smtp.port',
      value,
      updatedAt: new Date(),
      updatedBy: 'migration',
    });
  };

  it('rejects a row that is not JSON', async () => {
    const store = new InMemorySettingsStore();
    await writeRaw(store, 'not json');
    const { settings } = harness({}, store);

    await expect(settings.get('smtp.port')).rejects.toThrow(SettingDecodeError);
  });

  it('rejects a row the schema no longer accepts', async () => {
    const store = new InMemorySettingsStore();
    await writeRaw(store, '70000');
    const { settings } = harness({}, store);

    await expect(settings.get('smtp.port')).rejects.toThrow(/no longer satisfies/);
  });
});
