import type { Env } from '@helpdock/config';
import { brandDomains, brands, type Db, withTenant } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from '../logging/logger.js';
import { DB, ENV, LOGGER } from '../runtime/tokens.js';
import type { InstallMeta } from './install-meta.js';

/**
 * What the sign-in card may know before anyone has signed in: the install's
 * first help-center host and how many brands it serves. Nothing else: an
 * anonymous caller may not enumerate brands (DOMAIN-RULES §1.1), which is why
 * this is rendered into `index.html` rather than exposed as an endpoint.
 */
@Injectable()
export class InstallInfoService {
  readonly #db: Db;
  readonly #env: Env;
  readonly #logger: Logger;

  constructor(@Inject(DB) db: Db, @Inject(ENV) env: Env, @Inject(LOGGER) logger: Logger) {
    this.#db = db;
    this.#env = env;
    this.#logger = logger;
  }

  /** The host `APP_URL` names, which is what a single-brand install shows. */
  get #fallbackDomain(): string {
    return new URL(this.#env.APP_URL).hostname;
  }

  async read(): Promise<InstallMeta> {
    try {
      // `brands` is global (DOMAIN-RULES §1.3), so counting it needs no tenant
      // context. The oldest brand is the first one: ids are UUIDv7.
      const rows = await this.#db
        .select({ id: brands.id })
        .from(brands)
        .where(eq(brands.status, 'active'))
        .orderBy(asc(brands.id));

      const first = rows[0];
      if (first === undefined) {
        return { primaryDomain: this.#fallbackDomain, brandCount: 1 };
      }

      return {
        primaryDomain: (await this.#helpcenterHost(first.id)) ?? this.#fallbackDomain,
        brandCount: rows.length,
      };
    } catch (error) {
      // The sign-in page must still render when the database is unreachable:
      // an operator who cannot see the form cannot see the outage either.
      this.#logger.warn({ err: error }, 'Falling back to APP_URL for the admin install meta tags');
      return { primaryDomain: this.#fallbackDomain, brandCount: 1 };
    }
  }

  async #helpcenterHost(brandId: string): Promise<string | undefined> {
    const rows = await withTenant(
      this.#db,
      {
        brandIds: [brandId],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'install.meta',
      },
      (tx) =>
        tx
          .select({ domain: brandDomains.domain })
          .from(brandDomains)
          .where(
            and(
              eq(brandDomains.brandId, brandId),
              eq(brandDomains.kind, 'helpcenter'),
              isNotNull(brandDomains.verifiedAt),
            ),
          )
          .orderBy(asc(brandDomains.createdAt))
          .limit(1),
    );

    return rows[0]?.domain;
  }
}
