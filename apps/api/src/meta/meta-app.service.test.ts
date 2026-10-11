import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import { type DbTransaction, uuidv7 } from '@helpdock/db';
import { metaAppSchema, metaVerifyTokenRevealSchema } from '@helpdock/schemas';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { MetaAppService } from './meta-app.service.js';

const APP_URL = 'https://support.example.com';
const ACTOR_ID = uuidv7();
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

const serviceWith = (env: Record<string, string> = {}) => {
  const settings = settingsWith(env);
  return { settings, service: new MetaAppService(settings, { APP_URL }) };
};

/** Runs as an install admin, with an audit trail to read back. */
const asInstallAdmin = async <T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly audits: readonly Record<string, unknown>[] }> => {
  const audits: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void audits.push(row) }),
  } as unknown as DbTransaction;
  const context = new RequestContext({ requestId: 'meta-app-test', method: 'GET', path: '/' });
  context.principal = { type: 'staff', id: ACTOR_ID, installAdmin: true, brands: {} };
  context.tx = tx;

  return runInRequestContext(context, async () => ({ result: await run(), audits }));
};

describe('MetaAppService.secrets', () => {
  it('lists the app secret and the Instagram app secret, whichever are set', async () => {
    const both = serviceWith({
      HD_META_APP_SECRET: 'app-secret',
      HD_META_INSTAGRAM_APP_SECRET: 'instagram-secret',
    });
    const one = serviceWith({ HD_META_APP_SECRET: 'app-secret' });
    const onlyInstagram = serviceWith({ HD_META_INSTAGRAM_APP_SECRET: 'instagram-secret' });

    await expect(both.service.secrets()).resolves.toEqual(['app-secret', 'instagram-secret']);
    await expect(one.service.secrets()).resolves.toEqual(['app-secret']);
    await expect(onlyInstagram.service.secrets()).resolves.toEqual(['instagram-secret']);
  });

  it('is empty on a fresh install, so nothing verifies', async () => {
    await expect(serviceWith().service.secrets()).resolves.toEqual([]);
  });

  it('follows a secret saved on Settings without a restart', async () => {
    const { settings, service } = serviceWith();
    await settings.set('meta.appSecret', 'saved-later', { updatedBy: ACTOR_ID });

    await expect(service.secrets()).resolves.toEqual(['saved-later']);
  });
});

describe('MetaAppService.appId', () => {
  it('is empty on a fresh install and follows what is saved or set by the environment', async () => {
    expect(await serviceWith().service.appId()).toBe('');
    expect(await serviceWith({ HD_META_APP_ID: '1234567890123456' }).service.appId()).toBe(
      '1234567890123456',
    );

    const { settings, service } = serviceWith();
    await settings.set('meta.appId', '6543210987654321', { updatedBy: ACTOR_ID });
    expect(await service.appId()).toBe('6543210987654321');
  });
});

describe('MetaAppService verify token', () => {
  it('is empty until someone makes one, and reading it for the handshake never writes it', async () => {
    const { settings, service } = serviceWith();

    await expect(service.currentVerifyToken()).resolves.toBe('');
    await expect(settings.get('meta.webhookVerifyToken')).resolves.toBe('');
  });

  it('makes one on first use, stores it, audits the change by key and keeps it afterwards', async () => {
    const { settings, service } = serviceWith();

    const { result: first, audits } = await asInstallAdmin(() => service.verifyToken());
    const { result: second, audits: again } = await asInstallAdmin(() => service.verifyToken());

    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).toBe(first);
    await expect(settings.get('meta.webhookVerifyToken')).resolves.toBe(first);
    await expect(service.currentVerifyToken()).resolves.toBe(first);
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: ACTOR_ID,
        action: 'settings.updated',
        targetType: 'settings',
        targetId: 'meta',
        meta: { keys: ['meta.webhookVerifyToken'] },
      }),
    ]);
    expect(again).toEqual([]);
    expect(JSON.stringify(audits)).not.toContain(first);
  });

  it('shows a new token once and stops honouring the old one', async () => {
    const { service } = serviceWith();
    const { result: old } = await asInstallAdmin(() => service.verifyToken());

    const { result: revealed, audits } = await asInstallAdmin(() => service.rotateVerifyToken());

    expect(metaVerifyTokenRevealSchema.parse(revealed).verifyToken).not.toBe(old);
    await expect(service.currentVerifyToken()).resolves.toBe(revealed.verifyToken);
    expect(audits).toHaveLength(1);
  });

  it('leaves a token an environment variable owns alone, and says which variable', async () => {
    const { service } = serviceWith({ HD_META_WEBHOOK_VERIFY_TOKEN: 'from-the-environment' });

    await expect(service.currentVerifyToken()).resolves.toBe('from-the-environment');
    await expect(asInstallAdmin(() => service.verifyToken())).resolves.toMatchObject({
      result: 'from-the-environment',
      audits: [],
    });
    await expect(asInstallAdmin(() => service.rotateVerifyToken())).rejects.toThrow(
      ConflictException,
    );
    await expect(asInstallAdmin(() => service.rotateVerifyToken())).rejects.toThrow(
      /HD_META_WEBHOOK_VERIFY_TOKEN/,
    );
  });

  it('refuses to store a token outside a request', async () => {
    const { service } = serviceWith();

    await expect(service.verifyToken()).rejects.toThrow(/request context/);
  });

  it('refuses to store a token for a request that has no principal', async () => {
    const { service } = serviceWith();
    const context = new RequestContext({ requestId: 'meta-app-test', method: 'POST', path: '/' });

    await expect(runInRequestContext(context, () => service.rotateVerifyToken())).rejects.toThrow(
      'without a principal',
    );
  });

  it('lets a failure to save that is not a lock through untouched', async () => {
    const settings = settingsWith();
    const failure = new Error('the settings table is gone');
    const service = new MetaAppService(
      {
        get: settings.get.bind(settings),
        isLockedByEnv: settings.isLockedByEnv.bind(settings),
        set: () => Promise.reject(failure),
      },
      { APP_URL },
    );

    await expect(asInstallAdmin(() => service.rotateVerifyToken())).rejects.toBe(failure);
  });
});

describe('MetaAppService.card', () => {
  it('points Meta at the install’s webhook and shows no secret', async () => {
    const { service } = serviceWith({
      HD_META_APP_ID: '1234567890123456',
      HD_META_APP_SECRET: 'app-secret',
    });

    const { result: card } = await asInstallAdmin(() => service.card());

    expect(metaAppSchema.parse(card)).toEqual({
      appIdSet: true,
      appId: '1234567890123456',
      appSecretSet: true,
      instagramAppSecretSet: false,
      graphVersion: 'v25.0',
      callbackUrl: 'https://support.example.com/api/meta/webhook',
      verifyTokenHint: expect.stringMatching(/^.{4}$/),
      secretsLockedByEnv: ['meta.appId', 'meta.appSecret'],
    });
    expect(JSON.stringify(card)).not.toContain('app-secret');
  });

  it('says the app id is not set on a fresh install, and has a token ready to copy', async () => {
    const { service } = serviceWith();

    const { result: card } = await asInstallAdmin(() => service.card());

    expect(card).toMatchObject({
      appIdSet: false,
      appId: '',
      appSecretSet: false,
      instagramAppSecretSet: false,
      secretsLockedByEnv: [],
    });
    expect(card.verifyTokenHint).toHaveLength(4);
    await expect(service.currentVerifyToken()).resolves.not.toBe('');
  });

  it('reports the Graph version the install pins, and the built-in one otherwise', async () => {
    const pinned = new MetaAppService(settingsWith(), {
      APP_URL,
      META_GRAPH_VERSION: 'v26.0',
    });

    const { result: card } = await asInstallAdmin(() => pinned.card());
    const { result: fallback } = await asInstallAdmin(() => serviceWith().service.card());

    expect(card.graphVersion).toBe('v26.0');
    expect(fallback.graphVersion).toBe('v25.0');
  });

  it('says an Instagram app secret is set when one is, and still shows no secret', async () => {
    const { service } = serviceWith({ HD_META_INSTAGRAM_APP_SECRET: 'instagram-secret' });

    const { result: card } = await asInstallAdmin(() => service.card());

    expect(card).toMatchObject({ appSecretSet: false, instagramAppSecretSet: true });
    expect(JSON.stringify(card)).not.toContain('instagram-secret');
  });

  it('builds the callback URL on the origin of APP_URL, as the Telegram webhook does', () => {
    const service = new MetaAppService(settingsWith(), { APP_URL: 'https://example.com/support/' });

    expect(service.callbackUrl()).toBe('https://example.com/api/meta/webhook');
  });
});
