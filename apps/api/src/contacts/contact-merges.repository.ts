import type {
  ContactMerge as ContactMergeRow,
  Contact as ContactRow,
  DbTransaction,
} from '@helpdock/db';
import {
  contactDuplicateSuggestions,
  contactIdentities,
  contactMerges,
  contactNotes,
  contacts,
  users,
} from '@helpdock/db';
import type { ContactMergeSummary } from '@helpdock/schemas';
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * The reads and writes of a contact merge and its undo (M1-13), through the
 * request's own transaction. As in `ContactsRepository`, nothing filters by
 * brand: every table here is a tenant table and the policies do it.
 *
 * The one exception to "the policies decide" is the tickets. A contact's
 * tickets move whole, including those in departments the merging agent cannot
 * see, so they go through `helpdock_contact_reassign_tickets` (migration
 * `0019`), which lifts the department predicate for that one call and leaves
 * the brand predicate standing.
 */

/** "Twenty-four hours" of DOMAIN-RULES §4.4. */
const MERGE_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

const mergedContact = alias(contacts, 'merged_contact');

/** Both sides of the pair, whichever direction the suggestion was raised in. */
const pairOf = (a: string, b: string) =>
  or(
    and(
      eq(contactDuplicateSuggestions.contactId, a),
      eq(contactDuplicateSuggestions.otherContactId, b),
    ),
    and(
      eq(contactDuplicateSuggestions.contactId, b),
      eq(contactDuplicateSuggestions.otherContactId, a),
    ),
  );

export class ContactMergesRepository {
  /**
   * Both contacts, locked for the rest of the transaction, in id order so that
   * two agents merging the same pair in opposite directions queue rather than
   * deadlock.
   */
  async lockPair(tx: DbTransaction, ids: readonly [string, string]): Promise<ContactRow[]> {
    return tx
      .select()
      .from(contacts)
      .where(inArray(contacts.id, [...ids]))
      .orderBy(contacts.id)
      .for('update');
  }

  /** Every ticket of the contact, including the ones this viewer's departments hide. */
  async ticketCount(tx: DbTransaction, brandId: string, contactId: string): Promise<number> {
    const [row] = await tx.execute<{ total: number }>(
      sql`SELECT helpdock_contact_ticket_count(${brandId}::uuid, ${contactId}::uuid)::int AS total`,
    );

    return row?.total ?? 0;
  }

  async moveIdentities(
    tx: DbTransaction,
    { from, to, ids }: { readonly from: string; readonly to: string; readonly ids?: string[] },
  ): Promise<string[]> {
    const moved = await tx
      .update(contactIdentities)
      .set({ contactId: to })
      .where(
        and(
          eq(contactIdentities.contactId, from),
          ids === undefined ? undefined : inArray(contactIdentities.id, ids),
        ),
      )
      .returning({ id: contactIdentities.id });

    return moved.map((row) => row.id);
  }

  async moveNotes(
    tx: DbTransaction,
    { from, to, ids }: { readonly from: string; readonly to: string; readonly ids?: string[] },
  ): Promise<string[]> {
    const moved = await tx
      .update(contactNotes)
      .set({ contactId: to })
      .where(
        and(
          eq(contactNotes.contactId, from),
          ids === undefined ? undefined : inArray(contactNotes.id, ids),
        ),
      )
      .returning({ id: contactNotes.id });

    await this.#recountNotes(tx, from);
    await this.#recountNotes(tx, to);

    return moved.map((row) => row.id);
  }

  /**
   * Moves tickets from one contact to another across every department of the
   * brand. `ids` narrows the move to those tickets, which is what an undo
   * passes; left out, every ticket of `from` moves.
   */
  async moveTickets(
    tx: DbTransaction,
    {
      brandId,
      from,
      to,
      ids,
    }: {
      readonly brandId: string;
      readonly from: string;
      readonly to: string;
      readonly ids?: readonly string[];
    },
  ): Promise<string[]> {
    const narrowed = ids === undefined ? sql`NULL::uuid[]` : sql`${`{${ids.join(',')}}`}::uuid[]`;
    const [row] = await tx.execute<{ moved: string[] }>(
      sql`SELECT helpdock_contact_reassign_tickets(
            ${brandId}::uuid, ${from}::uuid, ${to}::uuid, ${narrowed}
          ) AS moved`,
    );

    return row?.moved ?? [];
  }

  async markMerged(tx: DbTransaction, contactId: string, into: string | null): Promise<void> {
    await tx
      .update(contacts)
      .set({ mergedIntoId: into, mergedAt: into === null ? null : new Date() })
      .where(eq(contacts.id, contactId));
  }

  /** The open suggestion for this pair, in either direction, if there is one. */
  async openSuggestionFor(tx: DbTransaction, a: string, b: string): Promise<string | undefined> {
    const rows = await tx
      .select({ id: contactDuplicateSuggestions.id })
      .from(contactDuplicateSuggestions)
      .where(and(pairOf(a, b), eq(contactDuplicateSuggestions.status, 'open')))
      .limit(1);

    return rows[0]?.id;
  }

  /** Every suggestion between the pair that is `from` becomes `to`. */
  async setPairSuggestions(
    tx: DbTransaction,
    { a, b, from, to }: { a: string; b: string; from: 'open' | 'merged'; to: 'open' | 'merged' },
  ): Promise<void> {
    await tx
      .update(contactDuplicateSuggestions)
      .set({ status: to })
      .where(and(pairOf(a, b), eq(contactDuplicateSuggestions.status, from)));
  }

  async insert(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly survivorId: string;
      readonly mergedId: string;
      readonly suggestionId: string | null;
      readonly actorId: string;
      readonly movedIdentityIds: string[];
      readonly movedTicketIds: string[];
      readonly movedNoteIds: string[];
    },
  ): Promise<ContactMergeRow> {
    const createdAt = new Date();
    const inserted = await tx
      .insert(contactMerges)
      .values({
        ...values,
        createdAt,
        undoUntil: new Date(createdAt.getTime() + MERGE_UNDO_WINDOW_MS),
      })
      .returning();

    const merge = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (merge === undefined) {
      throw new Error('The contact merge could not be recorded');
    }

    return merge;
  }

  /** Locked, because two agents pressing Undo at once must not both move things back. */
  async find(
    tx: DbTransaction,
    survivorId: string,
    mergeId: string,
  ): Promise<ContactMergeRow | undefined> {
    const rows = await tx
      .select()
      .from(contactMerges)
      .where(and(eq(contactMerges.id, mergeId), eq(contactMerges.survivorId, survivorId)))
      .limit(1)
      .for('update');

    return rows[0];
  }

  async markUndone(tx: DbTransaction, mergeId: string, actorId: string): Promise<void> {
    await tx
      .update(contactMerges)
      .set({ undoneAt: new Date(), undoneBy: actorId })
      .where(eq(contactMerges.id, mergeId));
  }

  /** The merges into this contact that can still be undone, newest first: the banner. */
  async activeInto(
    tx: DbTransaction,
    survivorId: string,
    now: Date = new Date(),
  ): Promise<ContactMergeSummary[]> {
    const rows = await tx
      .select({
        id: contactMerges.id,
        mergedId: mergedContact.id,
        mergedName: mergedContact.name,
        actorName: users.name,
        createdAt: contactMerges.createdAt,
        undoUntil: contactMerges.undoUntil,
      })
      .from(contactMerges)
      .innerJoin(mergedContact, eq(mergedContact.id, contactMerges.mergedId))
      .leftJoin(users, eq(users.id, contactMerges.actorId))
      .where(
        and(
          eq(contactMerges.survivorId, survivorId),
          isNull(contactMerges.undoneAt),
          gt(contactMerges.undoUntil, now),
        ),
      )
      .orderBy(desc(contactMerges.createdAt));

    return rows.map((row) => ({
      id: row.id,
      mergedContact: { id: row.mergedId, name: row.mergedName },
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
      undoUntil: row.undoUntil.toISOString(),
    }));
  }

  async #recountNotes(tx: DbTransaction, contactId: string): Promise<void> {
    const [row] = await tx
      .select({ total: count() })
      .from(contactNotes)
      .where(eq(contactNotes.contactId, contactId));

    await tx
      .update(contacts)
      .set({ notesCount: row?.total ?? 0 })
      .where(eq(contacts.id, contactId));
  }
}
