import {
  auditLog,
  brands,
  type DbTransaction,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  isUuid,
  userBrandRoles,
  uuidv7,
} from '@helpdock/db';
import type { Brand, BrandCreateRequest } from '@helpdock/schemas';
import { defaultBrandSettings } from '@helpdock/schemas';
import { sql } from 'drizzle-orm';
import { fieldAlreadyTaken, isUniqueViolation } from '../http/unique-violation.js';
import type { Logger } from '../logging/logger.js';
import { writeBrandAudit } from './audit.js';

/**
 * Adding a brand to a running install (M1-01). The first-run wizard makes the
 * first one; this is the same act, minus the parts that only make sense once —
 * there is no admin account to create and no wizard token to issue.
 *
 * It is an install-admin path, so it is explicit and audited (AGENTS.md): only
 * `@Requires('install:admin')` reaches it, the interceptor has already written
 * an `install.scope.access` row into this very transaction, and the creation
 * writes a `brand.created` row of its own.
 *
 * Four things happen together or not at all:
 *
 * 1. the brand row, whose insert trigger creates its ticket sequence;
 * 2. an `admin` role in it for whoever asked, so the brand is reachable;
 * 3. one department, so the first screen that asks for one is not empty;
 * 4. the audit row.
 *
 * All four are in the request's own transaction. A second transaction for the
 * tenant rows — which is what the wizard has to do, because it runs before
 * there is a principal — would be able to commit the departments of a brand
 * whose own row then rolled back.
 */

export const BRAND_CREATED_ACTION = 'brand.created';

export interface CreateBrandInput {
  readonly tx: DbTransaction;
  readonly actorId: string;
  readonly request: BrandCreateRequest;
}

export class InstallBrandsService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async create({ tx, actorId, request }: CreateBrandInput): Promise<Brand> {
    const brandId = uuidv7();
    const settings = defaultBrandSettings();

    try {
      await tx.insert(brands).values({
        id: brandId,
        name: request.name,
        prefix: request.prefix,
        defaultLocale: request.defaultLocale,
        timezone: request.timezone,
        settings,
      });
    } catch (error) {
      // `prefix` is the only unique index on `brands`, so a duplicate can be
      // nothing else. A second one would need the constraint name to tell them
      // apart, and the schema test that counts them would fail first.
      if (isUniqueViolation(error)) {
        throw fieldAlreadyTaken('prefix', request.prefix);
      }
      throw error;
    }

    await this.#reachInto(tx, brandId);

    await tx
      .insert(userBrandRoles)
      .values({ userId: actorId, brandId, role: 'admin', departmentIds: null });

    await tx.insert(departments).values({
      brandId,
      name: request.firstDepartmentName,
      sortOrder: 0,
    });

    const meta = {
      prefix: request.prefix,
      defaultLocale: request.defaultLocale,
      timezone: request.timezone,
      department: request.firstDepartmentName,
    };

    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action: BRAND_CREATED_ACTION,
      targetType: 'brand',
      targetId: brandId,
      meta,
    });

    // And again inside the brand itself. Install-scope rows are unreachable to
    // a brand-scoped principal, so without this the new brand's own audit log
    // would be empty at birth — on the one path that mints a tenant-level
    // administrator, which is exactly the row an auditor comes looking for.
    await writeBrandAudit(tx, {
      brandId,
      actorId,
      action: BRAND_CREATED_ACTION,
      targetType: 'brand',
      targetId: brandId,
      meta,
    });

    this.#logger.info({ brandId, actorId }, 'Brand created by an install administrator');

    return {
      id: brandId,
      name: request.name,
      prefix: request.prefix,
      defaultLocale: request.defaultLocale,
      timezone: request.timezone,
      status: 'active',
      settings,
    };
  }

  /**
   * Widens this transaction's `app.brand_ids` to the brand it has just created,
   * so the role and the department it needs next are visible to the row-level
   * security policies.
   *
   * **Why this is not a back door.** The route is `install:admin`, the only
   * principal that may run all-brands paths (DOMAIN-RULES §1.1); the setting is
   * `SET LOCAL`, so it dies with this transaction and a pooled connection
   * carries none of it; the id is one this method generated a statement ago,
   * never one a caller supplied; and it is bound as a parameter after a UUID
   * check, so it cannot become a statement. The alternative — a second
   * transaction on a second connection — would be able to commit a brand's
   * departments after the brand itself rolled back.
   *
   * It *replaces* the setting rather than appending to it, and asserts what it
   * is replacing, so a later caller that created two brands in one transaction
   * fails loudly here instead of silently dropping the first from scope.
   */
  async #reachInto(tx: DbTransaction, brandId: string): Promise<void> {
    /* c8 ignore next 3 -- `uuidv7()` made it; the check is here so a later caller cannot change that. */
    if (!isUuid(brandId)) {
      throw new TypeError('A brand id must be a UUID before it reaches a session setting');
    }

    const [current] = await tx.execute<{ value: string }>(
      sql`SELECT current_setting('app.brand_ids', true) AS value`,
    );
    /* c8 ignore next 5 -- only an install-admin route reaches this, and its scope is the sentinel alone. */
    if ((current?.value ?? '') !== `{${INSTALL_SCOPE_BRAND_ID}}`) {
      throw new Error(
        'Widening the tenant scope is only safe from an install-scope transaction that holds the sentinel alone',
      );
    }

    await tx.execute(
      sql`SELECT set_config('app.brand_ids', ${`{${INSTALL_SCOPE_BRAND_ID},${brandId}}`}, true)`,
    );
  }
}
