import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/** A Drizzle client over the whole Helpdock schema. */
export type Db = PostgresJsDatabase<typeof schema>;

/**
 * The handle a callback gets inside {@link ../tenant.js withTenant}: the same
 * query surface as {@link Db}, bound to the transaction that carries the tenant
 * context.
 */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Connections a single api or worker replica keeps open. */
const DEFAULT_POOL_SIZE = 10;
/** Seconds an idle connection is kept, so a quiet replica releases its slots. */
const IDLE_TIMEOUT_SECONDS = 30;
/** Seconds to wait for a connection before failing, rather than hanging a request. */
const CONNECT_TIMEOUT_SECONDS = 10;

export interface CreateDbOptions {
  /** A `postgres://` URL. Runtime code passes `DATABASE_URL`, the app role. */
  readonly url: string;
  readonly max?: number;
}

export interface DbHandle {
  readonly db: Db;
  /** Closes the pool. The process should not exit before this resolves. */
  close(): Promise<void>;
}

/**
 * Opens a pool and wraps it in Drizzle. Every query made through the returned
 * client is subject to row-level security, because `DATABASE_URL` names the
 * `helpdock_app` role; `assertRuntimeRoleIsSafe` proves that at boot.
 */
export const createDb = ({ url, max = DEFAULT_POOL_SIZE }: CreateDbOptions): DbHandle => {
  const client = postgres(url, {
    max,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    // Notices are not errors, and postgres-js prints them to stdout by default,
    // which would put loose text in the JSON log stream (ARCHITECTURE §14).
    onnotice: () => {},
  });

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
};
