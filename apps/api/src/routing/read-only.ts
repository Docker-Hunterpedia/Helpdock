import type { DbTransaction } from '@helpdock/db';
import { sql } from 'drizzle-orm';

/** Carries a dry run's answer out of the savepoint that is rolled back to discard it. */
class Discarded<T> extends Error {
  readonly value: T;

  constructor(value: T) {
    super('The dry run ended; nothing it did is kept');
    this.value = value;
  }
}

/**
 * Runs `run` inside a savepoint that is read-only and always rolled back
 * (M14-09: "Nothing is created, sent or logged").
 *
 * Two independent guards. The code under it writes nothing; and if a change
 * to it ever did, the database refuses the statement
 * (`cannot execute INSERT in a read-only transaction`) and, failing that, the
 * rollback discards it. `SET LOCAL` is undone with the savepoint, so the
 * request's own transaction is left exactly as it was.
 */
export const withDryRun = async <T>(
  tx: DbTransaction,
  run: (savepoint: DbTransaction) => Promise<T>,
): Promise<T> => {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql`SET LOCAL transaction_read_only = on`);
      throw new Discarded(await run(savepoint));
    });
  } catch (error) {
    if (error instanceof Discarded) {
      return error.value as T;
    }
    throw error;
  }
  /* c8 ignore next 2 -- the callback above always throws. */
  throw new Error('unreachable');
};
