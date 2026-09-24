import { createKeyring } from '@helpdock/config';
import type { CsatResponse, Db, DbTransaction } from '@helpdock/db';
import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { CsatRepository } from './csat.repository.js';
import { CsatService } from './csat.service.js';
import { CsatTokens, hashCsatToken } from './tokens.js';

/**
 * The agent's summary and the public routes' first two gates, with no
 * database: the state a survey reads as, which link the agent is shown, and
 * that a refused request never opens a transaction. The integration suite
 * proves the rest over real rows.
 */

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const SURVEY = '0199f4b2-1111-7000-8000-00000000c5a7';
const NOW = new Date('2026-09-20T10:00:00.000Z');
const APP_URL = 'https://support.example.com';

const CURRENT = Buffer.alloc(32, 1).toString('base64');
const PREVIOUS = Buffer.alloc(32, 2).toString('base64');
const OLDER = Buffer.alloc(32, 3).toString('base64');

const rotated = new CsatTokens(
  createKeyring({ APP_MASTER_KEY: CURRENT, APP_MASTER_KEY_PREVIOUS: PREVIOUS }),
);
const signedUnder = (key: string): string =>
  new CsatTokens(createKeyring({ APP_MASTER_KEY: key })).sign({ brandId: BRAND, surveyId: SURVEY });

const survey = (overrides: Partial<CsatResponse> = {}): CsatResponse => ({
  id: SURVEY,
  brandId: BRAND,
  ticketId: TICKET,
  departmentId: '0199f4b2-3333-7000-8000-0000000000dd',
  closedAt: NOW,
  tokenHash: hashCsatToken(signedUnder(CURRENT)),
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  sentAt: null,
  rating: null,
  comment: null,
  ratedAt: null,
  createdAt: NOW,
  ...overrides,
});

/** A database that fails the test if anybody opens a transaction on it. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the database was reached');
    },
  },
) as Db;

const service = ({ stored, allowed = true }: { stored?: CsatResponse; allowed?: boolean }) =>
  new CsatService({
    db: untouchable,
    repository: {
      latestForTicket: () => Promise.resolve(stored),
    } as unknown as CsatRepository,
    tokens: rotated,
    limiter: { consume: () => Promise.resolve(allowed) } as unknown as RateLimiter,
    appUrl: APP_URL,
    now: () => NOW,
  });

const tx = {} as DbTransaction;

describe('CsatService.forTicket', () => {
  it('is null for a ticket that has never been asked', async () => {
    expect(await service({}).forTicket(tx, BRAND, TICKET)).toBeNull();
  });

  it('shows a pending survey with the link under the current key', async () => {
    const summary = await service({ stored: survey() }).forTicket(tx, BRAND, TICKET);

    expect(summary).toMatchObject({ state: 'pending', rating: null });
    expect(summary?.link).toBe(`${APP_URL}/csat/${signedUnder(CURRENT)}`);
  });

  it('keeps showing a link issued before a key rotation', async () => {
    const summary = await service({
      stored: survey({ tokenHash: hashCsatToken(signedUnder(PREVIOUS)) }),
    }).forTicket(tx, BRAND, TICKET);

    expect(summary?.link).toBe(`${APP_URL}/csat/${signedUnder(PREVIOUS)}`);
  });

  it('shows no link once the key that signed it is gone', async () => {
    const summary = await service({
      stored: survey({ tokenHash: hashCsatToken(signedUnder(OLDER)) }),
    }).forTicket(tx, BRAND, TICKET);

    expect(summary).toMatchObject({ state: 'pending', link: null });
  });

  it('reads as sent once a channel delivered it', async () => {
    const summary = await service({ stored: survey({ sentAt: NOW }) }).forTicket(tx, BRAND, TICKET);

    expect(summary?.state).toBe('sent');
  });

  it('reads as rated, with the answer and without a link', async () => {
    const summary = await service({
      stored: survey({ rating: 2, comment: 'Slow.', ratedAt: NOW }),
    }).forTicket(tx, BRAND, TICKET);

    expect(summary).toMatchObject({ state: 'rated', rating: 2, comment: 'Slow.', link: null });
  });

  it('reads as expired, without a link, once thirty days have passed', async () => {
    const summary = await service({ stored: survey({ expiresAt: NOW }) }).forTicket(
      tx,
      BRAND,
      TICKET,
    );

    expect(summary).toMatchObject({ state: 'expired', link: null });
  });
});

describe('the public routes’ gates', () => {
  it('answers 429 past the address’s budget, before verifying anything', async () => {
    const refused = service({ allowed: false }).view(signedUnder(CURRENT), '203.0.113.9');

    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({ status: 429 });
  });

  it('answers 404 to a token no key of ours signed, without touching the database', async () => {
    await expect(
      service({}).submit(signedUnder(OLDER), '203.0.113.9', { rating: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
