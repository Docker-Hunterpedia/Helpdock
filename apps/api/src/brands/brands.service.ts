import { type Brand as BrandRow, brands, type DbTransaction } from '@helpdock/db';
import type { Brand, BrandUpdateRequest } from '@helpdock/schemas';
import { parseBrandSettings } from '@helpdock/schemas';
import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { getTx } from '../context/request-context.js';
import { writeBrandAudit } from './audit.js';

/**
 * Reads and writes of the `brands` table. `brands` is a global table — it is
 * the tenant itself, managed by audited install-admin paths — so row-level
 * security does not narrow these reads and the filter has to be written out.
 * That is why the caller says which brands it may see rather than the query
 * guessing, and why {@link BrandsService.update} takes the brand the permission
 * guard resolved rather than one from the body.
 */
@Injectable()
export class BrandsService {
  /** Brands the principal holds a role in. An empty list never queries. */
  async listOwnedBy(brandIds: readonly string[]): Promise<Brand[]> {
    if (brandIds.length === 0) {
      return [];
    }

    const rows = await getTx()
      .select()
      .from(brands)
      .where(inArray(brands.id, [...brandIds]))
      .orderBy(asc(brands.name));

    return rows.map(toBrand);
  }

  /** Every brand in the install. Only ever called from an install-scope route. */
  async listAll(): Promise<Brand[]> {
    const rows = await getTx().select().from(brands).orderBy(asc(brands.name));

    return rows.map(toBrand);
  }

  async find(brandId: string): Promise<Brand | undefined> {
    const rows = await getTx().select().from(brands).where(eq(brands.id, brandId)).limit(1);

    const row = rows[0];
    return row === undefined ? undefined : toBrand(row);
  }

  /**
   * The name, the default locale, the time zone and the ticketing settings.
   * Never the prefix: it is printed in every ticket number this brand has ever
   * issued, so REQUIREMENTS §3 makes it editable once, at creation. The input
   * schema has no field for it, and this method would not read one.
   */
  async update(
    tx: DbTransaction,
    { brandId, actorId }: { readonly brandId: string; readonly actorId: string },
    request: BrandUpdateRequest,
  ): Promise<Brand> {
    const updated = await tx
      .update(brands)
      .set({
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.defaultLocale === undefined ? {} : { defaultLocale: request.defaultLocale }),
        ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
        ...(request.settings === undefined ? {} : { settings: request.settings }),
      })
      .where(eq(brands.id, brandId))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new NotFoundException('No such brand');
    }

    await writeBrandAudit(tx, {
      brandId,
      actorId,
      action: 'brand.updated',
      targetType: 'brand',
      targetId: brandId,
      // The fields that changed, not their old values in full: a brand's name
      // and time zone are already visible to everyone who can read this row.
      meta: { changed: Object.keys(request) },
    });

    return toBrand(row);
  }
}

const toBrand = (row: BrandRow): Brand => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  defaultLocale: row.defaultLocale,
  timezone: row.timezone,
  status: row.status,
  settings: parseBrandSettings(row.settings),
});
