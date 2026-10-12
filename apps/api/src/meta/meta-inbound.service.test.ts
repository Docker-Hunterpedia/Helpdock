import {
  type MetaEvent,
  type MetaRoute,
  metaEnvelopeSchema,
  routeEnvelope,
} from '@helpdock/channels';
import { type MetaWebhookBody, pageDelivery, pageText } from '@helpdock/channels/testing';
import type { Db, DbTransaction, MetaAccount } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLocator, MetaRepository } from './meta.repository.js';
import {
  describeFailure,
  type MetaEventContext,
  type MetaInboundLog,
  MetaInboundService,
  type PlatformInboundService,
} from './meta-inbound.service.js';

/**
 * The service's decisions with the database faked: the transaction is a stand-in
 * whose savepoints roll back what the handler wrote. That a real route files in
 * its brand, and that the race of two deliveries ends in one record, is proved
 * against Postgres in `meta-webhook.integration.test.ts`.
 */

const seen = new Set<string>();
const blocked = new Set<string>();
vi.mock('./meta-inbound-gate.js', () => ({
  metaMessageSeen: async (_tx: unknown, _brand: string, _platform: string, messageId: string) =>
    seen.has(messageId),
  metaSenderBlocked: async (_tx: unknown, _account: unknown, customerId: string) =>
    blocked.has(customerId),
}));
vi.mock('../tenant/system-job.js', () => ({
  withSystemJob: async (_db: unknown, _brand: string, _job: string, fn: (tx: unknown) => unknown) =>
    fn(fakeTx()),
}));

const BRAND = '01924f00-0000-7000-8000-0000000000a1';
const locator: AccountLocator = {
  id: 'acc-1',
  brandId: BRAND,
  platform: 'messenger',
  externalId: '112233445566778',
};
const account = {
  id: 'acc-1',
  brandId: BRAND,
  platform: 'messenger',
  externalId: '112233445566778',
} as MetaAccount;
const NOW = new Date('2026-10-11T09:00:00.000Z');

const fakeTx = (): DbTransaction =>
  ({ transaction: async (fn: (tx: unknown) => unknown) => fn({ savepoint: true }) }) as never;

/** The one account’s events from these bodies, in order, as the webhook would cut them. */
const routeOf = (...bodies: MetaWebhookBody[]): MetaRoute => {
  const routes = bodies.flatMap((body) => routeEnvelope(metaEnvelopeSchema.parse(body)).routes);
  const [first] = routes;
  if (first === undefined) {
    throw new Error('the fixture routes nowhere');
  }
  return { ...first, events: routes.flatMap((route) => route.events) };
};

const messages = (...mids: string[]): MetaRoute => routeOf(...mids.map((mid) => pageText({ mid })));

const harness = (
  handle: PlatformInboundService['handle'] = async () => ({ outcome: 'handled' }),
) => {
  const calls: { context: MetaEventContext; event: MetaEvent }[] = [];
  const handler: PlatformInboundService = {
    handle: async (context, event) => {
      calls.push({ context, event });
      return handle(context, event);
    },
  };
  const repository = {
    account: vi.fn(async () => account as MetaAccount | undefined),
    markEvent: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
  };
  const warn = vi.fn();
  const log: MetaInboundLog = { info: vi.fn(), warn, error: vi.fn() };
  const service = new MetaInboundService({
    db: {} as Db,
    repository: repository as unknown as MetaRepository,
    handlers: { whatsapp: handler, messenger: handler, instagram: handler },
    log,
    now: () => NOW,
  });

  return { service, calls, repository, warn };
};

beforeEach(() => {
  seen.clear();
  blocked.clear();
});

describe('MetaInboundService.receive', () => {
  it('hands each event to the platform’s service in order, with the account and the time', async () => {
    const { service, calls, repository } = harness();

    const result = await service.receive(locator, messages('mid.1', 'mid.2'));

    expect(result).toEqual({
      accountId: 'acc-1',
      brandId: BRAND,
      platform: 'messenger',
      events: [{ outcome: 'handled' }, { outcome: 'handled' }],
    });
    expect(
      calls.map(({ event }) => (event.kind === 'message' ? event.messageId : event.kind)),
    ).toEqual(['mid.1', 'mid.2']);
    expect(calls.every(({ context }) => context.account === account && context.now === NOW)).toBe(
      true,
    );
    expect(repository.markEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'acc-1', NOW);
  });

  it('never shows the handler a message that was filed before', async () => {
    seen.add('mid.1');
    const { service, calls } = harness();

    const result = await service.receive(locator, messages('mid.1', 'mid.2'));

    expect(result.events).toEqual([{ outcome: 'duplicate' }, { outcome: 'handled' }]);
    expect(calls).toHaveLength(1);
  });

  it('never shows the handler a message from a blocked sender', async () => {
    blocked.add('7654321098765432');
    const { service, calls } = harness();

    const result = await service.receive(locator, messages('mid.1'));

    expect(result.events).toEqual([{ outcome: 'ignored', reason: 'blocked-sender' }]);
    expect(calls).toEqual([]);
  });

  describe('a blocked sender', () => {
    const customerId = '7654321098765432';
    const base = { platform: 'messenger', timestamp: null } as const;
    const caused: [string, MetaEvent][] = [
      [
        'reacts',
        { ...base, kind: 'reaction', customerId, messageId: 'mid.r', action: 'react', emoji: 'x' },
      ],
      [
        'edits a message',
        { ...base, kind: 'edit', customerId, messageId: 'mid.e', text: 'y', editNumber: 1 },
      ],
      [
        'sends something Helpdock cannot show',
        { ...base, kind: 'unsupported', customerId, messageId: 'mid.u', detail: null, errors: [] },
      ],
      ['unsends a message', { ...base, kind: 'deleted', customerId, messageId: 'mid.d' }],
    ];

    it.each(caused)('writes nothing and moves no window when it %s', async (_what, event) => {
      blocked.add(customerId);
      const { service, calls } = harness();

      const result = await service.receive(locator, { ...messages('mid.1'), events: [event] });

      expect(result.events).toEqual([{ outcome: 'ignored', reason: 'blocked-sender' }]);
      expect(calls).toEqual([]);
    });

    it('is not asked about what its customer did not cause: a receipt, an echo, a notice', async () => {
      blocked.add(customerId);
      const { service, calls } = harness();
      const events: MetaEvent[] = [
        { ...base, kind: 'delivery', customerId, watermark: null, mids: ['mid.9'] },
        { ...base, kind: 'read', customerId, watermark: null },
        { ...base, kind: 'policy_enforcement', action: 'block', reason: null },
      ];

      const result = await service.receive(locator, { ...messages('mid.1'), events });

      expect(result.events).toEqual([
        { outcome: 'handled' },
        { outcome: 'handled' },
        { outcome: 'handled' },
      ]);
      expect(calls).toHaveLength(3);
    });

    it('is not asked about an unsupported event that names no customer', async () => {
      blocked.add(customerId);
      const { service } = harness();
      const event: MetaEvent = {
        ...base,
        kind: 'unsupported',
        customerId: null,
        messageId: 'mid.u',
        detail: null,
        errors: [],
      };

      const result = await service.receive(locator, { ...messages('mid.1'), events: [event] });

      expect(result.events).toEqual([{ outcome: 'handled' }]);
    });
  });

  it('asks only a customer’s message for its dedupe key', async () => {
    const { service, calls } = harness();
    seen.add('mid.9');
    const delivery = routeOf(pageDelivery({ mids: ['mid.9'] }));
    expect(delivery.events[0]?.kind).toBe('delivery');

    const result = await service.receive(locator, delivery);

    expect(result.events).toEqual([{ outcome: 'handled' }]);
    expect(calls).toHaveLength(1);
  });

  it('answers a duplicate for the delivery that lost the race on the unique index', async () => {
    const { service } = harness(async (_context, event) => {
      if (event.kind === 'message' && event.messageId === 'mid.1') {
        seen.add('mid.1');
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      return { outcome: 'handled' };
    });

    const result = await service.receive(locator, messages('mid.1', 'mid.2'));

    expect(result.events).toEqual([{ outcome: 'duplicate' }, { outcome: 'handled' }]);
  });

  it('does not take a unique violation of something else for a duplicate message', async () => {
    const { service, repository } = harness(async () => {
      throw Object.assign(new Error('duplicate key on tickets_number_key'), { code: '23505' });
    });

    await expect(service.receive(locator, messages('mid.1'))).rejects.toThrow('duplicate key');
    expect(repository.markEvent).not.toHaveBeenCalled();
  });

  it('puts a failure on the account’s health line and refuses the whole route', async () => {
    const { service, repository } = harness(async (_context, event) => {
      if (event.kind === 'message' && event.messageId === 'mid.2') {
        throw new Error('boom');
      }
      return { outcome: 'handled' };
    });

    await expect(service.receive(locator, messages('mid.1', 'mid.2'))).rejects.toThrow('boom');

    expect(repository.markEvent).not.toHaveBeenCalled();
    expect(repository.markError).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'acc-1',
      'Error: boom',
      NOW,
    );
  });

  it('keeps the original failure when the health line cannot be written either', async () => {
    const { service, repository, warn } = harness(async () => {
      throw new Error('first');
    });
    repository.markError.mockRejectedValueOnce(new Error('second'));

    await expect(service.receive(locator, messages('mid.1'))).rejects.toThrow('first');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes over an account that was disconnected between the lookup and the transaction', async () => {
    const { service, calls, repository } = harness();
    repository.account.mockResolvedValueOnce(undefined);

    const result = await service.receive(locator, messages('mid.1', 'mid.2'));

    expect(result.events).toEqual([
      { outcome: 'ignored', reason: 'account-gone' },
      { outcome: 'ignored', reason: 'account-gone' },
    ]);
    expect(calls).toEqual([]);
    expect(repository.markEvent).not.toHaveBeenCalled();
  });
});

describe('describeFailure', () => {
  it('names the innermost cause, because the outer error of a failed query quotes the words', () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'PostgresError',
    });
    const outer = new Error(
      'Failed query: insert into ticket_messages ... params: my card is 4111',
      {
        cause: driver,
      },
    );

    expect(describeFailure(outer)).toBe(
      'PostgresError: duplicate key value violates unique constraint',
    );
  });

  it('names a plain error, and stringifies anything else', () => {
    expect(describeFailure(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeFailure('nope')).toBe('nope');
  });

  it('stops following a cause that loops', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });

    expect(describeFailure(a)).toMatch(/^Error: [ab]$/);
  });
});
