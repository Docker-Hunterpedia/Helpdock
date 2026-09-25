import type {
  Account as AccountRow,
  ContactDuplicateSuggestion as ContactDuplicateSuggestionRow,
  ContactIdentity as ContactIdentityRow,
  ContactNote as ContactNoteRow,
  Contact as ContactRow,
  DbTransaction,
  User,
} from '@helpdock/db';
import {
  accounts,
  contactDuplicateSuggestions,
  contactIdentities,
  contactNotes,
  contacts,
  users,
} from '@helpdock/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';

/**
 * Every read and write the contacts module makes, through the transaction the
 * request is already inside.
 *
 * **No query filters by brand.** All five tables are tenant tables, so the
 * row-level security policies on the request's transaction already restrict
 * them to the brand the route resolved; a `where brand_id = …` written out here
 * would be a second copy of a rule that can drift from the first. The one
 * exception is the writes, which name the brand because a row has to carry it.
 *
 * `users` is global and is reached only through a join from `contact_notes`, so
 * a note's author can be named without the table becoming readable.
 */

export interface ContactPage {
  readonly rows: readonly ContactRow[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface ContactFilters {
  readonly search?: string | undefined;
  readonly accountId?: string | undefined;
  readonly duplicatesOnly?: boolean | undefined;
  /** Leave out anonymised contacts, which a merge refuses. */
  readonly mergeableOnly?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * Neither side of an open suggestion has been merged away (M1-13). Written
 * against the alias `d` the two suggestion queries below give the table.
 */
const bothSidesLive = sql`NOT EXISTS (
  SELECT 1 FROM ${contacts} merged
  WHERE merged.id IN (d.contact_id, d.other_contact_id) AND merged.merged_into_id IS NOT NULL
)`;

/** `%` and `_` are wildcards in `LIKE`; somebody typing one means the character. */
const escapeLike = (value: string): string => value.replaceAll(/[\\%_]/g, (match) => `\\${match}`);

export class ContactsRepository {
  /**
   * One page of contacts, keyset-paginated on the id.
   *
   * The cursor is the last id of the previous page rather than an offset: ids
   * are UUIDv7 and therefore time-ordered, so the page after a given id is a
   * range scan, and a contact created while somebody pages does not shift the
   * rows under them.
   *
   * `search` matches the name or any identifier of the contact, case
   * insensitively. The identifier half is a subquery rather than a join so one
   * contact with three matching addresses is still one row.
   */
  async list(tx: DbTransaction, filters: ContactFilters): Promise<ContactPage> {
    const where = this.#listPredicate(filters);

    const [totals] = await tx.select({ total: count() }).from(contacts).where(where);

    const page = await tx
      .select()
      .from(contacts)
      .where(filters.cursor === undefined ? where : and(where, gt(contacts.id, filters.cursor)))
      .orderBy(asc(contacts.id))
      .limit(filters.limit + 1);

    const rows = page.slice(0, filters.limit);
    const nextCursor = page.length > filters.limit ? (rows.at(-1)?.id ?? null) : null;

    return { rows, total: totals?.total ?? 0, nextCursor };
  }

  #listPredicate(filters: ContactFilters) {
    const term = filters.search?.trim();
    const pattern = term === undefined || term === '' ? null : `%${escapeLike(term)}%`;

    const matchesSearch =
      pattern === null
        ? undefined
        : or(
            ilike(contacts.name, pattern),
            ilike(contacts.externalId, pattern),
            sql`EXISTS (
              SELECT 1 FROM ${contactIdentities} i
              WHERE i.contact_id = ${contacts.id} AND i.value ILIKE ${pattern} ESCAPE '\\'
            )`,
          );

    const matchesAccount =
      filters.accountId === undefined ? undefined : eq(contacts.accountId, filters.accountId);

    const hasDuplicate =
      filters.duplicatesOnly === true
        ? sql`EXISTS (
            SELECT 1 FROM ${contactDuplicateSuggestions} d
            WHERE d.contact_id = ${contacts.id} AND d.status = 'open'
              AND ${bothSidesLive}
          )`
        : undefined;

    const mergeable = filters.mergeableOnly === true ? isNull(contacts.anonymisedAt) : undefined;

    // A contact merged into another (M1-13) is not somebody to list: its
    // identifiers and tickets are on the survivor now.
    return and(
      isNull(contacts.mergedIntoId),
      matchesSearch,
      matchesAccount,
      hasDuplicate,
      mergeable,
    );
  }

  async find(tx: DbTransaction, contactId: string): Promise<ContactRow | undefined> {
    const rows = await tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);

    return rows[0];
  }

  /** The identifiers of one or more contacts, oldest first so the list is stable. */
  async identitiesOf(
    tx: DbTransaction,
    contactIds: readonly string[],
  ): Promise<ContactIdentityRow[]> {
    if (contactIds.length === 0) {
      return [];
    }

    return tx
      .select()
      .from(contactIdentities)
      .where(inArray(contactIdentities.contactId, [...contactIds]))
      .orderBy(desc(contactIdentities.verified), asc(contactIdentities.createdAt));
  }

  async identity(tx: DbTransaction, identityId: string): Promise<ContactIdentityRow | undefined> {
    const rows = await tx
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.id, identityId))
      .limit(1);

    return rows[0];
  }

  async deleteIdentity(tx: DbTransaction, identityId: string): Promise<void> {
    await tx.delete(contactIdentities).where(eq(contactIdentities.id, identityId));
  }

  async countIdentities(tx: DbTransaction, contactId: string): Promise<number> {
    const [row] = await tx
      .select({ total: count() })
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, contactId));

    return row?.total ?? 0;
  }

  /** The accounts named by a page of contacts, so the list resolves them once. */
  async accountsByIds(tx: DbTransaction, accountIds: readonly string[]): Promise<AccountRow[]> {
    if (accountIds.length === 0) {
      return [];
    }

    return tx
      .select()
      .from(accounts)
      .where(inArray(accounts.id, [...accountIds]));
  }

  async account(tx: DbTransaction, accountId: string): Promise<AccountRow | undefined> {
    const rows = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);

    return rows[0];
  }

  async accountByDomain(tx: DbTransaction, domain: string): Promise<AccountRow | undefined> {
    const rows = await tx.select().from(accounts).where(eq(accounts.domain, domain)).limit(1);

    return rows[0];
  }

  async listAccounts(
    tx: DbTransaction,
    filters: {
      readonly search?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit: number;
    },
  ): Promise<{ rows: readonly AccountRow[]; total: number; nextCursor: string | null }> {
    const term = filters.search?.trim();
    const pattern = term === undefined || term === '' ? null : `%${escapeLike(term)}%`;
    const where =
      pattern === null
        ? undefined
        : or(ilike(accounts.name, pattern), ilike(accounts.domain, pattern));

    const [totals] = await tx.select({ total: count() }).from(accounts).where(where);

    const page = await tx
      .select()
      .from(accounts)
      .where(filters.cursor === undefined ? where : and(where, gt(accounts.id, filters.cursor)))
      .orderBy(asc(accounts.id))
      .limit(filters.limit + 1);

    const rows = page.slice(0, filters.limit);

    return {
      rows,
      total: totals?.total ?? 0,
      nextCursor: page.length > filters.limit ? (rows.at(-1)?.id ?? null) : null,
    };
  }

  /** How many contacts each of these accounts holds, for the accounts list. */
  async contactCounts(
    tx: DbTransaction,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (accountIds.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select({ accountId: contacts.accountId, total: count() })
      .from(contacts)
      .where(inArray(contacts.accountId, [...accountIds]))
      .groupBy(contacts.accountId);

    return new Map(
      rows
        .filter((row): row is { accountId: string; total: number } => row.accountId !== null)
        .map((row) => [row.accountId, row.total]),
    );
  }

  async insertAccount(
    tx: DbTransaction,
    values: { readonly brandId: string; readonly name: string; readonly domain: string | null },
  ): Promise<AccountRow> {
    const inserted = await tx.insert(accounts).values(values).returning();

    const account = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (account === undefined) {
      throw new Error('The account could not be created');
    }

    return account;
  }

  async updateAccount(
    tx: DbTransaction,
    accountId: string,
    changes: { readonly name?: string; readonly domain?: string | null },
  ): Promise<AccountRow | undefined> {
    const updated = await tx
      .update(accounts)
      .set(changes)
      .where(eq(accounts.id, accountId))
      .returning();

    return updated[0];
  }

  async updateContact(
    tx: DbTransaction,
    contactId: string,
    changes: {
      readonly name?: string;
      readonly accountId?: string | null;
      readonly locale?: 'en' | 'ar' | null;
      readonly timezone?: string | null;
      readonly externalId?: string | null;
    },
  ): Promise<ContactRow | undefined> {
    const updated = await tx
      .update(contacts)
      .set(changes)
      .where(eq(contacts.id, contactId))
      .returning();

    return updated[0];
  }

  // ------------------------------------------------------------------
  // Notes
  // ------------------------------------------------------------------

  async notesOf(
    tx: DbTransaction,
    contactId: string,
  ): Promise<{ note: ContactNoteRow; author: User | null }[]> {
    return tx
      .select({ note: contactNotes, author: users })
      .from(contactNotes)
      .leftJoin(users, eq(users.id, contactNotes.authorId))
      .where(eq(contactNotes.contactId, contactId))
      .orderBy(desc(contactNotes.createdAt));
  }

  async insertNote(
    tx: DbTransaction,
    values: {
      readonly brandId: string;
      readonly contactId: string;
      readonly authorId: string;
      readonly bodyText: string;
    },
  ): Promise<ContactNoteRow> {
    const inserted = await tx.insert(contactNotes).values(values).returning();
    await tx
      .update(contacts)
      .set({ notesCount: sql`${contacts.notesCount} + 1` })
      .where(eq(contacts.id, values.contactId));

    const note = inserted[0];
    /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
    if (note === undefined) {
      throw new Error('The contact note could not be created');
    }

    return note;
  }

  // ------------------------------------------------------------------
  // Duplicate suggestions
  // ------------------------------------------------------------------

  /** The open suggestions raised *about* this contact, in either direction. */
  async duplicatesOf(
    tx: DbTransaction,
    contactId: string,
  ): Promise<{ suggestion: ContactDuplicateSuggestionRow; other: ContactRow }[]> {
    return (
      tx
        .select({ suggestion: contactDuplicateSuggestions, other: contacts })
        .from(contactDuplicateSuggestions)
        .innerJoin(
          contacts,
          or(
            and(
              eq(contactDuplicateSuggestions.contactId, contactId),
              eq(contacts.id, contactDuplicateSuggestions.otherContactId),
            ),
            and(
              eq(contactDuplicateSuggestions.otherContactId, contactId),
              eq(contacts.id, contactDuplicateSuggestions.contactId),
            ),
          ),
        )
        // The other side merged into somebody else (M1-13) is hidden until the
        // merge is undone, rather than offered as a contact that is gone.
        .where(and(eq(contactDuplicateSuggestions.status, 'open'), isNull(contacts.mergedIntoId)))
        .orderBy(desc(contactDuplicateSuggestions.createdAt))
    );
  }

  async duplicate(
    tx: DbTransaction,
    suggestionId: string,
  ): Promise<ContactDuplicateSuggestionRow | undefined> {
    const rows = await tx
      .select()
      .from(contactDuplicateSuggestions)
      .where(eq(contactDuplicateSuggestions.id, suggestionId))
      .limit(1);

    return rows[0];
  }

  /** Guarded on `open` in SQL too, so two agents racing cannot both dismiss. */
  async dismissDuplicate(tx: DbTransaction, suggestionId: string): Promise<boolean> {
    const updated = await tx
      .update(contactDuplicateSuggestions)
      .set({ status: 'dismissed' })
      .where(
        and(
          eq(contactDuplicateSuggestions.id, suggestionId),
          eq(contactDuplicateSuggestions.status, 'open'),
        ),
      )
      .returning({ id: contactDuplicateSuggestions.id });

    return updated.length > 0;
  }

  async countOpenDuplicates(tx: DbTransaction): Promise<number> {
    const [row] = await tx.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM ${contactDuplicateSuggestions} d
          WHERE d.status = 'open' AND ${bothSidesLive}`,
    );

    return row?.total ?? 0;
  }

  // ------------------------------------------------------------------
  // Erasure (DOMAIN-RULES §11)
  // ------------------------------------------------------------------

  /**
   * Replaces the person with hashes and stamps `anonymised_at`. Guarded on
   * `anonymised_at IS NULL` in SQL as well as in the caller, so two agents
   * acting on the same privacy request cannot hash a hash.
   */
  async anonymise(
    tx: DbTransaction,
    contactId: string,
    {
      name,
      identities,
    }: {
      readonly name: string;
      readonly identities: readonly { readonly id: string; readonly value: string }[];
    },
  ): Promise<boolean> {
    const updated = await tx
      .update(contacts)
      .set({
        name,
        accountId: null,
        externalId: null,
        custom: {},
        locale: null,
        timezone: null,
        anonymisedAt: new Date(),
      })
      .where(and(eq(contacts.id, contactId), sql`${contacts.anonymisedAt} IS NULL`))
      .returning({ id: contacts.id });

    if (updated.length === 0) {
      return false;
    }

    for (const identity of identities) {
      await tx
        .update(contactIdentities)
        .set({ value: identity.value, verified: false, verifiedAt: null, source: 'erasure' })
        .where(eq(contactIdentities.id, identity.id));
    }

    // The notes are what an agent wrote *about* the person, so they go with the
    // person.
    await tx.delete(contactNotes).where(eq(contactNotes.contactId, contactId));
    await tx.update(contacts).set({ notesCount: 0 }).where(eq(contacts.id, contactId));

    // An erased contact is not a merge candidate. Left open, the suggestion
    // would keep offering the other contact's screen a link to somebody who
    // has been erased, and M1-13 would offer to merge them back together.
    await tx
      .update(contactDuplicateSuggestions)
      .set({ status: 'dismissed' })
      .where(
        and(
          eq(contactDuplicateSuggestions.status, 'open'),
          or(
            eq(contactDuplicateSuggestions.contactId, contactId),
            eq(contactDuplicateSuggestions.otherContactId, contactId),
          ),
        ),
      );

    return true;
  }

  /** Contacts that name an account, for the account detail screen. */
  async contactsOfAccount(tx: DbTransaction, accountId: string): Promise<ContactRow[]> {
    return tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), isNotNull(contacts.accountId)))
      .orderBy(asc(contacts.name))
      .limit(200);
  }
}
