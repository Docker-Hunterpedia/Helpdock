import { brandDomains, brands, type Db, type TenantContext, withTenant } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from '../logging/logger.js';
import { DB, LOGGER } from '../runtime/tokens.js';

/** The principal id this read is recorded under, and the log line it writes. */
export const DOMAIN_CHECK_ACTION = 'domain.check';

/**
 * Answers "may this hostname get a certificate?" for Caddy's on-demand TLS
 * (ARCHITECTURE §3).
 *
 * The brand is unknown — that is the whole question — so this is an
 * install-scope read: every brand id is put in the context explicitly, the way
 * ARCHITECTURE §6 requires of an all-brands path, and the statement reads
 * `brand_domains` and nothing else. It is the same shape the outbox relay's
 * discovery uses (`@helpdock/jobs`), for the same reason: a tenant context
 * cannot be built without knowing the brands, and `brands` is a global table.
 *
 * It is logged at `debug` and not written to `audit_log`. Caddy asks on every
 * handshake for an unknown host, so an audit row per call would be a way for a
 * stranger to fill the table (DOMAIN-RULES §11); the answer it gives away is
 * one bit about a hostname the caller already named.
 */
@Injectable()
export class DomainCheckService {
  readonly #db: Db;
  readonly #logger: Logger;

  constructor(@Inject(DB) db: Db, @Inject(LOGGER) logger: Logger) {
    this.#db = db;
    this.#logger = logger;
  }

  /**
   * True only for a `helpcenter` row that has been verified. `widget_origin`
   * rows are an origin allow-list, not hosts this install answers on, so they
   * never earn a certificate.
   */
  async isVerifiedHelpcenterDomain(domain: string): Promise<boolean> {
    const rows = await this.#db.select({ id: brands.id }).from(brands).orderBy(asc(brands.id));
    const brandIds = rows.map((row) => row.id);

    if (brandIds.length === 0) {
      this.#logger.debug({ domain, verified: false }, DOMAIN_CHECK_ACTION);
      return false;
    }

    const context: TenantContext = {
      brandIds,
      departmentIds: 'all',
      principalType: 'system',
      principalId: DOMAIN_CHECK_ACTION,
    };

    const matches = await withTenant(this.#db, context, (tx) =>
      tx
        .select({ brandId: brandDomains.brandId })
        .from(brandDomains)
        .where(
          and(
            eq(brandDomains.domain, domain),
            eq(brandDomains.kind, 'helpcenter'),
            isNotNull(brandDomains.verifiedAt),
          ),
        )
        .limit(1),
    );

    const match = matches[0];
    this.#logger.debug(
      { domain, verified: match !== undefined, brandId: match?.brandId },
      DOMAIN_CHECK_ACTION,
    );
    return match !== undefined;
  }
}
