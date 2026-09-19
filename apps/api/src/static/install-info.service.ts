import type { Env } from '@helpdock/config';
import { brandDomains, brands, type Db, withTenant } from '@helpdock/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { INSTALL_STATE_WHEN_UNKNOWN, readInstallState } from '../install/install-state.js';
import type { Logger } from '../logging/logger.js';
import { buildInfo } from '../observability/build-info.js';
import { DB, ENV, LOGGER } from '../runtime/tokens.js';
import type { InstallMeta } from './install-meta.js';

/**
 * What the admin may know before anyone has signed in: the install's first
 * help-center host, how many brands it serves, whether it has been set up at
 * all, and which version is serving it. Nothing else — an anonymous caller may
 * not enumerate brands (DOMAIN-RULES §1.1) — and all of it is rendered into
 * `index.html` rather than exposed as an endpoint.
 *
 * `installState` is here rather than behind `GET /api/install/state` for the
 * same reason as the rest: the app has to know before its first route renders
 * whether it is a wizard or an admin, and a fresh install must not have one
 * more anonymous endpoint than it needs.
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
    const version = buildInfo().version;

    try {
      // Derived rather than stored, so there is no flag to get out of step
      // with reality and no way to reopen the wizard by editing a row.
      const installState = await readInstallState(this.#db);

      // `brands` is global (DOMAIN-RULES §1.3), so counting it needs no tenant
      // context. The oldest brand is the first one: ids are UUIDv7.
      const rows = await this.#db
        .select({ id: brands.id })
        .from(brands)
        .where(eq(brands.status, 'active'))
        .orderBy(asc(brands.id));

      const first = rows[0];
      if (first === undefined) {
        return { primaryDomain: this.#fallbackDomain, brandCount: 1, installState, version };
      }

      return {
        primaryDomain: (await this.#helpcenterHost(first.id)) ?? this.#fallbackDomain,
        brandCount: rows.length,
        installState,
        version,
      };
    } catch (error) {
      // The page must still render when the database is unreachable: an
      // operator who cannot see the form cannot see the outage either. It is
      // logged because the consequence is confusing on a brand-new install —
      // the wizard is withheld, and this line is what says why.
      this.#logger.warn(
        { err: error },
        'Falling back to APP_URL and a configured install for the admin meta tags',
      );

      return {
        primaryDomain: this.#fallbackDomain,
        brandCount: 1,
        installState: INSTALL_STATE_WHEN_UNKNOWN,
        version,
      };
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
