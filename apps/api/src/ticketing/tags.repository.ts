import {
  type DbTransaction,
  type NewTag,
  type Tag as TagRow,
  tags,
  ticketTags,
} from '@helpdock/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';

/**
 * Every statement the tag endpoints make.
 *
 * None of them filters by brand: the request's transaction carries
 * `app.brand_ids` and the policy on `tags` applies it, as it does everywhere
 * else in this app. A `WHERE brand_id = …` on top would be a second place for
 * isolation to live, and the one that is easy to forget on the next query.
 *
 * The counts come from `ticket_tags`, which **is** department-scoped, so a
 * count is "tickets you can see with this tag". For an Admin that is every
 * ticket in the brand; for a Team Leader restricted to two departments it is
 * the tickets in those two. That is the honest answer — the alternative would
 * be a function that reaches past the department policy to count rows the
 * reader may not know exist.
 */

export interface TagWithCount {
  readonly tag: TagRow;
  readonly ticketCount: number;
}

const COUNT = sql<number>`count(${ticketTags.ticketId})::int`;

export class TagsRepository {
  async list(tx: DbTransaction): Promise<TagWithCount[]> {
    const rows = await tx
      .select({ tag: tags, ticketCount: COUNT })
      .from(tags)
      .leftJoin(ticketTags, eq(ticketTags.tagId, tags.id))
      .groupBy(tags.id)
      .orderBy(asc(tags.sortOrder), asc(tags.name));

    return rows;
  }

  /** Undefined when the id is not this brand's, which the policy decides. */
  async find(tx: DbTransaction, tagId: string): Promise<TagRow | undefined> {
    const rows = await tx.select().from(tags).where(eq(tags.id, tagId)).limit(1);

    return rows[0];
  }

  /** Which of these ids the brand actually has, for validating a replace. */
  async existing(tx: DbTransaction, tagIds: readonly string[]): Promise<Set<string>> {
    if (tagIds.length === 0) {
      return new Set();
    }

    const rows = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(inArray(tags.id, [...tagIds]));

    return new Set(rows.map((row) => row.id));
  }

  /** Whether another tag of this brand already carries that name, whatever its case. */
  async nameTaken(
    tx: DbTransaction,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(sql`lower(${tags.name}) = lower(${name})`);

    return rows.some((row) => row.id !== exceptId);
  }

  async ticketCount(tx: DbTransaction, tagId: string): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ticketTags)
      .where(eq(ticketTags.tagId, tagId));

    return rows[0]?.count ?? 0;
  }

  async nextSortOrder(tx: DbTransaction): Promise<number> {
    const rows = await tx
      .select({ next: sql<number>`coalesce(max(${tags.sortOrder}), -1) + 1` })
      .from(tags);

    return rows[0]?.next ?? 0;
  }

  async create(tx: DbTransaction, values: NewTag): Promise<TagRow> {
    const rows = await tx.insert(tags).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The tag insert returned no row');
    }

    return row;
  }

  async update(
    tx: DbTransaction,
    tagId: string,
    values: Partial<NewTag>,
  ): Promise<TagRow | undefined> {
    const rows = await tx.update(tags).set(values).where(eq(tags.id, tagId)).returning();

    return rows[0];
  }

  /** The taggings go with it: `ticket_tags.tag_id` cascades, which is the detach. */
  async delete(tx: DbTransaction, tagId: string): Promise<void> {
    await tx.delete(tags).where(eq(tags.id, tagId));
  }

  /** The whole list, dense and zero-based, as `DepartmentsRepository` reorders. */
  async reorder(tx: DbTransaction, tagIds: readonly string[]): Promise<void> {
    for (const [position, tagId] of tagIds.entries()) {
      await tx.update(tags).set({ sortOrder: position }).where(eq(tags.id, tagId));
    }
  }
}
