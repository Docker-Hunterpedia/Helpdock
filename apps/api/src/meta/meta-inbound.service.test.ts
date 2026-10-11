import {
  classifyMessagingEvent,
  type MetaEvent,
  type MetaRoute,
  type MetaWebhookBody,
  metaEnvelopeSchema,
  pageDelivery,
  pageText,
  routeEnvelope,
} from '@helpdock/channels';
import type { Db, DbTransaction, MetaAccount } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLocator, MetaRepository } from './meta.repository.js';
import {
  describeFailure,
  type MetaEventContext,
  type MetaEventOutcome,
  type MetaInboundLog,
  MetaInboundService,
  type PlatformInboundService,
  unhandledInbound,
  unhandledInboundHandlers,
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

  it('runs every event in a savepoint of the route’s transaction', async () => {
    const { service, calls } = harness();

    await service.receive(locator, messages('mid.1'));

    expect(calls[0]?.context.tx).toEqual({ savepoint: true });
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

  it('asks only a customer’s message for its dedupe key and its sender', async () => {
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

describe('unhandledInbound', () => {
  it('logs what arrived, without the customer or the words, and counts it as unhandled', async () => {
    const info = vi.fn();
    const handler = unhandledInbound({ info, warn: vi.fn(), error: vi.fn() });
    const event = classifyMessagingEvent(
      {
        sender: { id: '7654321098765432' },
        message: { mid: 'mid.1', text: 'my card number is 4111' },
      },
      'messenger',
    );

    const outcome: MetaEventOutcome = await handler.handle(
      { tx: {} as never, account, now: NOW },
      event,
    );

    expect(outcome).toEqual({ outcome: 'unhandled' });
    expect(info).toHaveBeenCalledExactlyOnceWith(
      { accountId: 'acc-1', platform: 'messenger', kind: 'message' },
      expect.any(String),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('7654321098765432');
    expect(JSON.stringify(info.mock.calls)).not.toContain('4111');
  });

  it('is the default for all three platforms', () => {
    const handlers = unhandledInboundHandlers({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

    expect(Object.keys(handlers).sort()).toEqual(['instagram', 'messenger', 'whatsapp']);
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
