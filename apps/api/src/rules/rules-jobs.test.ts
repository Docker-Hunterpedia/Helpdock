import type { Db, DbTransaction } from '@helpdock/db';
import {
  type RulesEvaluatePayload,
  rulesTimeBasedJob,
  rulesTimeBasedScheduleJob,
  silentLogger,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { RulesEngineDeps } from './engine.js';
import {
  createRulesProcessor,
  createRulesSourceHandler,
  RULES_SUBSCRIBER,
  registerRulesEventHandlers,
  scheduleTimeBasedRules,
  tickOf,
} from './rules-jobs.js';

const BRAND = '01924f00-0000-7000-8000-0000000000b1';
const TICKET = '01924f00-0000-7000-8000-0000000000c1';
const OUTBOX = '01924f00-0000-7000-8000-0000000000d1';
const RULE = '01924f00-0000-7000-8000-0000000000e1';
const MESSAGE = '01924f00-0000-7000-8000-0000000000f1';

/** A drizzle-shaped read that answers `rows` whatever it is asked, with or without a limit. */
const readsAs = <T>(rows: T[]) => {
  const where = () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
  const query = { from: () => query, where };
  return { select: () => query };
};

const handle = async (
  event: string,
  payload: Record<string, unknown>,
  tx: unknown = readsAs([]),
): Promise<RulesEvaluatePayload[]> => {
  const added: RulesEvaluatePayload[] = [];
  await createRulesSourceHandler({
    add: async (job) => {
      added.push(job);
    },
  })({
    outboxId: OUTBOX,
    brandId: BRAND,
    event,
    payload,
    tx: tx as DbTransaction,
    log: silentLogger,
  });
  return added;
};

describe('createRulesSourceHandler', () => {
  it('asks for an evaluation keyed by the outbox row, with the triggers the event stands for', async () => {
    expect(await handle('ticket.created', { ticketId: TICKET, departmentId: TICKET })).toEqual([
      {
        brandId: BRAND,
        ticketId: TICKET,
        triggers: ['ticket_created'],
        sourceOutboxId: OUTBOX,
        chain: [],
      },
    ]);
  });

  it('carries the rule chain a rule-made change arrives with', async () => {
    const [job] = await handle('ticket.updated', {
      ticketId: TICKET,
      changes: ['assignee'],
      ruleChain: [RULE],
    });

    expect(job).toMatchObject({ triggers: ['ticket_updated', 'assigned'], chain: [RULE] });
  });

  it('reads who wrote a reply before deciding whether it starts anything', async () => {
    const customer = await handle(
      'ticket.replied',
      { ticketId: TICKET, messageId: MESSAGE },
      readsAs([{ kind: 'public', authorType: 'contact' }]),
    );
    expect(customer[0]?.triggers).toEqual(['customer_replied']);

    const ruleReply = await handle(
      'ticket.replied',
      { ticketId: TICKET, messageId: MESSAGE },
      readsAs([{ kind: 'public', authorType: 'system' }]),
    );
    expect(ruleReply).toEqual([]);
  });

  it('ignores an event with no ticket in it', async () => {
    expect(await handle('sla.breached', { clock: 'resolution' })).toEqual([]);
  });
});

describe('registerRulesEventHandlers', () => {
  it("subscribes as `rules` beside each event's owner, and leaves `rule.notify` to M3-07", () => {
    const register = vi.fn();

    registerRulesEventHandlers({ add: vi.fn() }, { register });

    expect(register.mock.calls.map(([event]) => event)).toContain('ticket.created');
    expect(register.mock.calls.map(([event]) => event)).not.toContain('rule.notify');
    expect(new Set(register.mock.calls.map(([, , subscriber]) => subscriber))).toEqual(
      new Set([RULES_SUBSCRIBER]),
    );
  });
});

describe('tickOf', () => {
  it('rounds down to the five-minute tick, so two firings in one tick are one job', () => {
    expect(tickOf(new Date('2026-09-27T12:07:42.123Z'))).toBe('2026-09-27T12:05:00.000Z');
    expect(tickOf(new Date('2026-09-27T12:05:00.000Z'))).toBe('2026-09-27T12:05:00.000Z');
  });
});

describe('scheduleTimeBasedRules', () => {
  it('adds one job per active brand, with an id per brand per tick', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const db = readsAs([{ id: BRAND }]) as unknown as Db;

    const brands = await scheduleTimeBasedRules({
      db,
      queue: { add },
      now: new Date('2026-09-27T12:07:00Z'),
    });

    expect(brands).toBe(1);
    expect(add).toHaveBeenCalledWith(
      { brandId: BRAND, tick: '2026-09-27T12:05:00.000Z' },
      `rules.time_based.${BRAND}.${Date.parse('2026-09-27T12:05:00.000Z')}`,
    );
  });
});

describe('createRulesProcessor', () => {
  const processor = (db: unknown, add = vi.fn().mockResolvedValue(undefined)) =>
    createRulesProcessor({
      db: db as Db,
      log: silentLogger,
      queue: { add },
      engine: {} as RulesEngineDeps,
      now: () => new Date('2026-09-27T12:00:00Z'),
    });

  it('fans the cron tick out per brand', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await processor(
      readsAs([{ id: BRAND }]),
      add,
    )({
      name: rulesTimeBasedScheduleJob.name,
    } as Job);

    expect(add).toHaveBeenCalledOnce();
  });

  it('refuses a job it has no processor for, unrecoverably', async () => {
    await expect(processor(readsAs([]))({ name: 'rules.unknown' } as Job)).rejects.toThrow(
      UnrecoverableError,
    );
  });

  it('refuses a brand job with a payload that is not one, before opening a transaction', async () => {
    await expect(
      processor(readsAs([]))({ name: rulesTimeBasedJob.name, id: 'job-1', data: {} } as Job),
    ).rejects.toThrow(UnrecoverableError);
  });
});
