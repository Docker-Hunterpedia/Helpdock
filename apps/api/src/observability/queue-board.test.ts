import type { Db } from '@helpdock/db';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisStub } from '../testing/redis-stub.js';
import { QUEUE_BOARD_PATH, QueueBoardAccess } from './queue-board.js';

const USER = '01924f00-0000-7000-8000-0000000000aa';
const FAMILY = 'family-1';

/** `select … from users where … limit` answering whether the account is an active install admin. */
const usersDb = (installAdmin: () => boolean): Db =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (installAdmin() ? [{ id: USER }] : []) }),
      }),
    }),
  }) as unknown as Db;

const setup = (
  options: { installAdmin?: () => boolean; familyUser?: () => string | null } = {},
) => {
  const redis = new RedisStub();
  const access = new QueueBoardAccess({
    redis: redis as unknown as Redis,
    db: usersDb(options.installAdmin ?? (() => true)),
    families: { userOfFamily: async () => (options.familyUser ?? (() => USER))() },
  });
  return { access };
};

const passOf = (url: string): string =>
  new URL(url, 'https://x.test').searchParams.get('pass') ?? '';

describe('QueueBoardAccess', () => {
  it('turns a pass into a session once, and the session opens the board', async () => {
    const { access } = setup();
    const url = await access.issuePass({ userId: USER, familyId: FAMILY });
    expect(url.startsWith(`${QUEUE_BOARD_PATH}/_session?pass=`)).toBe(true);

    const session = await access.openSession(passOf(url));

    expect(session).not.toBeNull();
    expect(await access.allows(session ?? undefined)).toBe(true);
    expect(await access.openSession(passOf(url))).toBeNull();
  });

  it('refuses no session, a made-up one and a malformed one', async () => {
    const { access } = setup();

    expect(await access.allows(undefined)).toBe(false);
    expect(await access.allows('a'.repeat(32))).toBe(false);
    expect(await access.allows('not a token!')).toBe(false);
    expect(await access.openSession('../../etc')).toBeNull();
  });

  it('closes the board when the admin signs out', async () => {
    let signedIn = true;
    const { access } = setup({ familyUser: () => (signedIn ? USER : null) });
    const session = await access.openSession(
      passOf(await access.issuePass({ userId: USER, familyId: FAMILY })),
    );
    signedIn = false;

    expect(await access.allows(session ?? undefined)).toBe(false);
  });

  it('closes the board when the account stops being an active install admin', async () => {
    let installAdmin = true;
    const { access } = setup({ installAdmin: () => installAdmin });
    const session = await access.openSession(
      passOf(await access.issuePass({ userId: USER, familyId: FAMILY })),
    );
    installAdmin = false;

    expect(await access.allows(session ?? undefined)).toBe(false);
  });
});
