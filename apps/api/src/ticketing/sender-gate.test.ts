import type { BlockedSender as BlockedSenderRow, DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import type { BlockListRepository } from './block-list.repository.js';
import type { SenderKey } from './block-rules.js';
import { findBlockingEntry, isSenderBlocked } from './sender-gate.js';

/**
 * The gate's decisions, with the repository faked. That the lookup and the
 * increment really run against Postgres, under the brand's policy, is proved in
 * `ticketing.integration.test.ts`.
 */

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const tx = {} as DbTransaction;

const row = (id: string, kind: SenderKey['kind'], value: string): BlockedSenderRow =>
  ({ id, brandId: BRAND, kind, value, droppedCount: 0 }) as BlockedSenderRow;

const repositoryHolding = (rows: readonly BlockedSenderRow[]) => {
  const matching = vi.fn(async (_tx: DbTransaction, _brand: string, keys: readonly SenderKey[]) =>
    rows.filter((candidate) =>
      keys.some((key) => key.kind === candidate.kind && key.value === candidate.value),
    ),
  );
  const recordDrop = vi.fn(async (_tx: DbTransaction, _id: string, _at: Date) => undefined);

  return {
    repository: { matching, recordDrop } as unknown as BlockListRepository,
    matching,
    recordDrop,
  };
};

describe('isSenderBlocked', () => {
  it('drops mail from a blocked domain, and charges the drop to that row', async () => {
    const { repository, recordDrop } = repositoryHolding([row('b1', 'domain', 'promo-deals.biz')]);

    const result = await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'email', value: 'Deals@News.Promo-Deals.biz' },
      { repository, now: NOW },
    );

    expect(result).toEqual({ blocked: true, blockedSenderId: 'b1' });
    expect(recordDrop).toHaveBeenCalledWith(tx, 'b1', NOW);
  });

  it('charges only the most specific row when an address and its domain are both blocked', async () => {
    const { repository, recordDrop } = repositoryHolding([
      row('domain', 'domain', 'promo-deals.biz'),
      row('address', 'email', 'spam@promo-deals.biz'),
    ]);

    await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'email', value: 'spam@promo-deals.biz' },
      {
        repository,
      },
    );

    expect(recordDrop).toHaveBeenCalledTimes(1);
    expect(recordDrop.mock.calls[0]?.[1]).toBe('address');
  });

  it('normalises a phone number with the brand’s calling code before it looks', async () => {
    const { repository } = repositoryHolding([row('p1', 'phone', '+963931234567')]);

    const result = await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'phone', value: '0931 234 567' },
      { repository, defaultCallingCode: '963' },
    );

    expect(result.blocked).toBe(true);
  });

  it.each([
    ['whatsapp', 'US.13491208655302741918'],
    ['messenger', '112233445566778:7654321098765432'],
    ['instagram', '17841400000000000:17841499999999999'],
  ] as const)('drops a blocked %s customer by the id Meta gave', async (kind, value) => {
    const { repository, recordDrop } = repositoryHolding([row('m1', kind, value)]);

    const result = await isSenderBlocked(tx, BRAND, { kind, value }, { repository, now: NOW });

    expect(result).toEqual({ blocked: true, blockedSenderId: 'm1' });
    expect(recordDrop).toHaveBeenCalledExactlyOnceWith(tx, 'm1', NOW);
  });

  it('does not fold the case of a Meta id: another case is another customer', async () => {
    const { repository } = repositoryHolding([row('m1', 'whatsapp', 'US.13491208655302741918')]);

    const result = await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'whatsapp', value: 'us.13491208655302741918' },
      { repository },
    );

    expect(result).toEqual({ blocked: false });
  });

  it('lets a sender through when nothing matches, and writes nothing', async () => {
    const { repository, recordDrop } = repositoryHolding([row('t1', 'telegram', '42')]);

    const result = await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'telegram', value: '43' },
      {
        repository,
      },
    );

    expect(result).toEqual({ blocked: false });
    expect(recordDrop).not.toHaveBeenCalled();
  });

  it('lets through a value that does not normalise, without a query', async () => {
    const { repository, matching } = repositoryHolding([]);

    const result = await isSenderBlocked(
      tx,
      BRAND,
      { kind: 'email', value: 'not an address' },
      {
        repository,
      },
    );

    expect(result).toEqual({ blocked: false });
    expect(matching).not.toHaveBeenCalled();
  });
});

describe('findBlockingEntry', () => {
  it('finds the most specific row and charges nothing (Test routing, M14-09)', async () => {
    const { repository, recordDrop } = repositoryHolding([
      row('domain', 'domain', 'promo-deals.biz'),
      row('address', 'email', 'spam@promo-deals.biz'),
    ]);

    const found = await findBlockingEntry(
      tx,
      BRAND,
      { kind: 'email', value: 'Spam@Promo-Deals.biz' },
      { repository },
    );

    expect(found?.id).toBe('address');
    expect(recordDrop).not.toHaveBeenCalled();
  });

  it('answers nothing for a sender who is not listed or whose identifier does not normalise', async () => {
    const { repository, matching } = repositoryHolding([
      row('b1', 'email', 'spam@promo-deals.biz'),
    ]);

    const unlisted = await findBlockingEntry(
      tx,
      BRAND,
      { kind: 'email', value: 'friend@example.com' },
      { repository },
    );
    const malformed = await findBlockingEntry(
      tx,
      BRAND,
      { kind: 'email', value: 'not an address' },
      { repository },
    );

    expect(unlisted).toBeUndefined();
    expect(malformed).toBeUndefined();
    expect(matching).toHaveBeenCalledTimes(1);
  });
});
