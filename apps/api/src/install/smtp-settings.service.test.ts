import type { EmailMessage } from '@helpdock/channels';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type { SmtpTestResult } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '../auth/rate-limit.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SETUP_SMTP_TEST_IP_RULE } from './setup.service.js';
import { SmtpSettingsService } from './smtp-settings.service.js';

/**
 * The System page's Outgoing email card, server side: what is drawn, what a
 * save writes, and the one rule that matters most — the password goes in and
 * never comes back.
 */

const ACTOR_ID = uuidv7();
const BRAND_ID = uuidv7();
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 11).toString('base64') });

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

/** A limiter that answers whatever the test needs, and remembers what it was asked. */
class FakeLimiter {
  allow = true;
  readonly consumed: string[] = [];
  seconds = 42;

  consume(rule: { readonly bucket: string }, subject: string): Promise<boolean> {
    this.consumed.push(`${rule.bucket}:${subject}`);
    return Promise.resolve(this.allow);
  }

  retryAfter(): Promise<number> {
    return Promise.resolve(this.seconds);
  }
}

const asLimiter = (fake: FakeLimiter): RateLimiter => fake as unknown as RateLimiter;

const inInstallRequest = async <T>(
  run: () => Promise<T>,
  staff: { readonly name: string; readonly email: string; readonly locale: string } = {
    name: 'Lina Haddad',
    email: 'lina@example.com',
    locale: 'en',
  },
): Promise<{ readonly result: T; readonly audits: readonly Record<string, unknown>[] }> => {
  const audits: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void audits.push(row) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [staff] }),
      }),
    }),
  } as unknown as DbTransaction;
  const context = new RequestContext({ requestId: 'smtp-test', method: 'PUT', path: '/' });
  context.principal = {
    type: 'staff',
    id: ACTOR_ID,
    installAdmin: true,
    brands: { [BRAND_ID]: { role: 'admin', departmentIds: 'all' } },
  };
  context.tx = tx;

  return runInRequestContext(context, async () => ({ result: await run(), audits }));
};

/** Records the sender the service built, and answers with the result it was given. */
const fakeTransport =
  (result: SmtpTestResult, seen: { options?: unknown; message?: EmailMessage } = {}) =>
  (options: unknown) => ({
    options,
    test: async (message: EmailMessage) => {
      seen.options = options;
      seen.message = message;

      return result;
    },
    close: () => {},
  });

const update = (overrides: Record<string, unknown> = {}) => ({
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls' as const,
  user: 'postmaster',
  fromAddress: 'no-reply@example.com',
  fromName: 'Example',
  ...overrides,
});

const storeServer = async (settings: Settings, password = 'stored-secret'): Promise<void> => {
  await settings.set('smtp.host', 'smtp.example.com', { updatedBy: ACTOR_ID });
  await settings.set('smtp.user', 'postmaster', { updatedBy: ACTOR_ID });
  await settings.set('smtp.password', password, { updatedBy: ACTOR_ID });
};

describe('SmtpSettingsService', () => {
  it('reads the defaults of an install that skipped the wizard as not configured', async () => {
    const service = new SmtpSettingsService({
      settings: settingsWith(),
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    await expect(inInstallRequest(() => service.read())).resolves.toMatchObject({
      result: {
        configured: false,
        host: '',
        port: 587,
        tls: 'starttls',
        user: '',
        passwordConfigured: false,
        fromAddress: '',
        fromName: '',
        locked: {
          host: false,
          port: false,
          tls: false,
          user: false,
          password: false,
          fromAddress: false,
          fromName: false,
        },
      },
    });
  });

  it('round-trips a save and never answers with the password', async () => {
    const settings = settingsWith();
    const service = new SmtpSettingsService({
      settings,
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    const { result } = await inInstallRequest(() =>
      service.save(update({ password: 'relay-secret' })),
    );

    expect(result).toMatchObject({
      configured: true,
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      user: 'postmaster',
      passwordConfigured: true,
      fromAddress: 'no-reply@example.com',
      fromName: 'Example',
    });
    expect(JSON.stringify(result)).not.toContain('relay-secret');
    await expect(settings.get('smtp.password')).resolves.toBe('relay-secret');
  });

  it('keeps the stored password when the save provides none', async () => {
    const settings = settingsWith();
    await storeServer(settings, 'kept-secret');
    const service = new SmtpSettingsService({
      settings,
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    await inInstallRequest(() => service.save(update({ fromName: 'Support' })));

    await expect(settings.get('smtp.password')).resolves.toBe('kept-secret');
    await expect(settings.get('smtp.fromName')).resolves.toBe('Support');
  });

  it('refuses a save that moves the server and keeps the stored password', async () => {
    const settings = settingsWith();
    await storeServer(settings);
    const service = new SmtpSettingsService({
      settings,
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    for (const changed of [
      { host: 'evil.example.net' },
      { port: 25 },
      { tls: 'none' as const },
      { user: 'someone' },
    ]) {
      await expect(inInstallRequest(() => service.save(update(changed)))).rejects.toMatchObject({
        reason: 'smtp-password-required',
        status: 400,
      });
    }
    await expect(settings.get('smtp.host')).resolves.toBe('smtp.example.com');

    await inInstallRequest(() =>
      service.save(update({ host: 'new.example.net', password: 'typed' })),
    );
    await expect(settings.get('smtp.host')).resolves.toBe('new.example.net');
  });

  it('writes only what changed, and audits key names only', async () => {
    const settings = settingsWith();
    await settings.set('smtp.host', 'old.example.com', { updatedBy: ACTOR_ID });
    const service = new SmtpSettingsService({
      settings,
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    const { audits } = await inInstallRequest(() =>
      service.save(update({ host: 'old.example.com', password: 'fresh-secret' })),
    );

    // Only the keys whose value changed are recorded, and the password by name
    // only: the host is unchanged, the rest were still at their defaults.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'settings.updated',
      targetType: 'settings',
      targetId: 'smtp',
      actorId: ACTOR_ID,
    });
    expect(audits[0]?.meta).toEqual({
      keys: ['smtp.user', 'smtp.from', 'smtp.fromName', 'smtp.password'],
    });
    expect(JSON.stringify(audits)).not.toContain('fresh-secret');
    await expect(settings.get('smtp.host')).resolves.toBe('old.example.com');
  });

  it('refuses to change a key the environment pins, naming the variable', async () => {
    const service = new SmtpSettingsService({
      settings: settingsWith({ HD_SMTP_HOST: 'pinned.example.com' }),
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    await expect(
      inInstallRequest(() => service.save(update({ host: 'other.example.com' }))),
    ).rejects.toThrow('HD_SMTP_HOST locks this setting');

    await expect(inInstallRequest(() => service.read())).resolves.toMatchObject({
      result: { host: 'pinned.example.com', locked: { host: true } },
    });
  });

  it('reports a save that only re-states pinned values as saved, changing nothing', async () => {
    const settings = settingsWith({ HD_SMTP_HOST: 'pinned.example.com' });
    const service = new SmtpSettingsService({
      settings,
      limiter: asLimiter(new FakeLimiter()),
      logger: silentLogger(),
    });

    const { result } = await inInstallRequest(() =>
      service.save(update({ host: 'pinned.example.com', password: 'relay-secret' })),
    );

    expect(result).toMatchObject({ host: 'pinned.example.com', locked: { host: true } });
  });

  describe('test', () => {
    it('sends with the credentials on screen and the stored password when none is typed', async () => {
      const settings = settingsWith();
      await storeServer(settings);
      const limiter = new FakeLimiter();
      const seen: { options?: unknown; message?: EmailMessage } = {};
      const service = new SmtpSettingsService({
        settings,
        limiter: asLimiter(limiter),
        logger: silentLogger(),
        smtp: fakeTransport({ delivered: true, response: '250 Ok' }, seen),
      });

      const { result } = await inInstallRequest(() =>
        service.test(
          update({ password: undefined, fromAddress: 'lina@example.com' }),
          '203.0.113.9',
        ),
      );

      expect(result).toEqual({
        delivered: true,
        response: '250 Ok',
        recipient: 'lina@example.com',
      });
      expect((seen.options as { password: string }).password).toBe('stored-secret');
      expect((seen.options as { host: string }).host).toBe('smtp.example.com');
      expect(seen.message?.to).toEqual({ address: 'lina@example.com', name: expect.any(String) });
      expect(limiter.consumed).toEqual([`${SETUP_SMTP_TEST_IP_RULE.bucket}:203.0.113.9`]);
    });

    it('sends with the typed password when the form holds one', async () => {
      const settings = settingsWith();
      const seen: { options?: unknown; message?: EmailMessage } = {};
      const service = new SmtpSettingsService({
        settings,
        limiter: asLimiter(new FakeLimiter()),
        logger: silentLogger(),
        smtp: fakeTransport({ delivered: false, error: 'auth-failed' }, seen),
      });

      const { result } = await inInstallRequest(() =>
        service.test(update({ password: 'typed-secret' }), '203.0.113.9'),
      );

      expect(result).toMatchObject({ delivered: false, error: 'auth-failed' });
      expect((seen.options as { password: string }).password).toBe('typed-secret');
    });

    it('refuses the attempt once the per-address budget is spent', async () => {
      const limiter = new FakeLimiter();
      limiter.allow = false;
      const service = new SmtpSettingsService({
        settings: settingsWith(),
        limiter: asLimiter(limiter),
        logger: silentLogger(),
        smtp: fakeTransport({ delivered: true }),
      });

      await expect(
        inInstallRequest(() => service.test(update(), '203.0.113.9')),
      ).rejects.toMatchObject({ status: 429, retryAfter: 42 });
    });

    it('refuses a changed host with no password typed, and opens no connection', async () => {
      const settings = settingsWith();
      await storeServer(settings);
      const limiter = new FakeLimiter();
      const seen: { options?: unknown } = {};
      const service = new SmtpSettingsService({
        settings,
        limiter: asLimiter(limiter),
        logger: silentLogger(),
        smtp: fakeTransport({ delivered: true }, seen),
      });

      for (const changed of [
        { host: 'evil.example.net' },
        { port: 25 },
        { tls: 'none' as const },
        { user: 'someone' },
      ]) {
        await expect(
          inInstallRequest(() => service.test(update(changed), '203.0.113.9')),
        ).rejects.toMatchObject({ reason: 'smtp-password-required', status: 400 });
      }
      expect(seen.options).toBeUndefined();
      expect(limiter.consumed).toEqual([]);
    });

    it('sends a changed host with the password typed again', async () => {
      const settings = settingsWith();
      await storeServer(settings);
      const seen: { options?: unknown } = {};
      const service = new SmtpSettingsService({
        settings,
        limiter: asLimiter(new FakeLimiter()),
        logger: silentLogger(),
        smtp: fakeTransport({ delivered: true }, seen),
      });

      await inInstallRequest(() =>
        service.test(update({ host: 'new.example.net', password: 'typed' }), '203.0.113.9'),
      );

      expect(seen.options).toMatchObject({ host: 'new.example.net', password: 'typed' });
    });
  });
});
