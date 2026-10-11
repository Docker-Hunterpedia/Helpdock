import type { DbTransaction } from '@helpdock/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metaSenderBlocked } from './meta-inbound-gate.js';

/**
 * The block-list question with the gate faked: what matters here is the value
 * it is asked about, which must be the one the contact's identity will carry.
 * The dedupe query is proved against Postgres in `meta-webhook.integration.test.ts`.
 */

const gate = vi.hoisted(() => ({ isSenderBlocked: vi.fn() }));
vi.mock('../ticketing/sender-gate.js', () => gate);

const tx = {} as DbTransaction;
const NOW = new Date('2026-10-11T09:00:00.000Z');
const BRAND = '01924f00-0000-7000-8000-0000000000a1';

beforeEach(() => {
  gate.isSenderBlocked.mockReset();
  gate.isSenderBlocked.mockResolvedValue({ blocked: false });
});

describe('metaSenderBlocked', () => {
  it.each([
    ['whatsapp', '106540352242922', 'US.13491208655302741918', 'US.13491208655302741918'],
    ['messenger', '112233445566778', '7654321098765432', '112233445566778:7654321098765432'],
    ['instagram', '17841400000000000', '17841499999999999', '17841400000000000:17841499999999999'],
  ] as const)(
    'asks about a %s customer by the value their identity has',
    async (platform, account, customer, value) => {
      await metaSenderBlocked(tx, { brandId: BRAND, platform, externalId: account }, customer, NOW);

      expect(gate.isSenderBlocked).toHaveBeenCalledExactlyOnceWith(
        tx,
        BRAND,
        { kind: platform, value },
        { now: NOW },
      );
    },
  );

  it('answers what the gate answers', async () => {
    const account = { brandId: BRAND, platform: 'messenger', externalId: '1' } as const;

    await expect(metaSenderBlocked(tx, account, '2', NOW)).resolves.toBe(false);

    gate.isSenderBlocked.mockResolvedValueOnce({ blocked: true, blockedSenderId: 'b1' });
    await expect(metaSenderBlocked(tx, account, '2', NOW)).resolves.toBe(true);
  });
});
