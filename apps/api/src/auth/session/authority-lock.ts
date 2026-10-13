import type { DbTransaction } from '@helpdock/db';
import { sql } from 'drizzle-orm';

const SESSION_AUTHORITY_NAMESPACE = 0x48445352;

/** Readers mint under a shared lock; membership writers hold the exclusive lock through commit and revocation. */
export async function lockSessionReadAuthority(tx: DbTransaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${userId}, ${SESSION_AUTHORITY_NAMESPACE}))`,
  );
}

export async function lockSessionWriteAuthority(tx: DbTransaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}, ${SESSION_AUTHORITY_NAMESPACE}))`,
  );
}
