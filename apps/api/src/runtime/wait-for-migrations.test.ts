import type { Db } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { MigrationsNotReadyError, waitForMigrations } from './wait-for-migrations.js';

const silentLogger = () =>
  createLogger({ env: { APP_ROLE: 'worker', NODE_ENV: 'test' }, level: 'silent' });

/** `db.select().from(table).limit(0)`, answering with whatever the script says. */
const dbThatFails = (times: number): Db => {
  let remaining = times;
  return {
    select: () => ({
      from: () => ({
        limit: () => {
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error('relation "brands" does not exist'));
          }
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;
};

describe('waitForMigrations', () => {
  it('returns at once when the schema is already there', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await waitForMigrations({ db: dbThatFails(0), logger: silentLogger(), sleep });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off between attempts, and stops as soon as the api has migrated', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await waitForMigrations({ db: dbThatFails(4), logger: silentLogger(), sleep });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 375, 563, 845]);
  });

  it('caps the delay so a long wait still polls', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await waitForMigrations({ db: dbThatFails(30), logger: silentLogger(), sleep });

    expect(sleep.mock.calls.at(-1)?.[0]).toBe(5_000);
  });

  it('gives up after the timeout rather than waiting forever', async () => {
    let clock = 0;

    await expect(
      waitForMigrations({
        db: dbThatFails(Number.POSITIVE_INFINITY),
        logger: silentLogger(),
        timeoutMs: 60_000,
        sleep: () => Promise.resolve(),
        now: () => {
          clock += 20_000;
          return clock;
        },
      }),
    ).rejects.toThrow(MigrationsNotReadyError);
  });

  it('says what an operator should check when it gives up', () => {
    expect(new MigrationsNotReadyError(60_000).message).toMatch(/APP_ROLE=api/);
  });
});
