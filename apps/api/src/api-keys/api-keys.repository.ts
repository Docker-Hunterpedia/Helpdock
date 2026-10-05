import { type ApiKeyRow, apiKeys, type Db, type DbTransaction } from '@helpdock/db';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * The `api_keys` table (M8-01). Every method but {@link findActiveByHash}
 * takes the caller's transaction, so row-level security decides what it sees.
 * That one answers the question a request asks before any brand is known —
 * "whose key is this?" — and reads this table alone, by its unique hash.
 */

/** How stale `last_used_at` may be before a request writes it again. */
export const LAST_USED_DEBOUNCE_SECONDS = 60;

export interface ActiveApiKey {
  readonly id: string;
  readonly brandId: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
}

export class ApiKeysRepository {
  async list(tx: DbTransaction): Promise<ApiKeyRow[]> {
    return tx.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  }

  async insert(
    tx: DbTransaction,
    values: Pick<
      ApiKeyRow,
      'brandId' | 'name' | 'prefix' | 'keyHash' | 'scopes' | 'rateLimitPerMinute' | 'createdBy'
    >,
  ): Promise<ApiKeyRow> {
    const [row] = await tx.insert(apiKeys).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy throws rather than returning nothing. */
    if (row === undefined) {
      throw new Error('The API key insert returned no row');
    }
    return row;
  }

  /** Revokes a live key; answers undefined for a key that is gone or already revoked. */
  async revoke(tx: DbTransaction, keyId: string, by: string): Promise<ApiKeyRow | undefined> {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedBy: by })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning();
    return row;
  }

  async find(tx: DbTransaction, keyId: string): Promise<ApiKeyRow | undefined> {
    const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
    return row;
  }

  /**
   * The live key with this hash, in any brand, and its `last_used_at` moved
   * forward when it is more than a minute old — so a busy key costs one write
   * a minute rather than one a request.
   */
  async findActiveByHash(db: Db, keyHash: string): Promise<ActiveApiKey | undefined> {
    return withAllBrands(db, 'api-key.resolve', undefined, async (tx) => {
      const [row] = await tx
        .select({
          id: apiKeys.id,
          brandId: apiKeys.brandId,
          scopes: apiKeys.scopes,
          rateLimitPerMinute: apiKeys.rateLimitPerMinute,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      if (row === undefined) {
        return undefined;
      }

      await tx
        .update(apiKeys)
        .set({ lastUsedAt: sql`now()` })
        .where(
          and(
            eq(apiKeys.id, row.id),
            or(
              isNull(apiKeys.lastUsedAt),
              lt(
                apiKeys.lastUsedAt,
                sql`now() - make_interval(secs => ${LAST_USED_DEBOUNCE_SECONDS})`,
              ),
            ),
          ),
        );
      return row;
    });
  }
}
