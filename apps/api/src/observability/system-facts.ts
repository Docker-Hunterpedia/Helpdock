import type { Db } from '@helpdock/db';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { millisSince } from './time.js';

/**
 * The readings the System page and the gauges need that are not already
 * somewhere else: the Postgres server's own facts and Redis's `INFO`.
 *
 * Neither is a tenant read. `pg_stat_activity` and `version()` are server
 * state, not rows belonging to a brand, so row-level security has nothing to
 * say about them and they are taken on the pool rather than inside the
 * request's transaction.
 *
 * The migration count is *not* here. The migration log lives in the `drizzle`
 * schema, which DOMAIN-RULES §1.5 and `0001_app_role_and_ticket_sequences.sql`
 * deliberately keep out of the runtime role's reach; the owner connection that
 * runs the migrations at boot counts them instead, and boot carries the number
 * forward.
 *
 * Everything here fails soft. A status page that 500s because one of eight
 * readings was unavailable tells an operator less than a page that shows seven
 * readings and a gap.
 */

export interface PostgresFacts {
  /** `17.6`, or null when the server did not answer. */
  readonly version: string | null;
  /** Sessions this role holds on the server, by the state Postgres reports. */
  readonly connections: ReadonlyMap<string, number>;
}

/** `PostgreSQL 17.6 (Debian …) on aarch64…` → `17.6`. */
export const postgresVersionNumber = (full: string | undefined): string | null => {
  const match = /^PostgreSQL (\d+(?:\.\d+)*)/.exec(full?.trim() ?? '');
  return match?.[1] ?? null;
};

export const readPostgresFacts = async (db: Db): Promise<PostgresFacts> => {
  const [version, connections] = await Promise.all([serverVersion(db), poolConnections(db)]);

  return { version, connections };
};

const serverVersion = async (db: Db): Promise<string | null> => {
  try {
    const rows = await db.execute<{ version: string }>(sql`SELECT version() AS version`);
    return postgresVersionNumber([...rows][0]?.version);
  } catch {
    return null;
  }
};

/**
 * The pool as Postgres sees it: sessions opened by this role against this
 * database, grouped by state. A non-superuser sees its own role's rows in
 * `pg_stat_activity`, which is exactly the set being asked about.
 *
 * It counts every replica's connections, not this process's, which is the
 * number that matters when `max_connections` is the thing about to be hit.
 */
const poolConnections = async (db: Db): Promise<ReadonlyMap<string, number>> => {
  try {
    const rows = await db.execute<{ state: string | null; connections: number }>(sql`
      SELECT coalesce(state, 'unknown') AS state, count(*)::int AS connections
      FROM pg_stat_activity
      WHERE usename = current_user AND datname = current_database()
      GROUP BY 1
    `);

    return new Map(
      [...rows].map((row) => [(row.state ?? 'unknown').replace(/ /g, '_'), row.connections]),
    );
  } catch {
    return new Map();
  }
};

export interface RedisFacts {
  readonly reachable: boolean;
  readonly version: string | null;
  readonly aofRewriteInProgress: boolean;
  readonly latencyMs: number;
}

/** One `key:value` out of a Redis `INFO` section. */
export const infoValue = (info: string, key: string): string | undefined => {
  for (const line of info.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0 && line.slice(0, separator) === key) {
      return line.slice(separator + 1).trim();
    }
  }

  return undefined;
};

/**
 * Version, whether an append-only-file rewrite is running, and how long the
 * round trip took. The AOF rewrite is the one routine Redis condition that
 * shows up as latency rather than as an error, so the page names it instead of
 * leaving an operator to wonder why a healthy Redis went slow.
 */
export const readRedisFacts = async (redis: Redis): Promise<RedisFacts> => {
  const startedAt = process.hrtime.bigint();

  try {
    const [server, persistence] = await Promise.all([
      redis.info('server'),
      redis.info('persistence'),
    ]);
    const latencyMs = millisSince(startedAt);

    return {
      reachable: true,
      version: infoValue(server, 'redis_version') ?? null,
      aofRewriteInProgress: infoValue(persistence, 'aof_rewrite_in_progress') === '1',
      latencyMs,
    };
  } catch {
    return {
      reachable: false,
      version: null,
      aofRewriteInProgress: false,
      latencyMs: millisSince(startedAt),
    };
  }
};
