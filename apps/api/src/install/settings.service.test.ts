import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { InstallSettingsService } from './settings.service.js';

const APP_URL = 'https://support.example.com';
const ACTOR_ID = uuidv7();
const BRAND_ID = uuidv7();
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

const inInstallRequest = async <T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly audits: readonly Record<string, unknown>[] }> => {
  const audits: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void audits.push(row) }),
  } as unknown as DbTransaction;
  const context = new RequestContext({ requestId: 'settings-test', method: 'PUT', path: '/' });
  context.principal = {
    type: 'staff',
    id: ACTOR_ID,
    installAdmin: true,
    brands: { [BRAND_ID]: { role: 'admin', departmentIds: 'all' } },
  };
  context.tx = tx;

  return runInRequestContext(context, async () => ({ result: await run(), audits }));
};

describe('InstallSettingsService', () => {
  it('reports defaults, locks, and the exact OAuth callback routes without exposing secrets', async () => {
    const settings = settingsWith({
      HD_AUTH_REQUIRE2FA: 'true',
      HD_OAUTH_GOOGLE_CLIENT_ID: 'google-id',
      HD_OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
    });
    const view = await new InstallSettingsService(settings, { APP_URL }).authentication();

    expect(view).toMatchObject({
      requireTwoFactor: true,
      requireTwoFactorLocked: true,
      magicLinkValidityMinutes: 10,
      google: {
        clientId: 'google-id',
        clientIdLocked: true,
        clientSecretConfigured: true,
        clientSecretLocked: true,
        enabled: true,
      },
      microsoft: { enabled: false, tenantId: '', tenantIdLocked: false },
      github: { enabled: false },
      redirectUrls: {
        google: `${APP_URL}/api/auth/oauth/google/callback`,
        microsoft: `${APP_URL}/api/auth/oauth/microsoft/callback`,
        github: `${APP_URL}/api/auth/oauth/github/callback`,
      },
    });
    expect(view.google).not.toHaveProperty('clientSecret');
  });

  it('saves editable values, preserves omitted secrets, and audits key names only', async () => {
    const settings = settingsWith();
    await settings.set('oauth.google.clientSecret', 'kept-secret', { updatedBy: ACTOR_ID });
    const service = new InstallSettingsService(settings, { APP_URL });

    const { result, audits } = await inInstallRequest(() =>
      service.saveAuthentication({
        requireTwoFactor: true,
        magicLinkValidityMinutes: 15,
        google: { clientId: 'google-id' },
        microsoft: { clientId: '', tenantId: '' },
        github: { clientId: 'github-id', clientSecret: 'github-secret' },
      }),
    );

    expect(result).toMatchObject({
      requireTwoFactor: true,
      magicLinkValidityMinutes: 15,
      google: { clientSecretConfigured: true, enabled: true },
      github: { clientSecretConfigured: true, enabled: true },
    });
    await expect(settings.get('oauth.google.clientSecret')).resolves.toBe('kept-secret');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.meta).toEqual({
      keys: [
        'auth.require2fa',
        'auth.magicLinkTtlMinutes',
        'oauth.google.clientId',
        'oauth.github.clientId',
        'oauth.github.clientSecret',
      ],
    });
    expect(JSON.stringify(audits)).not.toContain('github-secret');
  });

  it('saves the allowed Workspace domains, and leaves an equal list unaudited', async () => {
    const settings = settingsWith();
    const service = new InstallSettingsService(settings, { APP_URL });
    const save = (allowedDomains: string[] | undefined) =>
      inInstallRequest(() =>
        service.saveAuthentication({
          requireTwoFactor: false,
          magicLinkValidityMinutes: 10,
          google: {
            clientId: '',
            ...(allowedDomains === undefined ? {} : { allowedDomains }),
          },
          microsoft: { clientId: '', tenantId: '' },
          github: { clientId: '' },
        }),
      );

    const first = await save(['helpdock.com', 'helpdock.sa']);
    expect(first.result.google).toMatchObject({
      allowedDomains: ['helpdock.com', 'helpdock.sa'],
      allowedDomainsLocked: false,
    });
    expect(first.audits[0]?.meta).toEqual({ keys: ['oauth.google.allowedDomains'] });

    expect((await save(['helpdock.com', 'helpdock.sa'])).audits).toEqual([]);
    expect((await save(undefined)).result.google.allowedDomains).toEqual([
      'helpdock.com',
      'helpdock.sa',
    ]);
  });

  it('reads the allowed domains pinned by HD_OAUTH_GOOGLE_ALLOWED_DOMAINS as locked', async () => {
    const service = new InstallSettingsService(
      settingsWith({ HD_OAUTH_GOOGLE_ALLOWED_DOMAINS: '["helpdock.com"]' }),
      { APP_URL },
    );

    await expect(service.authentication()).resolves.toMatchObject({
      google: { allowedDomains: ['helpdock.com'], allowedDomainsLocked: true },
    });
  });

  it('keeps the Microsoft secret write-only, turns the button on only with a tenant, and audits names', async () => {
    const settings = settingsWith();
    const service = new InstallSettingsService(settings, { APP_URL });
    const TENANT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const save = (microsoft: { clientId: string; tenantId: string; clientSecret?: string }) =>
      inInstallRequest(() =>
        service.saveAuthentication({
          requireTwoFactor: false,
          magicLinkValidityMinutes: 10,
          google: { clientId: '' },
          microsoft,
          github: { clientId: '' },
        }),
      );

    const withoutTenant = await save({
      clientId: 'app-id',
      tenantId: '',
      clientSecret: 'ms-secret',
    });
    expect(withoutTenant.result.microsoft).toMatchObject({
      clientSecretConfigured: true,
      enabled: false,
    });

    const withTenant = await save({ clientId: 'app-id', tenantId: TENANT });
    expect(withTenant.result.microsoft).toMatchObject({ tenantId: TENANT, enabled: true });
    expect(withTenant.result.microsoft).not.toHaveProperty('clientSecret');
    expect(withTenant.audits[0]?.meta).toEqual({ keys: ['oauth.microsoft.tenantId'] });
    expect(JSON.stringify([withoutTenant.audits, withTenant.audits])).not.toContain('ms-secret');
    await expect(settings.get('oauth.microsoft.clientSecret')).resolves.toBe('ms-secret');
  });

  it('reads the Microsoft tenant, client id and secret pinned by HD_OAUTH_MICROSOFT_* as locked', async () => {
    const service = new InstallSettingsService(
      settingsWith({
        HD_OAUTH_MICROSOFT_TENANT_ID: '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        HD_OAUTH_MICROSOFT_CLIENT_ID: 'app-id',
        HD_OAUTH_MICROSOFT_CLIENT_SECRET: 'pinned-secret',
      }),
      { APP_URL },
    );

    const view = await service.authentication();

    expect(view.microsoft).toMatchObject({
      tenantIdLocked: true,
      clientIdLocked: true,
      clientSecretLocked: true,
      enabled: true,
    });
    await expect(
      inInstallRequest(() =>
        service.saveAuthentication({
          requireTwoFactor: false,
          magicLinkValidityMinutes: 10,
          google: { clientId: '' },
          microsoft: { clientId: 'app-id', tenantId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
          github: { clientId: '' },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports personal accounts as off by default and pinned when HD_OAUTH_MICROSOFT_ALLOW_CONSUMERS is set', async () => {
    const off = await new InstallSettingsService(settingsWith(), { APP_URL }).authentication();
    const pinned = await new InstallSettingsService(
      settingsWith({ HD_OAUTH_MICROSOFT_ALLOW_CONSUMERS: 'true' }),
      { APP_URL },
    ).authentication();

    expect(off.microsoft).toMatchObject({ allowConsumers: false, allowConsumersLocked: false });
    expect(pinned.microsoft).toMatchObject({ allowConsumers: true, allowConsumersLocked: true });
  });

  it('refuses an attempted change to an environment-pinned setting', async () => {
    const service = new InstallSettingsService(
      settingsWith({ HD_AUTH_MAGIC_LINK_TTL_MINUTES: '20' }),
      { APP_URL },
    );

    await expect(
      inInstallRequest(() =>
        service.saveAuthentication({
          requireTwoFactor: false,
          magicLinkValidityMinutes: 10,
          google: { clientId: '' },
          microsoft: { clientId: '', tenantId: '' },
          github: { clientId: '' },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
