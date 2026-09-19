import { type Brand as BrandRow, brands } from '@helpdock/db';
import type { Brand } from '@helpdock/schemas';
import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { getTx } from '../context/request-context.js';

/**
 * Reads of the `brands` table. `brands` is a global table — it is the tenant
 * itself, managed by audited install-admin paths — so row-level security does
 * not narrow these reads and the filter has to be written out. That is why the
 * caller says which brands it may see rather than the query guessing.
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
}

const toBrand = (row: BrandRow): Brand => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  defaultLocale: row.defaultLocale,
  timezone: row.timezone,
  status: row.status,
});
