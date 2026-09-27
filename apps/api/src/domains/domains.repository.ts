import { type BrandDomain, brandDomains, type DbTransaction } from '@helpdock/db';
import { and, asc, count, eq, isNotNull, ne } from 'drizzle-orm';

/**
 * The help center rows of `brand_domains` (M5-07). Every statement runs in the
 * caller's transaction, so row-level security has already narrowed it to the
 * brand of the request or of the job; `widget_origin` rows belong to the Widget
 * tab and are never read or written here.
 */
export class DomainsRepository {
  list(tx: DbTransaction): Promise<BrandDomain[]> {
    return tx
      .select()
      .from(brandDomains)
      .where(eq(brandDomains.kind, 'helpcenter'))
      .orderBy(asc(brandDomains.createdAt));
  }

  async find(tx: DbTransaction, id: string): Promise<BrandDomain | undefined> {
    const rows = await tx
      .select()
      .from(brandDomains)
      .where(and(eq(brandDomains.id, id), eq(brandDomains.kind, 'helpcenter')))
      .limit(1);
    return rows[0];
  }

  /** `SELECT … FOR UPDATE`: a check and an Admin's edit of the same row take turns. */
  async lock(tx: DbTransaction, id: string): Promise<BrandDomain | undefined> {
    const rows = await tx
      .select()
      .from(brandDomains)
      .where(and(eq(brandDomains.id, id), eq(brandDomains.kind, 'helpcenter')))
      .for('update');
    return rows[0];
  }

  async countForBrand(tx: DbTransaction, brandId: string): Promise<number> {
    const [row] = await tx
      .select({ total: count() })
      .from(brandDomains)
      .where(and(eq(brandDomains.brandId, brandId), eq(brandDomains.kind, 'helpcenter')));
    return row?.total ?? 0;
  }

  /**
   * `ON CONFLICT DO NOTHING` on the install-wide unique `domain`, so a name
   * another brand already holds is `undefined` rather than an aborted
   * transaction.
   */
  async insert(
    tx: DbTransaction,
    values: { brandId: string; domain: string; txtToken: string; checkRequestedAt: Date },
  ): Promise<BrandDomain | undefined> {
    const rows = await tx
      .insert(brandDomains)
      .values({ ...values, kind: 'helpcenter' })
      .onConflictDoNothing({ target: brandDomains.domain })
      .returning();
    return rows[0];
  }

  async update(
    tx: DbTransaction,
    id: string,
    values: Partial<Omit<BrandDomain, 'id' | 'brandId' | 'domain' | 'kind' | 'txtToken'>>,
  ): Promise<BrandDomain | undefined> {
    const rows = await tx
      .update(brandDomains)
      .set(values)
      .where(and(eq(brandDomains.id, id), eq(brandDomains.kind, 'helpcenter')))
      .returning();
    return rows[0];
  }

  async delete(tx: DbTransaction, id: string): Promise<BrandDomain | undefined> {
    const rows = await tx
      .delete(brandDomains)
      .where(and(eq(brandDomains.id, id), eq(brandDomains.kind, 'helpcenter')))
      .returning();
    return rows[0];
  }

  /** Moves "primary" to `id`: the old one is cleared first, because the unique index allows one. */
  async makePrimary(tx: DbTransaction, brandId: string, id: string): Promise<void> {
    await tx
      .update(brandDomains)
      .set({ isPrimary: false })
      .where(
        and(
          eq(brandDomains.brandId, brandId),
          eq(brandDomains.isPrimary, true),
          ne(brandDomains.id, id),
        ),
      );
    await tx.update(brandDomains).set({ isPrimary: true }).where(eq(brandDomains.id, id));
  }

  /** A verified help center domain of the brand marked primary, if any. */
  async hasVerifiedPrimary(tx: DbTransaction, brandId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: brandDomains.id })
      .from(brandDomains)
      .where(
        and(
          eq(brandDomains.brandId, brandId),
          eq(brandDomains.kind, 'helpcenter'),
          eq(brandDomains.isPrimary, true),
          isNotNull(brandDomains.verifiedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
