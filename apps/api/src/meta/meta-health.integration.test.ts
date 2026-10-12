import { GraphClient } from '@helpdock/channels';
import { FakeGraph } from '@helpdock/channels/testing';
import { createKeyring, decryptSecret, type Env, encryptSecret } from '@helpdock/config';
import {
  brands,
  createDb,
  type DbHandle,
  type DbTransaction,
  departments,
  jobReceipts,
  type MetaAccount,
  metaAccounts,
  type NewMetaAccount,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { createQueueConnection, QUEUE_NAMES, silentLogger } from '@helpdock/jobs';
import { META_SUBSCRIBED_FIELDS, META_TOKEN_KIND, type MetaPlatform } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { eq, like } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { MetaRepository } from './meta.repository.js';
import {
  createMetaAccountChangedHandler,
  createMetaHealthProcessor,
  type MetaHealthDependencies,
  type MetaHealthScheduler,
  queueMetaHealthScheduler,
  runMetaHealth,
  scheduleAllMetaHealth,
} from './meta-health.job.js';
import { NO_BUSINESS_ACCOUNT } from './meta-subscription.js';
import { refreshInstagramToken } from './meta-token-refresh.js';

/**
 * M10-10 against real Postgres and Redis, with the stand-in for Graph of M10-01.
 *
 * 1. **Subscription**: a subscription Meta dropped is restored by the job; one
 *    that is there is left alone.
 * 2. **Instagram renewal**: a token eight days old is renewed once and its
 *    expiry moves; a refusal marks the account and says so without the token.
 * 3. **The token**: a dead token marks `token_expired`, and a good one
 *    afterwards brings the account back.
 * 4. **Once an hour**: the job twice in one hour, or in two workers at once,
 *    checks once.
 * 5. **Scheduling**: one hourly scheduler per account in BullMQ, kept in step
 *    with the accounts table.
 */

const MASTER_KEY = Buffer.alloc(32, 44).toString('base64');

const APP_ID = '1234567890123456';
const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = new Date('2026-10-11T09:20:00.000Z');

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M10-10 Meta health integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/** A WhatsApp number belongs to a business account, whose id the stand-in subscribes. */
const WABA_PREFIX = '10229';

const ID_PREFIX: Readonly<Record<MetaPlatform, string>> = {
  whatsapp: '10654',
  messenger: '11223',
  instagram: '17841',
};

describe.skipIf(!hasDocker)('the Meta health check (M10-10)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let owner: DbHandle;
  let redis: Redis;
  let queue: Queue;
  let departmentA: string;
  let departmentB: string;
  let clock = START;
  const graph = new FakeGraph({ appId: APP_ID, now: () => clock });
  const repository = new MetaRepository();
  const keyring = createKeyring({ APP_MASTER_KEY: MASTER_KEY });
  let counter = 0;

  const envFor = (): Env =>
    metaEnv({ masterKey: MASTER_KEY, postgres, redis: redisContainer, graph });

  const inBrand = <T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystem(runtime.db, brandId, fn);

  const reload = async (id: string): Promise<MetaAccount> => {
    const row = await inBrand(BRAND_A, (tx) => repository.account(tx, id));
    if (row === undefined) {
      throw new Error('the account is gone');
    }
    return row;
  };

  /** A scheduler that remembers what it was asked, for the tests that are not about scheduling. */
  const calls: string[] = [];
  const noopScheduler: MetaHealthScheduler = {
    upsert: async (account) => void calls.push(`upsert:${account.id}`),
    remove: async (id) => void calls.push(`remove:${id}`),
  };

  const dependencies = (
    scheduler: MetaHealthScheduler = noopScheduler,
  ): MetaHealthDependencies => ({
    db: runtime.db,
    log: silentLogger,
    keyring,
    repository,
    graph: new GraphClient({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    }),
    scheduler,
    appId: async () => APP_ID,
    now: () => clock,
  });

  /** The id a subscription is read and written on: the business account for WhatsApp. */
  const nodeOf = (account: MetaAccount): string => account.wabaId ?? account.externalId;

  const check = (account: MetaAccount, scheduler?: MetaHealthScheduler) =>
    runMetaHealth(
      dependencies(scheduler),
      { brandId: account.brandId, accountId: account.id },
      'job',
    );

  /** An account in the stand-in and in brand A, under a token of its own. */
  const connect = async (
    platform: MetaPlatform,
    overrides: Partial<NewMetaAccount> = {},
    { subscribed = true }: { subscribed?: boolean } = {},
  ): Promise<{ account: MetaAccount; token: string }> => {
    counter += 1;
    const externalId = `${ID_PREFIX[platform]}${String(counter).padStart(8, '0')}`;
    const wabaId =
      platform === 'whatsapp' ? `${WABA_PREFIX}${String(counter).padStart(8, '0')}` : undefined;
    const token = `EAAGhealth${platform}${String(counter)}token0123456789abcdef`;
    graph.connect({
      platform,
      id: externalId,
      name: `${platform} ${String(counter)}`,
      token,
      ...(platform === 'instagram' ? { username: 'acme' } : {}),
      ...(platform === 'whatsapp' ? { displayPhone: '+1 555 010 0100' } : {}),
      ...(wabaId === undefined ? {} : { wabaId }),
    });
    if (subscribed) {
      graph.subscribe(wabaId ?? externalId);
    }
    const [account] = await inBrand(BRAND_A, (tx) =>
      tx
        .insert(metaAccounts)
        .values({
          brandId: BRAND_A,
          platform,
          departmentId: departmentA,
          externalId,
          wabaId: wabaId ?? null,
          displayName: `${platform} ${String(counter)}`,
          accessToken: encryptSecret(token, keyring),
          tokenKind: META_TOKEN_KIND[platform],
          tokenUpdatedAt: new Date(clock.getTime() - 30 * DAY),
          ...overrides,
        })
        .returning(),
    );
    if (account === undefined) {
      throw new Error('the account was not inserted');
    }

    return { account, token };
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis(), graph.start()]);
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    redis = createQueueConnection(redisContainer.getConnectionUrl());
    queue = new Queue(QUEUE_NAMES.maintenance, { connection: redis });

    await runtime.db.insert(brands).values([
      { id: BRAND_A, name: 'Acme', prefix: 'ACME' },
      { id: BRAND_B, name: 'Globex', prefix: 'GLOBEX' },
    ]);
    const seeded = await Promise.all(
      [BRAND_A, BRAND_B].map((brandId) =>
        inBrand(brandId, async (tx) => {
          const [department] = await tx
            .insert(departments)
            .values({ brandId, name: 'Support' })
            .returning({ id: departments.id });
          return department?.id ?? '';
        }),
      ),
    );
    [departmentA, departmentB] = seeded as [string, string];
  }, 300_000);

  afterAll(async () => {
    await queue?.close();
    await redis?.quit();
    await owner?.close();
    await runtime?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // A failure inside the stand-in reads to Helpdock as Meta being down, and a retry test would
  // pass on it: it is said here, in the test it happened in.
  afterEach(() => {
    expect(graph.errors).toEqual([]);
  });

  beforeEach(() => {
    clock = START;
    graph.reset();
    calls.length = 0;
  });

  // ---------------------------------------------------------- subscription

  describe('the subscription', () => {
    it('restores a subscription Meta dropped, and says when it did', async () => {
      const { account } = await connect(
        'messenger',
        { status: 'unsubscribed', lastError: 'Meta dropped the subscription', lastErrorAt: START },
        { subscribed: true },
      );
      graph.dropSubscription(nodeOf(account));
      expect(graph.subscriptionOf(nodeOf(account))).toEqual([]);

      const run = await check(account);

      expect(run.ran).toBe(true);
      expect(graph.subscriptionOf(nodeOf(account))).toEqual([...META_SUBSCRIBED_FIELDS.messenger]);
      expect(graph.callsTo('/subscribed_apps', 'POST')).toHaveLength(1);
      const row = await reload(account.id);
      expect(row).toMatchObject({
        status: 'connected',
        lastError: null,
        lastErrorAt: null,
        subscribedFields: [...META_SUBSCRIBED_FIELDS.messenger],
      });
      expect(row.subscribedAt).toEqual(clock);
      expect(row.subscriptionCheckedAt).toEqual(clock);
    });

    it('subscribes Instagram and WhatsApp again on their own roots', async () => {
      const instagram = await connect('instagram');
      const whatsapp = await connect('whatsapp');
      graph.dropSubscription(nodeOf(instagram.account));
      graph.dropSubscription(nodeOf(whatsapp.account));

      await check(instagram.account);
      await check(whatsapp.account);

      expect(graph.subscriptionOf(nodeOf(instagram.account))).toEqual([
        ...META_SUBSCRIBED_FIELDS.instagram,
      ]);
      expect(graph.subscriptionOf(nodeOf(whatsapp.account))).not.toEqual([]);
      expect((await reload(instagram.account.id)).status).toBe('connected');
      expect((await reload(whatsapp.account.id)).status).toBe('connected');
    });

    it('reads and subscribes a WhatsApp number on its business account, never on the number', async () => {
      const { account } = await connect('whatsapp');
      graph.dropSubscription(nodeOf(account));

      await check(account);

      const paths = graph.callsTo('/subscribed_apps').map((call) => call.path);
      expect(paths).toEqual(Array(3).fill(`/${account.wabaId}/subscribed_apps`));
      expect(account.wabaId).not.toBe(account.externalId);
      expect(graph.subscriptionOf(nodeOf(account))).not.toEqual([]);
    });

    it('cannot check a WhatsApp number whose business account is not on record, and asks Meta nothing', async () => {
      const { account } = await connect('whatsapp', { wabaId: null });

      expect(await check(account)).toMatchObject({ ran: true });

      expect(graph.calls).toHaveLength(0);
      expect(await reload(account.id)).toMatchObject({
        status: 'connected',
        lastError: NO_BUSINESS_ACCOUNT,
        lastErrorAt: clock,
        subscriptionCheckedAt: null,
      });
    });

    it('leaves a subscription that is there alone, and records that it looked', async () => {
      const { account } = await connect('messenger');

      await check(account);

      expect(graph.callsTo('/subscribed_apps', 'POST')).toHaveLength(0);
      const row = await reload(account.id);
      expect(row.status).toBe('connected');
      expect(row.subscriptionCheckedAt).toEqual(clock);
      expect(row.subscribedAt).toBeNull();
    });
  });

  // ------------------------------------------------------- Instagram renewal

  describe('the Instagram renewal', () => {
    it('renews a token eight days old once, and the expiry moves', async () => {
      const { account, token } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 8 * DAY),
        tokenExpiresAt: new Date(clock.getTime() + 52 * DAY),
      });

      await check(account);

      expect(graph.callsTo('/refresh_access_token')).toHaveLength(1);
      const row = await reload(account.id);
      expect(row.tokenExpiresAt).toEqual(new Date(clock.getTime() + 60 * DAY));
      expect(row.tokenRefreshedAt).toEqual(clock);
      // The row holds what Meta answered, encrypted: the stand-in issues a new string.
      const renewed = decryptSecret(row.accessToken, keyring);
      expect(renewed).not.toBe(token);
      expect(row.accessToken).not.toContain(renewed);
      expect(graph.knowsToken(renewed)).toBe(true);
      // The check's own write did not undo the renewal's.
      expect(row.status).toBe('connected');
      expect(row.subscriptionCheckedAt).toEqual(clock);
    });

    it('asks again only when a week has passed, and then with the renewed token', async () => {
      const { account } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 8 * DAY),
        tokenExpiresAt: new Date(clock.getTime() + 52 * DAY),
      });
      await check(account);
      const renewed = decryptSecret((await reload(account.id)).accessToken, keyring);

      clock = new Date(clock.getTime() + HOUR);
      await check(account);
      expect(graph.callsTo('/refresh_access_token')).toHaveLength(1);

      clock = new Date(clock.getTime() + 7 * DAY);
      await check(account);
      const asked = graph.callsTo('/refresh_access_token');
      expect(asked).toHaveLength(2);
      expect(asked[1]?.token).toBe(renewed);
    });

    it('leaves a token renewed this week alone, and an account that has none to renew', async () => {
      const young = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 2 * DAY),
      });
      const page = await connect('messenger', {
        tokenRefreshedAt: new Date(clock.getTime() - 30 * DAY),
      });

      await check(young.account);
      await check(page.account);

      expect(graph.callsTo('/refresh_access_token')).toHaveLength(0);
    });

    it('marks the account when Meta refuses, says so without the token, and keeps the token', async () => {
      const { account, token } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 8 * DAY),
        tokenExpiresAt: new Date(clock.getTime() + 52 * DAY),
      });
      graph.refuseRefresh = true;

      await check(account);

      const row = await reload(account.id);
      expect(row.lastError).toMatch(
        /^Instagram would not renew the token: 100: .*cannot be refreshed/,
      );
      expect(row.lastError).not.toContain(token);
      expect(row.lastErrorAt).toEqual(clock);
      expect(decryptSecret(row.accessToken, keyring)).toBe(token);
      expect(row.tokenExpiresAt).toEqual(account.tokenExpiresAt);
      expect(row.tokenRefreshedAt).toEqual(account.tokenRefreshedAt);
      // The token still works, so messages still flow.
      expect(row.status).toBe('connected');
    });

    it('is token_expired when Meta refuses and the row’s own expiry has passed', async () => {
      const { account } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 70 * DAY),
        tokenExpiresAt: new Date(clock.getTime() - 10 * DAY),
      });
      graph.refuseRefresh = true;

      await check(account);

      const row = await reload(account.id);
      expect(row.status).toBe('token_expired');
      expect(row.lastError).toContain('Instagram would not renew the token');
    });

    it('can be asked for by the account page: the same function, the same effect', async () => {
      const { account } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 9 * DAY),
        tokenExpiresAt: new Date(clock.getTime() + 51 * DAY),
      });

      const result = await refreshInstagramToken(
        {
          db: runtime.db,
          repository,
          keyring,
          graph: dependencies().graph,
          now: () => clock,
        },
        account,
      );

      expect(result).toEqual({
        outcome: 'refreshed',
        expiresAt: new Date(clock.getTime() + 60 * DAY),
      });
      expect((await reload(account.id)).tokenRefreshedAt).toEqual(clock);
    });
  });

  // --------------------------------------------------------------- the token

  describe('the token', () => {
    it('marks token_expired for a dead token, without the token in the error, and asks no more', async () => {
      const { account, token } = await connect('whatsapp');
      graph.expiredTokens.add(token);

      await check(account);

      const row = await reload(account.id);
      expect(row.status).toBe('token_expired');
      expect(row.lastError).toContain('190');
      expect(row.lastError).not.toContain(token);
      expect(row.lastErrorAt).toEqual(clock);
      expect(row.subscriptionCheckedAt).toBeNull();
      expect(graph.callsTo('/subscribed_apps')).toHaveLength(0);
    });

    it('marks an Instagram token Meta no longer accepts, from /me', async () => {
      const { account, token } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 8 * DAY),
      });
      graph.expiredTokens.add(token);

      await check(account);

      expect((await reload(account.id)).status).toBe('token_expired');
      expect(graph.callsTo('/refresh_access_token')).toHaveLength(0);
    });

    it('brings the account back the hour after a good token is in place', async () => {
      const { account, token } = await connect('messenger');
      graph.expiredTokens.add(token);
      await check(account);
      expect((await reload(account.id)).status).toBe('token_expired');

      graph.expiredTokens.delete(token);
      clock = new Date(clock.getTime() + HOUR);
      await check(account);

      expect(await reload(account.id)).toMatchObject({
        status: 'connected',
        lastError: null,
        lastErrorAt: null,
      });
    });

    it('writes nothing when Graph cannot be reached, so the job is asked again', async () => {
      const { account } = await connect('messenger');
      graph.failures.push({ status: 503, body: { error: { message: 'Service unavailable' } } });

      await expect(check(account)).rejects.toMatchObject({ kind: 'retry' });

      const row = await reload(account.id);
      expect(row.subscriptionCheckedAt).toBeNull();
      expect(row.lastError).toBeNull();
      // The receipt rolled back with it: the retry is a check, not a repeat.
      expect((await check(account)).ran).toBe(true);
    });
  });

  // ------------------------------------------------------------ once an hour

  describe('once an hour', () => {
    const receiptsOf = (accountId: string) =>
      owner.db
        .select({ key: jobReceipts.key })
        .from(jobReceipts)
        .where(like(jobReceipts.key, `meta.health:${accountId}:%`));

    it('runs once when the job comes twice in one hour, and again in the next', async () => {
      const { account } = await connect('messenger');
      graph.dropSubscription(nodeOf(account));

      expect((await check(account)).ran).toBe(true);
      const asked = graph.calls.length;
      clock = new Date(clock.getTime() + 30 * 60 * 1000);

      expect(await check(account)).toEqual({ ran: false, reason: 'already-checked' });
      expect(graph.calls).toHaveLength(asked);
      expect(await receiptsOf(account.id)).toEqual([
        { key: `meta.health:${account.id}:2026-10-11T09` },
      ]);

      clock = new Date(START.getTime() + HOUR);
      expect((await check(account)).ran).toBe(true);
      expect(await receiptsOf(account.id)).toHaveLength(2);
    });

    it('runs once when two workers take it at the same moment', async () => {
      const { account } = await connect('instagram', {
        tokenRefreshedAt: new Date(clock.getTime() - 8 * DAY),
        tokenExpiresAt: new Date(clock.getTime() + 52 * DAY),
      });

      const runs = await Promise.all([check(account), check(account)]);

      expect(runs.filter((run) => run.ran)).toHaveLength(1);
      expect(runs.filter((run) => !run.ran)).toEqual([{ ran: false, reason: 'already-checked' }]);
      expect(graph.callsTo('/refresh_access_token')).toHaveLength(1);
    });

    it('does the same through the processor the maintenance worker runs', async () => {
      const { account } = await connect('messenger');
      const processor = createMetaHealthProcessor(dependencies());
      const job = {
        name: 'meta.health',
        id: `repeat:meta.health.${account.id}:1`,
        data: { brandId: account.brandId, accountId: account.id },
      };

      await processor(job);
      const asked = graph.calls.length;
      await processor(job);

      expect(graph.calls).toHaveLength(asked);
    });

    it('leaves a brand in its deletion grace alone', async () => {
      const { account } = await connect('messenger');
      await owner.db
        .update(brands)
        .set({ status: 'deleting', deletedAt: new Date() })
        .where(eq(brands.id, BRAND_A));
      try {
        expect(await check(account)).toEqual({ ran: false, reason: 'brand-gone' });
        expect(graph.calls).toHaveLength(0);
        expect(await receiptsOf(account.id)).toEqual([]);
      } finally {
        await owner.db
          .update(brands)
          .set({ status: 'active', deletedAt: null })
          .where(eq(brands.id, BRAND_A));
      }
    });
  });

  // -------------------------------------------------------------- scheduling

  describe('the schedulers', () => {
    const scheduler = () => queueMetaHealthScheduler(queue);
    const inB = async (): Promise<MetaAccount> => {
      counter += 1;
      const [account] = await inBrand(BRAND_B, (tx) =>
        tx
          .insert(metaAccounts)
          .values({
            brandId: BRAND_B,
            platform: 'whatsapp',
            departmentId: departmentB,
            externalId: `${ID_PREFIX.whatsapp}${String(counter).padStart(8, '0')}`,
            wabaId: `${WABA_PREFIX}${String(counter).padStart(8, '0')}`,
            displayName: 'Globex number',
            accessToken: encryptSecret('EAAGglobextoken0123456789abcdef', keyring),
            tokenKind: 'system_user',
            tokenUpdatedAt: new Date(),
          })
          .returning(),
      );
      if (account === undefined) {
        throw new Error('the account was not inserted');
      }

      return account;
    };

    it('registers an hourly scheduler per account of every brand, each naming its own brand', async () => {
      const { account: a } = await connect('messenger');
      const b = await inB();

      const registered = await scheduleAllMetaHealth(runtime.db, repository, scheduler());

      expect(registered).toBeGreaterThanOrEqual(2);
      for (const [account, brandId] of [
        [a, BRAND_A],
        [b, BRAND_B],
      ] as const) {
        const found = await queue.getJobScheduler(`meta.health.${account.id}`);
        expect(found).toMatchObject({
          name: 'meta.health',
          pattern: '0 * * * *',
          tz: 'UTC',
          template: { data: { brandId, accountId: account.id } },
        });
      }
    });

    it('follows meta_account.changed: an account disconnected stops being checked', async () => {
      const { account } = await connect('messenger');
      const handle = createMetaAccountChangedHandler(repository, scheduler());
      const changed = (tx: DbTransaction) =>
        handle({
          outboxId: uuidv7(),
          brandId: BRAND_A,
          event: 'meta_account.changed',
          payload: { accountId: account.id },
          tx,
          log: silentLogger,
        });

      await inBrand(BRAND_A, changed);
      expect(await queue.getJobScheduler(`meta.health.${account.id}`)).toBeDefined();

      await inBrand(BRAND_A, async (tx) => {
        await repository.delete(tx, account.id);
        await changed(tx);
      });
      expect(await queue.getJobScheduler(`meta.health.${account.id}`)).toBeUndefined();
    });

    it('takes a scheduler away itself when its account turns out to be gone', async () => {
      const { account } = await connect('messenger');
      await scheduler().upsert(account);
      await inBrand(BRAND_A, (tx) => repository.delete(tx, account.id));

      expect(await check(account, scheduler())).toEqual({ ran: false, reason: 'account-gone' });
      expect(await queue.getJobScheduler(`meta.health.${account.id}`)).toBeUndefined();
    });

    it('registers every scheduler again for the daily tick', async () => {
      const { account } = await connect('messenger');
      await scheduler().remove(account.id);
      const processor = createMetaHealthProcessor(dependencies(scheduler()));

      await processor({
        name: 'meta.health.schedule',
        id: 'repeat:meta.health.schedule:1',
        data: {},
      });

      expect(await queue.getJobScheduler(`meta.health.${account.id}`)).toBeDefined();
    });
  });
});
