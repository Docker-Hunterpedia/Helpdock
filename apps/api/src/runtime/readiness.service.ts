import type { Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import type { Readiness, ReadinessCheck } from '@helpdock/schemas';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DB, REDIS, SETTINGS } from './tokens.js';

/**
 * `/ready` in ARCHITECTURE §14: can this replica serve? The three things a
 * request cannot do without are the database, Redis and the settings resolver,
 * so those are the three it probes.
 *
 * The database probe is `SELECT 1`, not a table read: it asks whether the pool
 * hands out a connection, and a tenant table would need a tenant context, which
 * a public probe has no business holding.
 */
@Injectable()
export class ReadinessService {
  readonly #db: Db;
  readonly #redis: Redis;
  readonly #settings: Settings;

  constructor(
    @Inject(DB) db: Db,
    @Inject(REDIS) redis: Redis,
    @Inject(SETTINGS) settings: Settings,
  ) {
    this.#db = db;
    this.#redis = redis;
    this.#settings = settings;
  }

  async check(): Promise<Readiness> {
    const checks = await Promise.all([
      probe('database', async () => {
        await this.#db.execute(sql`SELECT 1`);
      }),
      probe('redis', async () => {
        await this.#redis.ping();
      }),
      probe('settings', async () => {
        await this.#settings.get('auth.require2fa');
      }),
    ]);

    return {
      status: checks.every((check) => check.status === 'up') ? 'ready' : 'not_ready',
      checks,
    };
  }
}

/**
 * A failed probe reports the error's name, never its message: a driver error
 * quotes the host, the port and sometimes the user it tried to connect as, and
 * `/ready` answers without a principal.
 */
const probe = async (
  name: ReadinessCheck['name'],
  run: () => Promise<void>,
): Promise<ReadinessCheck> => {
  try {
    await run();
    return { name, status: 'up' };
  } catch (error) {
    return {
      name,
      status: 'down',
      error: error instanceof Error ? error.name : 'Error',
    };
  }
};
