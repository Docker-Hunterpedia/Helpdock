import type { EmailMessage } from '@helpdock/channels';
import type { Settings } from '@helpdock/config';
import {
  createKeyring,
  createSettings,
  type Env,
  InMemorySettingsStore,
  type Invalidation,
} from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type { SmtpCredentials, SmtpTestResult } from '@helpdock/schemas';
import { ConflictException, HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import type { SessionService } from '../auth/session/session.service.js';
import { authRedis } from '../testing/auth-redis.js';
import { silentLogger } from '../testing/silent-logger.js';
import { SETUP_IP_RULE, SETUP_SMTP_TEST_IP_RULE, SetupService } from './setup.service.js';
import { SetupTokenStore } from './setup-token.store.js';

/**
 * The decisions the wizard makes that do not need a database to observe: who is
 * turned away, what is written to settings, and what a failed SMTP attempt is
 * reported as. The rows, the advisory lock and the row-level security they run
 * under are proved against a real Postgres in `setup.integration.test.ts`.
 */

const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
const IP = '198.51.100.7';

const ADMIN = {
  id: uuidv7(),
  name: 'Lina',
  email: 'lina@example.com',
  locale: 'en' as const,
};

const credentials: SmtpCredentials = {
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls',
  user: 'postmaster',
  password: 'relay-secret',
  fromAddress: 'support@example.com',
  fromName: 'Acme Support',
};

interface Insert {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

/**
 * The three query shapes this service makes, and nothing else: a double that
 * invented more would be testing itself. `tableName` comes from Drizzle's own
 * symbol, so a renamed table breaks the assertion rather than the double.
 */
const tableNameOf = (table: unknown): string => {
  const symbol = Object.getOwnPropertySymbols(table).find((candidate) =>
    candidate.description?.includes('Name'),
  );

  return symbol === undefined ? 'unknown' : String((table as Record<symbol, unknown>)[symbol]);
};

const fakeDb = (users: readonly Record<string, unknown>[]): { db: Db; inserts: Insert[] } => {
  const inserts: Insert[] = [];

  const rows = () => Promise.resolve([...users]);
  const selectBuilder = {
    from: () => ({
      limit: rows,
      where: () => ({ limit: rows }),
    }),
  };

  const tx = {
    execute: () => Promise.resolve(undefined),
    select: () => selectBuilder,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: tableNameOf(table), values });
        return Promise.resolve(undefined);
      },
    }),
  };

  const db = {
    select: () => selectBuilder,
    transaction: (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
  };

  return { db: db as unknown as Db, inserts };
};

const noInvalidation: Invalidation = {
  publish: () => Promise.resolve(),
  subscribe: () => () => {},
  close: () => Promise.resolve(),
};

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring: createKeyring({ APP_MASTER_KEY: MASTER_KEY } as Env),
    invalidation: noInvalidation,
  });

/**
 * Never reached here: the only caller is `createBrand`, and the cases in this
 * file stop before it. Opening a real session is what the integration suite and
 * the api browser test do.
 */
const sessions = {
  open: () => Promise.reject(new Error('the unit suite never opens a session')),
} as unknown as SessionService;

interface Harness {
  readonly service: SetupService;
  readonly settings: Settings;
  readonly tokens: SetupTokenStore;
  readonly inserts: Insert[];
  readonly sent: EmailMessage[];
  smtpResult: SmtpTestResult;
  readonly smtpOptions: SmtpCredentials[];
  readonly closed: () => number;
}

const harness = ({
  users = [ADMIN],
  env = {},
}: {
  users?: readonly Record<string, unknown>[];
  env?: Record<string, string>;
} = {}): Harness => {
  const { redis } = authRedis();
  const { db, inserts } = fakeDb(users);
  const settings = settingsWith(env);
  const tokens = new SetupTokenStore(redis);
  const sent: EmailMessage[] = [];
  const smtpOptions: SmtpCredentials[] = [];
  let closes = 0;

  const state: Harness = {
    settings,
    tokens,
    inserts,
    sent,
    smtpOptions,
    smtpResult: { delivered: true, response: '250 2.0.0 Ok' },
    closed: () => closes,
    service: new SetupService({
      db,
      settings,
      hasher: new PasswordHasher(Buffer.from(MASTER_KEY, 'base64')),
      sessions,
      tokens,
      limiter: new RateLimiter(redis),
      logger: silentLogger(),
      smtp: (options) => {
        smtpOptions.push(options);
        return {
          test: (message) => {
            sent.push(message);
            return Promise.resolve(state.smtpResult);
          },
          close: () => {
            closes += 1;
          },
        };
      },
    }),
  };

  return state;
};

const withToken = async (state: Harness): Promise<string> =>
  (await state.tokens.issue({ userId: ADMIN.id, email: ADMIN.email, brandId: null })).token;

describe('the wizard once the install is configured', () => {
  it('refuses to create a second admin', async () => {
    const state = harness();

    await expect(
      state.service.createAdmin(
        { name: 'Mo', email: 'mo@example.com', password: 'a very long passphrase', locale: 'en' },
        { ip: IP },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    [
      'brand',
      (state: Harness, token: string | undefined) =>
        state.service.createBrand(
          { name: 'Acme', prefix: 'ACME', defaultLocale: 'en', timezone: 'UTC' },
          { ip: IP, token, userAgent: undefined },
        ),
    ],
    [
      'smtp',
      (state: Harness, token: string | undefined) =>
        state.service.saveSmtp({ skip: true }, { ip: IP, token }),
    ],
    [
      'smtp test',
      (state: Harness, token: string | undefined) =>
        state.service.testSmtp(credentials, { ip: IP, token }),
    ],
    [
      'complete',
      (state: Harness, token: string | undefined) => state.service.complete({ ip: IP, token }),
    ],
  ])('refuses %s without a wizard token', async (_name, call) => {
    const state = harness();

    await expect(call(state, undefined)).rejects.toBeInstanceOf(ConflictException);
  });

  it('says the same thing for a spent token as for a configured install', async () => {
    const state = harness();
    const token = await withToken(state);

    await state.service.complete({ ip: IP, token });

    // Telling the two apart would say something about the install to somebody
    // who is not in it.
    await expect(state.service.complete({ ip: IP, token })).rejects.toThrow(
      'This install has already been set up',
    );
  });
});

describe('the per-address limit', () => {
  it('refuses the wizard with 429 once the budget is gone', async () => {
    const state = harness();
    const token = await withToken(state);

    for (let attempt = 0; attempt < SETUP_IP_RULE.limit; attempt += 1) {
      await state.service.saveSmtp({ skip: true }, { ip: IP, token }).catch(() => undefined);
    }

    const refusal = await state.service
      .saveSmtp({ skip: true }, { ip: IP, token })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(HttpException);
    expect((refusal as HttpException).getStatus()).toBe(429);
  });

  it('counts the SMTP test against a second, tighter budget of its own', async () => {
    const state = harness();
    const token = await withToken(state);

    for (let attempt = 0; attempt < SETUP_SMTP_TEST_IP_RULE.limit; attempt += 1) {
      await state.service.testSmtp(credentials, { ip: IP, token });
    }

    await expect(state.service.testSmtp(credentials, { ip: IP, token })).rejects.toBeInstanceOf(
      HttpException,
    );
    // The wider budget is untouched by ten tests, so the step itself still works.
    await expect(state.service.saveSmtp({ skip: true }, { ip: IP, token })).resolves.toBeDefined();
  });

  it('gives a different address its own budget', async () => {
    const state = harness();
    const token = await withToken(state);

    for (let attempt = 0; attempt < SETUP_IP_RULE.limit; attempt += 1) {
      await state.service.saveSmtp({ skip: true }, { ip: IP, token });
    }

    await expect(
      state.service.saveSmtp({ skip: true }, { ip: '203.0.113.9', token }),
    ).resolves.toEqual({ configured: false });
  });
});

describe('saving the SMTP settings', () => {
  let state: Harness;
  let token: string;

  beforeEach(async () => {
    state = harness();
    token = await withToken(state);
  });

  it('writes every field, with the password encrypted', async () => {
    await expect(
      state.service.saveSmtp({ ...credentials, skip: false }, { ip: IP, token }),
    ).resolves.toEqual({ configured: true });

    await expect(state.settings.get('smtp.host')).resolves.toBe('smtp.example.com');
    await expect(state.settings.get('smtp.port')).resolves.toBe(587);
    await expect(state.settings.get('smtp.tls')).resolves.toBe('starttls');
    await expect(state.settings.get('smtp.user')).resolves.toBe('postmaster');
    await expect(state.settings.get('smtp.from')).resolves.toBe('support@example.com');
    await expect(state.settings.get('smtp.fromName')).resolves.toBe('Acme Support');
    await expect(state.settings.get('smtp.password')).resolves.toBe('relay-secret');
  });

  it('writes nothing at all when the step is skipped', async () => {
    await expect(state.service.saveSmtp({ skip: true }, { ip: IP, token })).resolves.toEqual({
      configured: false,
    });

    await expect(state.settings.get('smtp.host')).resolves.toBe('');
  });

  it('records the decision in the install audit log, without the credentials', async () => {
    await state.service.saveSmtp({ ...credentials, skip: false }, { ip: IP, token });

    const row = state.inserts.find((insert) => insert.table === 'audit_log');
    expect(row?.values).toMatchObject({
      action: 'install.setup.smtp',
      actorType: 'system',
      targetType: 'setting',
    });
    expect(JSON.stringify(row?.values)).not.toContain('relay-secret');
    expect(JSON.stringify(row?.values)).not.toContain('postmaster');
  });

  it('leaves a key the environment pinned alone, and says which', async () => {
    const pinned = harness({ env: { HD_SMTP_HOST: 'relay.internal' } });
    const pinnedToken = await withToken(pinned);

    await pinned.service.saveSmtp({ ...credentials, skip: false }, { ip: IP, token: pinnedToken });

    await expect(pinned.settings.get('smtp.host')).resolves.toBe('relay.internal');
    await expect(pinned.settings.get('smtp.port')).resolves.toBe(587);
    expect(pinned.inserts.find((insert) => insert.table === 'audit_log')?.values).toMatchObject({
      meta: expect.objectContaining({ lockedByEnvironment: ['smtp.host'] }),
    });
  });
});

describe('the SMTP test', () => {
  it('sends to the admin’s own address, in their own language', async () => {
    const state = harness({
      users: [{ ...ADMIN, locale: 'ar' }],
    });
    const token = await withToken(state);

    await expect(state.service.testSmtp(credentials, { ip: IP, token })).resolves.toEqual({
      delivered: true,
      response: '250 2.0.0 Ok',
    });

    expect(state.sent[0]?.to.address).toBe(ADMIN.email);
    expect(state.sent[0]?.locale).toBe('ar');
    expect(state.smtpOptions[0]).toEqual(credentials);
  });

  it('reports a refusal as a code the screen has a sentence for', async () => {
    const state = harness();
    const token = await withToken(state);
    state.smtpResult = { delivered: false, error: 'auth-failed' };

    await expect(state.service.testSmtp(credentials, { ip: IP, token })).resolves.toEqual({
      delivered: false,
      error: 'auth-failed',
    });
  });

  it('closes the transport whatever happened, so a retry leaves no socket behind', async () => {
    const state = harness();
    const token = await withToken(state);

    await state.service.testSmtp(credentials, { ip: IP, token });
    state.smtpResult = { delivered: false, error: 'timeout' };
    await state.service.testSmtp(credentials, { ip: IP, token });

    expect(state.closed()).toBe(2);
  });

  it('refuses when the account went away while the wizard was open', async () => {
    const state = harness({ users: [] });
    const token = await withToken(state);

    await expect(state.service.testSmtp(credentials, { ip: IP, token })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('finishing', () => {
  it('reports whether this install requires a second factor', async () => {
    const state = harness();
    const token = await withToken(state);
    await state.settings.set('auth.require2fa', true, { updatedBy: 'test' });

    await expect(state.service.complete({ ip: IP, token })).resolves.toEqual({ require2fa: true });
  });

  it('defaults to not requiring one, which is the registry’s default', async () => {
    const state = harness();
    const token = await withToken(state);

    await expect(state.service.complete({ ip: IP, token })).resolves.toEqual({ require2fa: false });
  });
});
