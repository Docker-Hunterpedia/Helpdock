import { type DbTransaction, tags, ticketTags } from '@helpdock/db';
import type { Tag } from '@helpdock/schemas';
import { and, asc, eq, inArray } from 'drizzle-orm';

/**
 * Reading and replacing the tags on a ticket (M1-06).
 *
 * Plain functions over the caller's transaction rather than an injected
 * repository, for the reason `tickets/ticket-activity.ts` is: they are
 * stateless, they have to run inside the very transaction that made the change,
 * and the ticket service needs them without taking a dependency on the
 * ticketing module.
 *
 * Nothing here filters by brand or department. `ticket_tags` is department-
 * scoped (DOMAIN-RULES §1.3), so a ticket the caller cannot read has no rows
 * they can see and no rows they can write: the `helpdock_ticket_child_department`
 * trigger looks the parent up under the caller's own policies and refuses the
 * insert when it finds none.
 */

/** The chips one ticket carries, in the brand's own tag order. */
export const tagsOfTicket = async (tx: DbTransaction, ticketId: string): Promise<Tag[]> => {
  const rows = await tx
    .select({ id: tags.id, name: tags.name, nameAr: tags.nameAr, color: tags.color })
    .from(ticketTags)
    .innerJoin(tags, eq(tags.id, ticketTags.tagId))
    .where(eq(ticketTags.ticketId, ticketId))
    .orderBy(asc(tags.sortOrder), asc(tags.name));

  return rows;
};

/**
 * The chips of many tickets at once, keyed by ticket id.
 *
 * One query for a whole page rather than one per row: the ticket list is the
 * read REQUIREMENTS §5.2 puts a number on, and a query per row is how a list
 * of fifty becomes fifty-one round trips. Tickets with no tags are absent from
 * the map, and the caller reads that as an empty list.
 */
export const tagsOfTickets = async (
  tx: DbTransaction,
  ticketIds: readonly string[],
): Promise<Map<string, Tag[]>> => {
  const byTicket = new Map<string, Tag[]>();
  if (ticketIds.length === 0) {
    return byTicket;
  }

  const rows = await tx
    .select({
      ticketId: ticketTags.ticketId,
      id: tags.id,
      name: tags.name,
      nameAr: tags.nameAr,
      color: tags.color,
    })
    .from(ticketTags)
    .innerJoin(tags, eq(tags.id, ticketTags.tagId))
    .where(inArray(ticketTags.ticketId, [...ticketIds]))
    .orderBy(asc(tags.sortOrder), asc(tags.name));

  for (const { ticketId, ...tag } of rows) {
    const existing = byTicket.get(ticketId);
    if (existing === undefined) {
      byTicket.set(ticketId, [tag]);
    } else {
      existing.push(tag);
    }
  }

  return byTicket;
};

export interface TagReplacement {
  readonly brandId: string;
  readonly ticketId: string;
  /**
   * The ticket's department, as the caller read it, and then overwritten by the
   * `ticket_tags_department` trigger with the ticket's own — the same contract
   * `writeTicketActivity` works under. The caller passes what it read; the
   * trigger makes it true.
   */
  readonly departmentId: string;
  /** The set the ticket should carry afterwards. Duplicates are ignored. */
  readonly tagIds: readonly string[];
}

export interface TagChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly changed: boolean;
}

/**
 * Makes the ticket's tags exactly `tagIds`, and says what moved.
 *
 * A difference rather than "delete all, insert all": untouched rows keep their
 * `created_at`, which is the only record of when a tag was put on, and a
 * replace that changes nothing writes nothing at all — so the caller can skip
 * the activity row and the outbox event rather than filling a log with
 * "tags: [a] → [a]".
 *
 * Ids that are not this brand's are the caller's to reject before calling;
 * the foreign key would refuse them, but with an error nobody can read.
 */
export const replaceTicketTags = async (
  tx: DbTransaction,
  { brandId, ticketId, departmentId, tagIds }: TagReplacement,
): Promise<TagChange> => {
  const current = await tx
    .select({ tagId: ticketTags.tagId })
    .from(ticketTags)
    .where(eq(ticketTags.ticketId, ticketId));

  const before = new Set(current.map((row) => row.tagId));
  const after = new Set(tagIds);

  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));

  if (removed.length > 0) {
    await tx
      .delete(ticketTags)
      .where(and(eq(ticketTags.ticketId, ticketId), inArray(ticketTags.tagId, removed)));
  }

  if (added.length > 0) {
    await tx
      .insert(ticketTags)
      .values(added.map((tagId) => ({ brandId, ticketId, tagId, departmentId })));
  }

  return {
    before: [...before],
    after: [...after],
    changed: added.length > 0 || removed.length > 0,
  };
};
