import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingInviteKey } from '../auth/redis-keys.js';
import { authRedis } from '../testing/auth-redis.js';
import type { RedisStub } from '../testing/redis-stub.js';
import {
  INVITE_TTL_DAYS,
  INVITE_TTL_SECONDS,
  InviteStore,
  type PendingInvite,
} from './invite.store.js';

const BRAND = '0199f4b2-6a91-7c27-9a1f-00000000000f';
const LINA = '0199f4b2-6a91-7c27-9a1f-00000000000a';
const SAM = '0199f4b2-6a91-7c27-9a1f-00000000000b';

const record = (overrides: Partial<PendingInvite> = {}): PendingInvite => ({
  tokenHash: 'a-token-hash',
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_789_604_800_000,
  ...overrides,
});

let stub: RedisStub;
let invites: InviteStore;

beforeEach(() => {
  const created = authRedis();
  stub = created.stub;
  invites = new InviteStore(created.redis);
});

describe('the invite window', () => {
  it('is the seven days DOMAIN-RULES §12 names', () => {
    expect(INVITE_TTL_DAYS).toBe(7);
  });
});

describe('InviteStore', () => {
  it('remembers an invitation and reads it back', async () => {
    await invites.remember(BRAND, LINA, record(), INVITE_TTL_SECONDS);

    await expect(invites.read(BRAND, LINA)).resolves.toEqual(record());
  });

  it('answers null for a person with no invitation outstanding', async () => {
    await expect(invites.read(BRAND, LINA)).resolves.toBeNull();
  });

  it('keeps one brand out of another brand’s record', async () => {
    await invites.remember(BRAND, LINA, record(), INVITE_TTL_SECONDS);

    await expect(invites.read('0199f4b2-6a91-7c27-9a1f-0000000000ff', LINA)).resolves.toBeNull();
  });

  it('expires with the link it is about', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-19T10:00:00Z'));
      await invites.remember(BRAND, LINA, record(), INVITE_TTL_SECONDS);

      vi.setSystemTime(new Date('2026-09-26T10:00:01Z'));
      await expect(invites.read(BRAND, LINA)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads many people in one call and leaves out the ones with nothing', async () => {
    await invites.remember(BRAND, LINA, record({ tokenHash: 'lina' }), INVITE_TTL_SECONDS);

    const found = await invites.readMany(BRAND, [LINA, SAM]);

    expect(found.get(LINA)?.tokenHash).toBe('lina');
    expect(found.has(SAM)).toBe(false);
  });

  it('asks Redis nothing when there is nobody to ask about', async () => {
    await expect(invites.readMany(BRAND, [])).resolves.toEqual(new Map());
  });

  it('takes the record away, so the caller can kill the token exactly once', async () => {
    await invites.remember(BRAND, LINA, record(), INVITE_TTL_SECONDS);

    await expect(invites.take(BRAND, LINA)).resolves.toEqual(record());
    await expect(invites.take(BRAND, LINA)).resolves.toBeNull();
  });

  /** A record written by an older release, or by hand, must not crash the list. */
  it('ignores a record it cannot parse', async () => {
    await stub.set(pendingInviteKey(BRAND, LINA), '{"tokenHash":42}');

    await expect(invites.read(BRAND, LINA)).resolves.toBeNull();
  });

  /**
   * The record has to be enough to destroy the previous link and to print the
   * dates, and nothing more. A field added here is a field that could be the
   * token itself.
   */
  it('holds the token hash and the two dates, and nothing else', async () => {
    await invites.remember(BRAND, LINA, record({ tokenHash: 'hash-only' }), INVITE_TTL_SECONDS);

    const raw = (await stub.get(pendingInviteKey(BRAND, LINA))) ?? '';

    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'expiresAt',
      'issuedAt',
      'tokenHash',
    ]);
  });
});
