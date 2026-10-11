import { auditLog, type Db, systemContext, withTenant } from '@helpdock/db';
import { currentRequestContext } from '../context/request-context.js';
import type { EndedApiKey } from './api-keys.repository.js';

/**
 * The record of a key the resolver refused (ASVS 7.2.1) when it is one Helpdock
 * issued and then ended, as opposed to one that never existed, so the key's own
 * brand can be told. Whether a key is ended is judged once, in
 * `ApiKeysRepository.findByHash`; this only writes down what it said.
 */

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

  /** In the key's own brand, naming the key and where it was presented from, never the key. */
  async audit(key: EndedApiKey, { prefix, ip }: RefusalFacts): Promise<void> {
    await withTenant(
      this.#db,
      {
        ...systemContext(key.brandId, API_KEY_REFUSED_AUDIT_PRINCIPAL),
        request: {
          requestId: currentRequestContext()?.requestId ?? '',
          ip: ip ?? null,
          userAgent: null,
        },
      },
      (tx) =>
        tx.insert(auditLog).values({
          brandId: key.brandId,
          actorType: 'apikey',
          actorId: key.id,
          action: 'api_key.refused',
          targetType: 'api_key',
          targetId: key.id,
          meta: { prefix, reason: key.state },
        }),
    );
  }
}
