import { type ApiIdempotencyKeyRow, apiIdempotencyKeys, type DbTransaction } from '@helpdock/db';
import { and, eq, lt, sql } from 'drizzle-orm';

/** How long an `Idempotency-Key` answers with its first response (M8-02). */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

/** The `api_idempotency_keys` table, always through the request's own transaction. */
export class IdempotencyRepository {
  /** Forgets the brand's keys older than the window, so an old key starts over. */
  async purgeExpired(tx: DbTransaction): Promise<void> {
    await tx
      .delete(apiIdempotencyKeys)
      .where(
        lt(
          apiIdempotencyKeys.createdAt,
          sql`now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`,
        ),
      );
  }

  /**
   * Takes the key for this request, or answers undefined when another request
   * holds it. A concurrent request with the same key waits here on the unique
   * index until the first one's transaction ends, so it never runs twice.
   */
  async claim(
    tx: DbTransaction,
    values: Pick<ApiIdempotencyKeyRow, 'brandId' | 'apiKeyId' | 'key' | 'requestHash'>,
  ): Promise<string | undefined> {
    const [row] = await tx
      .insert(apiIdempotencyKeys)
      .values(values)
      .onConflictDoNothing({ target: [apiIdempotencyKeys.apiKeyId, apiIdempotencyKeys.key] })
      .returning({ id: apiIdempotencyKeys.id });
    return row?.id;
  }

  async complete(tx: DbTransaction, id: string, response: string): Promise<void> {
    await tx.update(apiIdempotencyKeys).set({ response }).where(eq(apiIdempotencyKeys.id, id));
  }

  async find(
    tx: DbTransaction,
    apiKeyId: string,
    key: string,
  ): Promise<ApiIdempotencyKeyRow | undefined> {
    const [row] = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(and(eq(apiIdempotencyKeys.apiKeyId, apiKeyId), eq(apiIdempotencyKeys.key, key)))
      .limit(1);
    return row;
  }
}
