import {
  createKeyring,
  createSettings,
  type Env,
  InMemorySettingsStore,
  type Settings,
} from '@helpdock/config';
import { describe, expect, it, vi } from 'vitest';
import { ensureVapidKeys, generateVapidKeys } from './vapid-keys.js';

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') } as Env),
    invalidation: {
      publish: () => Promise.resolve(),
      subscribe: () => () => {},
      close: () => Promise.resolve(),
    },
  });

const pair = { publicKey: 'new-public', privateKey: 'new-private' };

describe('ensureVapidKeys', () => {
  it('writes a pair to an install that has none', async () => {
    const settings = settingsWith();

    await expect(ensureVapidKeys(settings, () => pair, 'test')).resolves.toBe(true);

    await expect(settings.get('push.vapidPublicKey')).resolves.toBe('new-public');
    await expect(settings.get('push.vapidPrivateKey')).resolves.toBe('new-private');
  });

  it('keeps a pair that already exists, since replacing it drops every subscription', async () => {
    const settings = settingsWith();
    await settings.set('push.vapidPublicKey', 'kept-public', { updatedBy: 'test' });
    await settings.set('push.vapidPrivateKey', 'kept-private', { updatedBy: 'test' });
    const generate = vi.fn(() => pair);

    await expect(ensureVapidKeys(settings, generate, 'test')).resolves.toBe(false);

    expect(generate).not.toHaveBeenCalled();
    await expect(settings.get('push.vapidPublicKey')).resolves.toBe('kept-public');
  });

  it('replaces half a pair, which can sign nothing', async () => {
    const settings = settingsWith();
    await settings.set('push.vapidPublicKey', 'orphan-public', { updatedBy: 'test' });

    await expect(ensureVapidKeys(settings, () => pair, 'test')).resolves.toBe(true);

    await expect(settings.get('push.vapidPublicKey')).resolves.toBe('new-public');
  });

  it('leaves the keys to an operator who pinned either half in the environment', async () => {
    const settings = settingsWith({ HD_PUSH_VAPID_PUBLIC_KEY: 'pinned-public' });
    const generate = vi.fn(() => pair);

    await expect(ensureVapidKeys(settings, generate, 'test')).resolves.toBe(false);

    expect(generate).not.toHaveBeenCalled();
  });
});

describe('generateVapidKeys', () => {
  it('produces a P-256 public key and a 32-byte private key, base64url', () => {
    const { publicKey, privateKey } = generateVapidKeys();

    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(privateKey, 'base64url')).toHaveLength(32);
  });
});
