import { createKeyring } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import { CSAT_TOKEN_TTL_DAYS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { ClosedTicketFacts, CsatRepository } from './csat.repository.js';
import { CSAT_EVENTS, createCsatRequestedHandler, enqueueCsatRequested } from './csat-events.js';
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
  closedAt: new Date(CLOSED_AT),
  mergedIntoId: null,
  deletedAt: null,
  excludedFromReports: false,
  ...overrides,
});

type Inserted = Parameters<CsatRepository['insertSurvey']>[1];

const run = async (facts: ClosedTicketFacts | undefined, payload: unknown = {}) => {
  const inserted: Inserted[] = [];
  const repository = {
    closedTicketFacts: () => Promise.resolve(facts),
    insertSurvey: (_tx: DbTransaction, values: Inserted) => {
      inserted.push(values);
      return Promise.resolve(true);
    },
  } as unknown as CsatRepository;

  await createCsatRequestedHandler({ repository, tokens, now: () => NOW })({
    outboxId: 'outbox-1',
    brandId: BRAND,
    event: CSAT_EVENTS.requested,
    payload: { ticketId: TICKET, closedAt: CLOSED_AT, ...(payload as object) },
    tx: {} as DbTransaction,
    log: silentLogger,
  });

  return inserted;
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

  it.each([
    ['the ticket is gone', undefined],
    ['it was reopened', closed({ closedAt: null })],
    ['it was closed again since', closed({ closedAt: new Date('2026-09-21T00:00:00.000Z') })],
    ['it was merged since', closed({ mergedIntoId: TICKET })],
    ['it was marked as spam since', closed({ excludedFromReports: true })],
    ['it was deleted', closed({ deletedAt: NOW })],
  ])('creates nothing when %s', async (_label, facts) => {
    expect(await run(facts)).toEqual([]);
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
