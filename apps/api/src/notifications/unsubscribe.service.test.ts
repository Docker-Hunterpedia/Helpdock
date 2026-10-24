import { createKeyring } from '@helpdock/config';
import { auditLog, type Db, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '../auth/rate-limit.js';
import { issuedBeforeResubscribe, UnsubscribeService } from './unsubscribe.service.js';
import { UnsubscribeTokens } from './unsubscribe-tokens.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const USER = '0199f4b2-1111-7000-8000-000000000002';
const NOW = new Date('2026-10-21T10:00:00.000Z');
const DAY = 86_400_000;
const tokens = new UnsubscribeTokens(createKeyring({ APP_MASTER_KEY: KEY }));

interface Harness {
  readonly service: UnsubscribeService;
  readonly audits: Record<string, unknown>[];
  readonly writes: Date[];
  readonly settings: string[][];
}

const harness = ({
  account = { email: 'lina@helpdock.test', locale: 'ar' as const },
  changed = true,
  allowed = true,
  resubscribedAt = null,
}: {
  resubscribedAt?: Date | null;
  account?: { email: string; locale: 'en' | 'ar' } | null;
  changed?: boolean;
  allowed?: boolean;
} = {}): Harness => {
  const audits: Record<string, unknown>[] = [];
  const writes: Date[] = [];
  const settings: string[][] = [];
  const tx = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      settings.push((query.queryChunks ?? []).map(String));
    },
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        expect(table).toBe(auditLog);
        audits.push(values);
      },
    }),
  };
  const db = { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as Db;

  return {
    audits,
    writes,
    settings,
    service: new UnsubscribeService({
      db,
      repository: {
        activeAccount: async () => account ?? undefined,
        emailResubscribedAt: async () => resubscribedAt,
        unsubscribeEmail: async (_tx, _userId, at) => {
          writes.push(at);
          return changed;
        },
      },
      tokens,
      limiter: { consume: async () => allowed } as unknown as RateLimiter,
      now: () => NOW,
    }),
  };
};

const fresh = (): string => tokens.sign(USER, new Date(NOW.getTime() - DAY));

describe('UnsubscribeService.view', () => {
  it('shows the address and language to the holder of a token we signed, and writes nothing', async () => {
    const { service, writes, audits } = harness();

    expect(await service.view(fresh(), '203.0.113.9')).toEqual({
      state: 'confirm',
      email: 'lina@helpdock.test',
      locale: 'ar',
    });
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each([
    ['forged', `${'A'.repeat(27)}.${'A'.repeat(43)}`],
    ['expired', tokens.sign(USER, new Date(NOW.getTime() - 366 * DAY))],
    ['malformed', 'nope'],
  ])('answers 404 for a %s token, before any account is read', async (_name, token) => {
    const { service, settings } = harness();

    await expect(service.view(token, '203.0.113.9')).rejects.toBeInstanceOf(NotFoundException);
    expect(settings).toEqual([]);
  });

  it('answers the same 404 for a deactivated or deleted account as for a forged token', async () => {
    const { service } = harness({ account: null });
    const gone = await service.view(fresh(), 'ip').catch((error: unknown) => error);
    const forged = await service.view('nope', 'ip').catch((error: unknown) => error);

    expect(gone).toBeInstanceOf(NotFoundException);
    expect((gone as NotFoundException).message).toBe((forged as NotFoundException).message);
    expect((gone as NotFoundException).getStatus()).toBe((forged as NotFoundException).getStatus());
  });

  it('answers 429 past the per-address budget, whatever the token', async () => {
    const { service } = harness({ allowed: false });

    await expect(service.view(fresh(), 'ip')).rejects.toMatchObject({ status: 429 });
  });
});

describe('UnsubscribeService.unsubscribe', () => {
  it('records the unsubscribe now and one audit row at install scope, naming the email it came from', async () => {
    const { service, writes, audits } = harness();

    expect(await service.unsubscribe(fresh(), 'ip')).toEqual({ state: 'done', locale: 'ar' });
    expect(writes).toEqual([NOW]);
    expect(audits).toEqual([
      {
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: 'system',
        actorId: `unsubscribe:${USER}`,
        action: 'notification.email_unsubscribed',
        targetType: 'user',
        targetId: USER,
        meta: { tokenIssuedAt: new Date(NOW.getTime() - DAY).toISOString() },
      },
    ]);
  });

  it('answers done again on a replay and writes no second audit row', async () => {
    const { service, audits } = harness({ changed: false });

    expect(await service.unsubscribe(fresh(), 'ip')).toEqual({ state: 'done', locale: 'ar' });
    expect(audits).toEqual([]);
  });

  it('changes nothing for a forged or expired token', async () => {
    const { service, writes, audits } = harness();

    await expect(service.unsubscribe('nope', 'ip')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.unsubscribe(tokens.sign(USER, new Date(NOW.getTime() - 400 * DAY)), 'ip'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('does not unsubscribe a deactivated account', async () => {
    const { service, writes } = harness({ account: null });

    await expect(service.unsubscribe(fresh(), 'ip')).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
  });
});

describe('issuedBeforeResubscribe', () => {
  const at = new Date('2026-10-21T10:00:00.500Z');

  it.each([
    ['never resubscribed', new Date('2020-01-01T00:00:00Z'), null, false],
    ['issued a second before', new Date('2026-10-21T09:59:59.900Z'), at, true],
    ['issued days before', new Date('2026-10-18T10:00:00Z'), at, true],
    ['issued in the same second', new Date('2026-10-21T10:00:00.000Z'), at, true],
    ['issued after', new Date('2026-10-21T10:00:01.000Z'), at, false],
  ])('%s', (_name, issuedAt, resubscribedAt, expected) => {
    expect(issuedBeforeResubscribe(issuedAt, resubscribedAt)).toBe(expected);
  });
});

describe('a link issued before "Turn email back on"', () => {
  const resubscribedAt = new Date(NOW.getTime() - DAY / 2);

  it('is refused by view and unsubscribe with the 404 an unknown token gets, writing nothing', async () => {
    const { service, writes, audits } = harness({ resubscribedAt });

    await expect(service.view(fresh(), '203.0.113.9')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.unsubscribe(fresh(), '203.0.113.9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('still works when the link was issued after it', async () => {
    const { service, writes } = harness({ resubscribedAt });
    const later = tokens.sign(USER, new Date(NOW.getTime() - 1000));

    expect(await service.view(later, '203.0.113.9')).toMatchObject({ state: 'confirm' });
    expect(await service.unsubscribe(later, '203.0.113.9')).toEqual({
      state: 'done',
      locale: 'ar',
    });
    expect(writes).toEqual([NOW]);
  });
});
