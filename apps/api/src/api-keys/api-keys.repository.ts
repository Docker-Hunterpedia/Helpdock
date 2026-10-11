import { type ApiKeyRow, apiKeys, type Db, type DbTransaction, users } from '@helpdock/db';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * The `api_keys` table (M8-01). Every method but {@link findByHash}
 * takes the caller's transaction, so row-level security decides what it sees.
 * That one answers the question a request asks before any brand is known —
 * "whose key is this?" — and reads this table alone, by its unique hash.
 */

/** How stale `last_used_at` may be before a request writes it again. */
export const LAST_USED_DEBOUNCE_SECONDS = 60;

/** Whether a key may be used, as the database judged it when it was read. */
export type ApiKeyState = 'active' | 'revoked' | 'expired';

/** A key Helpdock issued, with what the resolver needs to accept it or to say why it did not. */
export interface KnownApiKey {
  readonly id: string;
  readonly brandId: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly state: ApiKeyState;
}

/** A key that exists and may not be used. */
export type EndedApiKey = KnownApiKey & { readonly state: Exclude<ApiKeyState, 'active'> };

export const isEnded = (key: KnownApiKey): key is EndedApiKey => key.state !== 'active';

/** A key with the names of the staff who issued and revoked it, for the Developers page. */
export interface ApiKeyWithNames {
  readonly key: ApiKeyRow;
  readonly createdByName: string | null;
  readonly revokedByName: string | null;
}

const creators = alias(users, 'api_key_creators');
const revokers = alias(users, 'api_key_revokers');

export class ApiKeysRepository {
  async list(tx: DbTransaction): Promise<ApiKeyWithNames[]> {
    return tx
      .select({ key: apiKeys, createdByName: creators.name, revokedByName: revokers.name })
      .from(apiKeys)
      .leftJoin(creators, eq(creators.id, apiKeys.createdBy))
      .leftJoin(revokers, eq(revokers.id, apiKeys.revokedBy))
      .orderBy(desc(apiKeys.createdAt));
  }

  async insert(
    tx: DbTransaction,
    values: Pick<
      ApiKeyRow,
      | 'brandId'
      | 'name'
      | 'prefix'
      | 'keyHash'
      | 'scopes'
      | 'rateLimitPerMinute'
      | 'createdBy'
      | 'expiresAt'
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
   * The key with this hash, in any brand, and whether it may be used: the one
   * place that says a key is `revoked` or `expired` (by the database's clock)
   * rather than `active`. For an active key, `last_used_at` is moved forward
   * when it is more than a minute old, so a busy key costs one write a minute
   * rather than one a request.
   */
  async findByHash(db: Db, keyHash: string): Promise<KnownApiKey | undefined> {
    const [key] = await withAllBrands(db, 'api-key.resolve', async (tx) => {
      const rows = await tx
        .select({
          id: apiKeys.id,
          brandId: apiKeys.brandId,
          scopes: apiKeys.scopes,
          rateLimitPerMinute: apiKeys.rateLimitPerMinute,
          state: sql<ApiKeyState>`case
            when ${apiKeys.revokedAt} is not null then 'revoked'
            when ${apiKeys.expiresAt} is not null and ${apiKeys.expiresAt} <= now() then 'expired'
            else 'active'
          end`,
        })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);
      const [row] = rows;
      if (row?.state === 'active') {
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
      }
      return rows;
    });
    return key;
  }
}
