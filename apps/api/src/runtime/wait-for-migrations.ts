import { brands, type Db } from '@helpdock/db';
import type { Logger } from '../logging/logger.js';

/**
 * A worker does not migrate: only `APP_ROLE=api` does, under an advisory lock
 * (ARCHITECTURE §17). A worker that starts first therefore has to wait for the
 * api, or its first query fails against a schema that does not exist yet.
 *
 * It polls a table the first migration creates. `brands` is global, so the read
 * needs no tenant context, and `LIMIT 0` makes it a plan with no rows: the
 * question is whether the relation exists, not what is in it.
 */

export const MIGRATION_WAIT_TIMEOUT_MS = 60_000;
const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;
const BACKOFF_FACTOR = 1.5;

export class MigrationsNotReadyError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The database schema was not ready after ${Math.round(timeoutMs / 1000)}s. ` +
        'A worker waits for an APP_ROLE=api replica to run the migrations; start one, or check that it could.',
    );
    this.name = 'MigrationsNotReadyError';
  }
}

export interface WaitForMigrationsOptions {
  readonly db: Db;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Seam for the tests, which must not sleep for a minute to prove a timeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const waitForMigrations = async ({
  db,
  logger,
  timeoutMs = MIGRATION_WAIT_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
}: WaitForMigrationsOptions): Promise<void> => {
  const deadline = now() + timeoutMs;
  let delay = FIRST_DELAY_MS;
  let waited = false;

  for (;;) {
    try {
      await db.select().from(brands).limit(0);
      if (waited) {
        logger.info('The database schema is ready.');
      }
      return;
    } catch (error) {
      if (now() >= deadline) {
        throw new MigrationsNotReadyError(timeoutMs);
      }

      if (!waited) {
        waited = true;
        logger.info({ err: error }, 'Waiting for an api replica to run the migrations.');
      }
      await sleep(delay);
      delay = Math.min(Math.round(delay * BACKOFF_FACTOR), MAX_DELAY_MS);
    }
  }
};
