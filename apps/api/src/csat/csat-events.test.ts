import { createKeyring } from '@helpdock/config';
import type { CsatResponse, DbTransaction } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { CSAT_TOKEN_TTL_DAYS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { ClosedTicketFacts, CsatRepository } from './csat.repository.js';
import type { CsatDelivery } from './csat-delivery.js';
import {
  CSAT_EVENTS,
  createCsatRequestedHandler,
  enqueueCsatReceived,
  enqueueCsatRequested,
} from './csat-events.js';
import { CsatTokens, hashCsatToken } from './tokens.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const DEPARTMENT = '0199f4b2-3333-7000-8000-0000000000dd';
const CLOSED_AT = '2026-09-20T10:00:00.000Z';
const NOW = new Date('2026-09-20T10:00:05.000Z');

const tokens = new CsatTokens(
  createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') }),
);

const closed = (overrides: Partial<ClosedTicketFacts> = {}): ClosedTicketFacts => ({
  departmentId: DEPARTMENT,
  channel: 'email',
  contactId: null,
  closedAt: new Date(CLOSED_AT),
  mergedIntoId: null,
  deletedAt: null,
  isSpam: false,
  ...overrides,
});

type Inserted = Parameters<CsatRepository['insertSurvey']>[1];

const run = async (
  facts: ClosedTicketFacts | undefined,
  payload: unknown = {},
  { exists = false }: { exists?: boolean } = {},
) => {
  const inserted: Inserted[] = [];
  const delivered: { ticket: unknown; survey: CsatResponse }[] = [];
  const repository = {
    closedTicketFacts: () => Promise.resolve(facts),
    insertSurvey: (_tx: DbTransaction, values: Inserted) => {
      inserted.push(values);
      return Promise.resolve(exists ? undefined : ({ ...values } as unknown as CsatResponse));
    },
  } as unknown as CsatRepository;
  const delivery: Pick<CsatDelivery, 'deliver'> = {
    deliver: (_tx, _brandId, ticket, survey) => {
      delivered.push({ ticket, survey });
      return Promise.resolve('email');
    },
  };

  await createCsatRequestedHandler({ repository, tokens, delivery, now: () => NOW })({
    outboxId: 'outbox-1',
    brandId: BRAND,
    event: CSAT_EVENTS.requested,
    payload: { ticketId: TICKET, closedAt: CLOSED_AT, ...(payload as object) },
    tx: {} as DbTransaction,
    log: silentLogger,
  });

  return Object.assign(inserted, { delivered });
};

describe('the csat.requested handler', () => {
  it('creates a survey for the close, expiring thirty days on, with only the hash of its link', async () => {
    const [survey] = await run(closed());

    expect(survey).toMatchObject({
      brandId: BRAND,
      ticketId: TICKET,
      departmentId: DEPARTMENT,
      closedAt: new Date(CLOSED_AT),
      expiresAt: new Date(NOW.getTime() + CSAT_TOKEN_TTL_DAYS * 86_400_000),
    });
    expect(survey?.tokenHash).toBe(
      hashCsatToken(tokens.sign({ brandId: BRAND, surveyId: survey?.id ?? '' })),
    );
  });

  it('sends the new survey on the ticket’s channel, once', async () => {
    const { delivered } = await run(closed({ channel: 'telegram' }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.ticket).toMatchObject({ id: TICKET, channel: 'telegram' });
  });

  it('sends nothing when this close already has its survey', async () => {
    const result = await run(closed(), {}, { exists: true });

    expect(result).toHaveLength(1);
    expect(result.delivered).toEqual([]);
  });

  it.each([
    ['the ticket is gone', undefined],
    ['it was reopened', closed({ closedAt: null })],
    ['it was closed again since', closed({ closedAt: new Date('2026-09-21T00:00:00.000Z') })],
    ['it was merged since', closed({ mergedIntoId: TICKET })],
    ['it was marked as spam since', closed({ isSpam: true })],
    ['it was deleted', closed({ deletedAt: NOW })],
  ])('creates and sends nothing when %s', async (_label, facts) => {
    const result = await run(facts);

    expect([...result]).toEqual([]);
    expect(result.delivered).toEqual([]);
  });

  it('refuses a payload that is not a close', async () => {
    await expect(run(closed(), { closedAt: 'yesterday' })).rejects.toThrow();
  });
});

describe('enqueueCsatRequested', () => {
  it('writes the outbox row through the caller’s transaction', async () => {
    const rows: unknown[] = [];
    const tx = {
      insert: () => ({
        values: (row: unknown) => {
          rows.push(row);
          return { returning: () => Promise.resolve([{ id: 'outbox-1' }]) };
        },
      }),
    } as unknown as DbTransaction;

    await enqueueCsatRequested(tx, BRAND, { ticketId: TICKET, closedAt: CLOSED_AT });

    expect(rows).toEqual([
      expect.objectContaining({
        brandId: BRAND,
        event: CSAT_EVENTS.requested,
        payload: { ticketId: TICKET, closedAt: CLOSED_AT },
      }),
    ]);
  });
});

describe('enqueueCsatReceived', () => {
  const tx = (rows: unknown[]) =>
    ({
      insert: () => ({
        values: (row: unknown) => {
          rows.push(row);
          return { returning: () => Promise.resolve([{ id: 'outbox-2' }]) };
        },
      }),
    }) as unknown as DbTransaction;
  const answer = {
    ticketId: TICKET,
    surveyId: '0199f4b2-4444-7000-8000-0000000000cc',
    rating: 4,
    via: 'telegram' as const,
    ratedAt: CLOSED_AT,
  };

  it('writes the answer’s event with the ticket the rules read, and no comment', async () => {
    const rows: unknown[] = [];
    await enqueueCsatReceived(tx(rows), BRAND, answer);

    expect(rows).toEqual([
      expect.objectContaining({ brandId: BRAND, event: CSAT_EVENTS.received, payload: answer }),
    ]);
  });

  it('refuses a rating outside 1 to 5', () => {
    expect(() => enqueueCsatReceived(tx([]), BRAND, { ...answer, rating: 9 })).toThrow();
  });
});
