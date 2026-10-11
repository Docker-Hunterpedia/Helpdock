import { graphSubscribedApps, META_FIXTURE } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type { Db, DbTransaction, MetaAccount } from '@helpdock/db';
import {
  claimReceipt,
  type JobLogger,
  META_HEALTH_CRON,
  metaHealthReceiptKey,
  metaHealthSchedulerId,
  silentLogger,
} from '@helpdock/jobs';
import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isBrandGone } from '../brands/brand-availability.js';
import type { MetaRepository } from './meta.repository.js';
import {
  createMetaAccountChangedHandler,
  createMetaHealthProcessor,
  type MetaHealthDependencies,
  type MetaHealthScheduler,
  queueMetaHealthScheduler,
  runMetaHealth,
  scheduleAllMetaHealth,
} from './meta-health.job.js';

// The check runs in the brand's transaction with the hour's receipt; here the
// transaction is a placeholder and the receipt and the brand's state are
// doubles. The real transaction, receipt and database are in the integration suite.
vi.mock('../tenant/system-job.js', () => ({
  withSystemJob: async (
    _db: unknown,
    _brandId: string,
    _jobId: string,
    fn: (tx: object) => Promise<unknown>,
  ) => fn({}),
}));
vi.mock('../brands/brand-availability.js', () => ({ isBrandGone: vi.fn() }));
vi.mock('@helpdock/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@helpdock/jobs')>()),
  claimReceipt: vi.fn(),
}));

const brandId = '01924f00-0000-7000-8000-0000000000aa';
const accountId = '01924f00-0000-7000-8000-0000000000ac';
const TOKEN = 'EAAGjobTOKEN1234567890abcdef';
const NOW = new Date('2026-10-11T09:20:00.000Z');
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });

const row = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
  ({
    id: accountId,
    brandId,
    platform: 'messenger',
    externalId: META_FIXTURE.pageId,
    accessToken: encryptSecret(TOKEN, keyring),
    tokenExpiresAt: null,
    tokenRefreshedAt: null,
    tokenUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
    status: 'connected',
    subscribedFields: [],
    ...overrides,
  }) as MetaAccount;

const recorder = () => {
  const calls: string[] = [];
  const scheduler: MetaHealthScheduler = {
    upsert: async (account) => void calls.push(`upsert:${account.id}:${account.brandId}`),
    remove: async (id) => void calls.push(`remove:${id}`),
  };
  return { calls, scheduler };
};

describe('queueMetaHealthScheduler', () => {
  it('registers one hourly UTC scheduler per account, whose job names its brand and account', async () => {
    const upserted: unknown[] = [];
    const removed: string[] = [];
    const scheduler = queueMetaHealthScheduler({
      upsertJobScheduler: async (...args) => void upserted.push(args),
      removeJobScheduler: async (id) => void removed.push(id),
    });

    await scheduler.upsert({ id: accountId, brandId });
    await scheduler.remove(accountId);

    expect(upserted).toEqual([
      [
        `meta.health.${accountId}`,
        { pattern: '0 * * * *', tz: 'UTC' },
        expect.objectContaining({ name: 'meta.health', data: { brandId, accountId } }),
      ],
    ]);
    expect(META_HEALTH_CRON).toBe('0 * * * *');
    expect(removed).toEqual([metaHealthSchedulerId(accountId)]);
  });
});

describe('meta_account.changed', () => {
  const run = (handler: ReturnType<typeof createMetaAccountChangedHandler>, payload: object) =>
    handler({
      outboxId: 'o',
      brandId,
      event: 'meta_account.changed',
      payload: payload as Record<string, unknown>,
      tx: {} as DbTransaction,
      log: silentLogger,
    });
  const repositoryWith = (account: Partial<MetaAccount> | undefined) =>
    ({ account: async () => account }) as unknown as Pick<MetaRepository, 'account'>;

  it('starts checking an account that exists', async () => {
    const { calls, scheduler } = recorder();

    await run(
      createMetaAccountChangedHandler(repositoryWith({ id: accountId, brandId }), scheduler),
      {
        accountId,
      },
    );

    expect(calls).toEqual([`upsert:${accountId}:${brandId}`]);
  });

  it('stops checking an account that was disconnected', async () => {
    const { calls, scheduler } = recorder();

    await run(createMetaAccountChangedHandler(repositoryWith(undefined), scheduler), { accountId });

    expect(calls).toEqual([`remove:${accountId}`]);
  });

  it('refuses an event that names no account, so the outbox retries it into the failed set', async () => {
    const { scheduler } = recorder();

    await expect(
      run(createMetaAccountChangedHandler(repositoryWith(undefined), scheduler), {}),
    ).rejects.toThrow();
  });
});

describe('scheduleAllMetaHealth', () => {
  it('registers every account of every brand and says how many', async () => {
    const { calls, scheduler } = recorder();
    const listAll = vi.fn(async () => [row(), row({ id: 'second', brandId: 'other' })]);

    const count = await scheduleAllMetaHealth(
      {} as Db,
      { listAll } as unknown as Pick<MetaRepository, 'listAll'>,
      scheduler,
    );

    expect(count).toBe(2);
    expect(calls).toEqual([`upsert:${accountId}:${brandId}`, 'upsert:second:other']);
    expect(listAll).toHaveBeenCalledWith({}, 'meta.health.schedule');
  });
});

describe('runMetaHealth', () => {
  const get = vi.fn();
  const post = vi.fn();
  const repository = { account: vi.fn(), update: vi.fn(), markError: vi.fn(), listAll: vi.fn() };
  const { calls, scheduler } = recorder();
  const logged: unknown[] = [];
  const log: JobLogger = {
    info: (fields, message) => void logged.push({ fields, message }),
    warn: (fields, message) => void logged.push({ fields, message }),
    error: (fields, message) => void logged.push({ fields, message }),
  };
  const deps = (): MetaHealthDependencies => ({
    db: {} as Db,
    log,
    keyring,
    repository: repository as unknown as MetaRepository,
    graph: { get, post },
    scheduler,
    appId: async () => META_FIXTURE.appId,
    now: () => NOW,
  });
  const payload = { brandId, accountId };

  beforeEach(() => {
    calls.length = 0;
    logged.length = 0;
    get
      .mockReset()
      .mockImplementation(async (path: string) =>
        path === '/debug_token'
          ? { data: { is_valid: true, expires_at: 0 } }
          : graphSubscribedApps('messenger'),
      );
    post.mockReset();
    repository.account.mockReset().mockResolvedValue(row());
    repository.update.mockReset().mockResolvedValue(undefined);
    vi.mocked(isBrandGone).mockReset().mockResolvedValue(false);
    vi.mocked(claimReceipt).mockReset().mockResolvedValue(true);
  });

  it('claims the hour’s receipt, asks Graph with the decrypted token and writes what it found', async () => {
    const run = await runMetaHealth(deps(), payload, 'job-1');

    expect(claimReceipt).toHaveBeenCalledExactlyOnceWith({}, metaHealthReceiptKey(accountId, NOW));
    expect(get).toHaveBeenCalledWith('/debug_token', {
      token: TOKEN,
      query: { input_token: TOKEN },
    });
    expect(run).toMatchObject({ ran: true, update: { status: 'connected' } });
    expect(repository.update).toHaveBeenCalledExactlyOnceWith({}, accountId, {
      status: 'connected',
      subscriptionCheckedAt: NOW,
      subscribedFields: expect.any(Array),
    });
  });

  it('stands down when the hour’s receipt is taken, and asks Graph nothing', async () => {
    vi.mocked(claimReceipt).mockResolvedValue(false);

    expect(await runMetaHealth(deps(), payload, 'job-1')).toEqual({
      ran: false,
      reason: 'already-checked',
    });
    expect(get).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('stops scheduling an account that is gone, and checks nothing', async () => {
    repository.account.mockResolvedValue(undefined);

    expect(await runMetaHealth(deps(), payload, 'job-1')).toEqual({
      ran: false,
      reason: 'account-gone',
    });
    expect(calls).toEqual([`remove:${accountId}`]);
    expect(claimReceipt).not.toHaveBeenCalled();
  });

  it('leaves a brand in its deletion grace alone, and its scheduler in place', async () => {
    vi.mocked(isBrandGone).mockResolvedValue(true);

    expect(await runMetaHealth(deps(), payload, 'job-1')).toEqual({
      ran: false,
      reason: 'brand-gone',
    });
    expect(calls).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not write what it found about a token an operator replaced meanwhile', async () => {
    repository.account
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ tokenUpdatedAt: new Date('2026-10-11T09:20:30.000Z') }));

    expect(await runMetaHealth(deps(), payload, 'job-1')).toEqual({
      ran: false,
      reason: 'token-replaced',
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('writes nothing when Graph fails with no answer, so the receipt rolls back with it', async () => {
    get.mockRejectedValue(new Error('socket hang up'));

    await expect(runMetaHealth(deps(), payload, 'job-1')).rejects.toThrow('socket hang up');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('never logs the token', async () => {
    const processor = createMetaHealthProcessor(deps());

    await processor({ name: 'meta.health', id: 'job-1', data: payload });

    expect(logged).not.toHaveLength(0);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});

describe('createMetaHealthProcessor', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const listAll = vi.fn();
  const { calls, scheduler } = recorder();
  const processor = createMetaHealthProcessor({
    db: {} as Db,
    log,
    keyring,
    repository: { listAll } as unknown as MetaRepository,
    graph: { get: vi.fn(), post: vi.fn() },
    scheduler,
    appId: async () => '',
  });

  beforeEach(() => {
    calls.length = 0;
    listAll.mockReset().mockResolvedValue([row()]);
  });

  it('leaves a job it does not know to the next processor on the queue', () => {
    expect(processor({ name: 'stats.rollup', id: '1', data: {} })).toBeUndefined();
  });

  it('registers every account’s check again for the daily tick', async () => {
    await processor({ name: 'meta.health.schedule', id: '1', data: {} });

    expect(calls).toEqual([`upsert:${accountId}:${brandId}`]);
    expect(log.info).toHaveBeenCalledWith(
      { job: 'meta.health.schedule', accounts: 1 },
      'meta health checks scheduled',
    );
  });

  it('fails a check whose payload names no brand for good, since a retry cannot mend it', () => {
    expect(() => processor({ name: 'meta.health', id: '1', data: { accountId } })).toThrow(
      UnrecoverableError,
    );
  });
});
