import {
  type DbTransaction,
  departments,
  type NewView,
  seedBrandViews,
  type View as ViewRow,
  views,
} from '@helpdock/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

/**
 * Every statement the view endpoints make.
 *
 * None filters by brand, and none filters by owner: the transaction carries
 * `app.brand_ids` and `app.principal_id`, and the two policies on `views`
 * apply them — a personal view of somebody else's is simply not a row this
 * transaction can read. Which *shared* views a reader's sidebar shows is the
 * service's rule (`view-rules.ts`), because it is about departments and a view
 * grants nothing.
 */
export class ViewsRepository {
  /** The shared views, then the reader's own, each in their order. */
  async list(tx: DbTransaction): Promise<ViewRow[]> {
    return tx
      .select()
      .from(views)
      .orderBy(
        sql`${views.ownerId} IS NOT NULL`,
        asc(views.sortOrder),
        asc(views.name),
        asc(views.id),
      );
  }

  /** Undefined for another brand's view, and for somebody else's personal one. */
  async find(tx: DbTransaction, viewId: string): Promise<ViewRow | undefined> {
    const rows = await tx.select().from(views).where(eq(views.id, viewId)).limit(1);

    return rows[0];
  }

  /**
   * Whether the brand has its defaults. A brand created before M1-05 has none,
   * and the first read of its views writes them rather than showing an empty
   * sidebar.
   */
  async hasBuiltIns(tx: DbTransaction): Promise<boolean> {
    const rows = await tx
      .select({ id: views.id })
      .from(views)
      .where(and(isNotNull(views.builtIn), isNull(views.ownerId)))
      .limit(1);

    return rows.length > 0;
  }

  async seedBuiltIns(tx: DbTransaction, brandId: string): Promise<void> {
    await seedBrandViews(tx, brandId);
  }

  /** Which of these ids are departments of the brand. */
  async existingDepartments(
    tx: DbTransaction,
    departmentIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(inArray(departments.id, [...departmentIds]));

    return new Set(rows.map((row) => row.id));
  }

  /** One past the last position among the shared views, or among the reader's own. */
  async nextSortOrder(tx: DbTransaction, ownerId: string | null): Promise<number> {
    const rows = await tx
      .select({ next: sql<number>`coalesce(max(${views.sortOrder}), -1) + 1` })
      .from(views)
      .where(ownerId === null ? isNull(views.ownerId) : eq(views.ownerId, ownerId));

    return rows[0]?.next ?? 0;
  }

  async create(tx: DbTransaction, values: NewView): Promise<ViewRow> {
    const rows = await tx.insert(views).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The view insert returned no row');
    }

    return row;
  }

  async update(tx: DbTransaction, viewId: string, values: Partial<NewView>): Promise<void> {
    await tx.update(views).set(values).where(eq(views.id, viewId));
  }

  async delete(tx: DbTransaction, viewId: string): Promise<void> {
    await tx.delete(views).where(eq(views.id, viewId));
  }

  /** Writes each position given. Only the rows whose position changed are passed. */
  async setSortOrders(
    tx: DbTransaction,
    positions: readonly { readonly id: string; readonly sortOrder: number }[],
  ): Promise<void> {
    for (const { id, sortOrder } of positions) {
      await tx.update(views).set({ sortOrder }).where(eq(views.id, id));
    }
  }
}
