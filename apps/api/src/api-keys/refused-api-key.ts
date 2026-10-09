import { apiKeys, auditLog, type Db, systemContext, withTenant } from '@helpdock/db';
import { eq, sql } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * What the resolver learns about a key it just refused (ASVS 7.2.1): whether it
 * is a key Helpdock issued and then ended (revoked, or past its expiry), as
 * opposed to one that never existed, so the log can say which and the key's own
 * brand can be told. The lookup ignores both on purpose;
 * `ApiKeysRepository.findActiveByHash` is the only way a key is accepted.
 */

export interface RefusedApiKey {
  readonly id: string;
  readonly brandId: string;
  readonly reason: 'revoked' | 'expired';
}

export interface RefusalFacts {
  /** `hd_live_` and four more characters, as the Developers page shows the key. */
  readonly prefix: string;
  readonly ip: string | undefined;
}

export const API_KEY_REFUSED_AUDIT_PRINCIPAL = 'api-key.refused';

export class RefusedApiKeys {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The key with this hash if it exists but may not be used; undefined for a hash nobody holds. */
  async find(keyHash: string): Promise<RefusedApiKey | undefined> {
    const [row] = await withAllBrands(this.#db, API_KEY_REFUSED_AUDIT_PRINCIPAL, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          brandId: apiKeys.brandId,
          revoked: sql<boolean>`${apiKeys.revokedAt} is not null`,
          // The database's clock, the one `findActiveByHash` judged expiry by.
          expired: sql<boolean>`${apiKeys.expiresAt} is not null and ${apiKeys.expiresAt} <= now()`,
        })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1),
    );
    if (row === undefined || (!row.revoked && !row.expired)) {
      return undefined;
    }
    return { id: row.id, brandId: row.brandId, reason: row.revoked ? 'revoked' : 'expired' };
  }

  /** In the key's own brand, naming the key and where it was presented from, never the key. */
  async audit(key: RefusedApiKey, { prefix, ip }: RefusalFacts): Promise<void> {
    await withTenant(
      this.#db,
      {
        ...systemContext(key.brandId, API_KEY_REFUSED_AUDIT_PRINCIPAL),
        request: { requestId: '', ip: ip ?? null, userAgent: null },
      },
      (tx) =>
        tx.insert(auditLog).values({
          brandId: key.brandId,
          actorType: 'apikey',
          actorId: key.id,
          action: 'api_key.refused',
          targetType: 'api_key',
          targetId: key.id,
          meta: { prefix, reason: key.reason },
        }),
    );
  }
}
