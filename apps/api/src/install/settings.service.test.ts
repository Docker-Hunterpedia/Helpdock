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
      github: { enabled: false },
      redirectUrls: {
        google: `${APP_URL}/api/auth/oauth/google/callback`,
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
          github: { clientId: '' },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
