import {
  attachments,
  contacts,
  type Db,
  type DbTransaction,
  systemContext,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
  users,
  withTenant,
} from '@helpdock/db';
import { publicNameOf } from '@helpdock/schemas';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { MediaService } from '../media/media.service.js';
import { type CustomerScope, customerTenantContext } from './customer-context.js';
import {
  encodeCursor,
  likePattern,
  mayViewCompany,
  PAGE_SIZE,
  type TicketListQuery,
} from './ticket-list-rules.js';
import { formatTicketReference, type TicketReference } from './ticket-reference.js';
import { customerStatusOf, type StatusFacts } from './ticket-status.js';
import {
  type AttachmentLookup,
  type PortalAttachment,
  type PortalAuthor,
  type PortalMessage,
  type PortalOpenedBy,
  type PortalTicketList,
  portalAttachmentSchema,
  portalMessageSchema,
  portalTicketListSchema,
  portalTicketSchema,
  type TicketLookup,
} from './ticket-views.js';

/**
 * The portal's reads of tickets (M21-03). Two kinds of read live here and they
 * are kept apart on purpose:
 *
 * 1. **Under the customer principal** (`customerTenantContext`): the ticket, its
 *    messages and its attachments. Row-level security decides what comes back
 *    (M21-01, ADR 0060); the `WHERE` clauses below repeat the policy's own
 *    predicate so the planner can use `tickets_portal_contacts_idx` and
 *    `tickets_brand_account_idx` ahead of it. The policy is what is trusted.
 * 2. **On the system path, projecting one safe field** for what a customer has
 *    no row-level access to: a status's state (to choose one of four words), a
 *    contact's display name and whether they share the viewer's company (for
 *    "Opened by" and a coworker's messages), a staff member's public name
 *    (DOMAIN-RULES §2.10), and the thread of tickets merged into one the
 *    customer can see (§2.4). Each is keyed by ids the customer read just
 *    before, in the same brand, and returns nothing else. DOMAIN-RULES §1.3
 *    names them.
 *
 * No SQL here is built from a string: every value is a bound parameter.
 */

const PROJECTION_JOB = 'portal:projection';
/** A thread longer than this shows its first messages; a customer thread of this size is not a real one. */
export const MESSAGE_LIMIT = 500;
const COUNT_CAP = 100;
/** A contact CC'd on more tickets than this is not a customer; the list then looks at the first of them. */
const CC_LIMIT = 5000;

const asProjection = <T>(
  db: Db,
  brandId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => withTenant(db, systemContext(brandId, PROJECTION_JOB), fn);

// ---------------------------------------------------------------- the policy's predicate

const ownTickets = (scope: CustomerScope): SQL =>
  sql`${tickets.portalContactIds} @> ARRAY[${scope.contactId}::uuid]`;

const companyTickets = (scope: CustomerScope): SQL | undefined =>
  mayViewCompany(scope.sees) && scope.accountId !== null
    ? and(eq(tickets.accountId, scope.accountId), eq(tickets.portalPrivate, false))
    : undefined;

/**
 * Every ticket this customer may see, as the customer policy says it: what a
 * single-ticket lookup repeats beside the row-level security it already has.
 */
const visibleTickets = (scope: CustomerScope): SQL | undefined =>
  and(
    eq(tickets.brandId, scope.brandId),
    eq(tickets.portalEligible, true),
    isNull(tickets.deletedAt),
    isNull(tickets.mergedIntoId),
    or(ownTickets(scope), companyTickets(scope)),
  );

/**
 * The same set for a list or a count, written so the planner can use an index.
 *
 * `portal_contact_ids @> ...` is the policy's own test, but `@>` on arrays is
 * not *leakproof*, and Postgres evaluates a user's non-leakproof condition only
 * after a table's row-level-security filter, so it can never drive an index; the
 * policy's own OR with the staff principals is not indexable either. So the list
 * narrows by conditions built from leakproof equalities, which the planner may
 * push below the policy: the requester (`tickets_brand_contact_idx`), the
 * company (`tickets_brand_account_idx`) and the tickets where a staff-added CC
 * names the customer (`ccTicketIds`, by primary key). That set can only be a
 * superset of what the customer may read, never smaller; the policy then keeps
 * exactly the rows it allows. It is the policy that is trusted.
 */
export const scopedTickets = (
  scope: CustomerScope,
  which: 'mine' | 'company',
  ccTicketIds: readonly string[],
): SQL | undefined =>
  and(
    eq(tickets.brandId, scope.brandId),
    eq(tickets.portalEligible, true),
    isNull(tickets.deletedAt),
    isNull(tickets.mergedIntoId),
    or(
      eq(tickets.contactId, scope.contactId),
      ccTicketIds.length === 0 ? undefined : inArray(tickets.id, [...ccTicketIds]),
      which === 'company' ? companyTickets(scope) : undefined,
    ),
  );

const ownMessages = (scope: CustomerScope): SQL | undefined =>
  or(
    sql`${ticketMessages.portalContactIds} @> ARRAY[${scope.contactId}::uuid]`,
    mayViewCompany(scope.sees) && scope.accountId !== null
      ? eq(ticketMessages.portalAccountId, scope.accountId)
      : undefined,
  );

const ownAttachments = (scope: CustomerScope): SQL | undefined =>
  or(
    sql`${attachments.portalContactIds} @> ARRAY[${scope.contactId}::uuid]`,
    mayViewCompany(scope.sees) && scope.accountId !== null
      ? eq(attachments.portalAccountId, scope.accountId)
      : undefined,
  );

// ---------------------------------------------------------------- system-side projections

/** A status's two facts, which is all a customer's word is made from. */
export const statusFacts = (
  db: Db,
  brandId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, StatusFacts>> =>
  ids.length === 0
    ? Promise.resolve(new Map())
    : asProjection(db, brandId, async (tx) => {
        const rows = await tx
          .select({
            id: ticketStatuses.id,
            systemState: ticketStatuses.systemState,
            awaitingCustomer: ticketStatuses.awaitingCustomer,
          })
          .from(ticketStatuses)
          .where(and(eq(ticketStatuses.brandId, brandId), inArray(ticketStatuses.id, [...ids])));
        return new Map(
          rows.map((row) => [
            row.id,
            { systemState: row.systemState, awaitingCustomer: row.awaitingCustomer },
          ]),
        );
      });

export interface ContactName {
  readonly name: string | null;
  readonly sameAccount: boolean;
}

/** A display name never carries an address: `omar@acme.example` is shown as `omar`. */
export const displayNameOf = (name: string): string | null => {
  const trimmed = name.trim();
  const shown = trimmed.includes('@') ? (trimmed.split('@')[0] ?? '') : trimmed;
  return shown === '' ? null : shown.slice(0, 200);
};

/**
 * The names of contacts the customer has just read about, and whether each is
 * of the viewer's own company. Nothing else of a contact leaves here.
 */
export const contactNames = (
  db: Db,
  scope: CustomerScope,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ContactName>> =>
  ids.length === 0
    ? Promise.resolve(new Map())
    : asProjection(db, scope.brandId, async (tx) => {
        const rows = await tx
          .select({
            id: contacts.id,
            name: contacts.name,
            accountId: contacts.accountId,
            anonymisedAt: contacts.anonymisedAt,
          })
          .from(contacts)
          .where(and(eq(contacts.brandId, scope.brandId), inArray(contacts.id, [...ids])));
        return new Map(
          rows.map((row) => [
            row.id,
            {
              name: row.anonymisedAt === null ? displayNameOf(row.name) : null,
              sameAccount: scope.accountId !== null && row.accountId === scope.accountId,
            },
          ]),
        );
      });

/**
 * The tickets on which this contact is a participant of any source: ids and
 * nothing else. It only narrows where the list looks (see {@link scopedTickets});
 * whether a customer may read one of them is decided afterwards by the policy,
 * which counts only a CC a staff action made, with a verified address.
 */
export const ccTicketIds = (db: Db, scope: CustomerScope): Promise<readonly string[]> =>
  asProjection(db, scope.brandId, async (tx) => {
    const rows = await tx
      .select({ ticketId: ticketParticipants.ticketId })
      .from(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.brandId, scope.brandId),
          eq(ticketParticipants.contactId, scope.contactId),
        ),
      )
      .limit(CC_LIMIT);
    return rows.map((row) => row.ticketId);
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DOMAIN-RULES §2.10: the public name, never the full name, the address or the title. */
const staffNames = (
  db: Db,
  brandId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const valid = ids.filter((id) => UUID.test(id));
  return valid.length === 0
    ? Promise.resolve(new Map())
    : asProjection(db, brandId, async (tx) => {
        const rows = await tx
          .select({ id: users.id, fullName: users.name, publicName: users.publicName })
          .from(users)
          .where(inArray(users.id, valid));
        return new Map(rows.map((row) => [row.id, publicNameOf(row)]));
      });
};

// ---------------------------------------------------------------- the list

const searchWhere = (search: TicketListQuery['search']): SQL | undefined => {
  if (search.kind === 'none') {
    return undefined;
  }
  const reference = search.reference;
  return or(
    sql`${tickets.subject} ilike ${likePattern(search.text)} escape '\\'`,
    reference === null
      ? undefined
      : 'prefix' in reference
        ? and(eq(tickets.prefix, reference.prefix), eq(tickets.number, reference.number))
        : eq(tickets.number, reference.number),
  );
};

/** Open and Solved are split on `closed_at`, which the status change sets and clears with the status. */
export const stateWhere = (state: TicketListQuery['state']): SQL =>
  state === 'solved' ? isNotNull(tickets.closedAt) : isNull(tickets.closedAt);

const countOf = async (tx: DbTransaction, where: SQL | undefined): Promise<number> => {
  const capped = tx
    .select({ one: sql<number>`1`.as('one') })
    .from(tickets)
    .where(where)
    .limit(COUNT_CAP)
    .as('capped');
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(capped);
  return row?.n ?? 0;
};

export const listTickets = async (
  db: Db,
  scope: CustomerScope,
  query: TicketListQuery,
): Promise<PortalTicketList> => {
  const { cursor } = query;
  const cc = await ccTicketIds(db, scope);
  const read = await withTenant(db, customerTenantContext(scope), async (tx) => {
    const where = and(
      scopedTickets(scope, query.scope, cc),
      stateWhere(query.state),
      searchWhere(query.search),
      cursor === null
        ? undefined
        : or(
            lt(tickets.updatedAt, cursor.updatedAt),
            and(eq(tickets.updatedAt, cursor.updatedAt), lt(tickets.id, cursor.id)),
          ),
    );
    const rows = await tx
      .select({
        id: tickets.id,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        statusId: tickets.statusId,
        contactId: tickets.contactId,
        portalPrivate: tickets.portalPrivate,
        updatedAt: tickets.updatedAt,
        closed: sql<boolean>`(${tickets.closedAt} is not null)`,
        snoozed: sql<boolean>`(${tickets.snoozedUntil} is not null)`,
      })
      .from(tickets)
      .where(where)
      .orderBy(desc(tickets.updatedAt), desc(tickets.id))
      .limit(PAGE_SIZE + 1);
    const mine = await countOf(tx, and(scopedTickets(scope, 'mine', cc), stateWhere(query.state)));
    const company = mayViewCompany(scope.sees)
      ? await countOf(tx, and(scopedTickets(scope, 'company', cc), stateWhere(query.state)))
      : null;
    return { rows, mine, company };
  });

  const page = read.rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const [statuses, names] = await Promise.all([
    statusFacts(db, scope.brandId, [...new Set(page.map((row) => row.statusId))]),
    query.scope === 'company'
      ? contactNames(db, scope, [
          ...new Set(page.flatMap((row) => (row.contactId === null ? [] : [row.contactId]))),
        ])
      : Promise.resolve(new Map<string, ContactName>()),
  ]);

  return portalTicketListSchema.parse({
    rows: page.map((row) => ({
      reference: formatTicketReference(row.prefix, row.number),
      subject: row.subject,
      status: customerStatusOf({
        status: statuses.get(row.statusId),
        closed: row.closed,
        snoozed: row.snoozed,
      }),
      updatedAt: row.updatedAt.toISOString(),
      openedBy: query.scope === 'company' ? openedByOf(scope, row.contactId, names) : null,
      onlyYou: row.portalPrivate && row.contactId === scope.contactId,
    })),
    nextCursor:
      read.rows.length > PAGE_SIZE && last !== undefined
        ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    counts: { mine: read.mine, company: read.company },
  });
};

const openedByOf = (
  scope: CustomerScope,
  contactId: string | null,
  names: ReadonlyMap<string, ContactName>,
): PortalOpenedBy => {
  if (contactId === scope.contactId) {
    return { kind: 'you' };
  }
  const name = contactId === null ? null : (names.get(contactId)?.name ?? null);
  return name === null ? { kind: 'unknown' } : { kind: 'person', name };
};

// ---------------------------------------------------------------- one ticket

export interface ThreadRow {
  readonly id: string;
  readonly authorType: 'staff' | 'contact' | 'system' | 'ai';
  readonly authorId: string | null;
  readonly bodyText: string;
  readonly createdAt: Date;
  /** The requester of the ticket the message is on, for a customer's message with no contact id of its own. */
  readonly ticketContactId: string | null;
}

interface FileRow {
  readonly id: string;
  readonly messageId: string | null;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly kind: string;
}

/** The messages and files of the tickets merged into `primaryId`, which a customer's own policy cannot reach (DOMAIN-RULES §2.4). */
const mergedThread = (
  db: Db,
  brandId: string,
  primaryId: string,
): Promise<{ messages: ThreadRow[]; files: FileRow[] }> =>
  asProjection(db, brandId, async (tx) => {
    const secondaries = tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.brandId, brandId), eq(tickets.mergedIntoId, primaryId)));
    const messages = await tx
      .select({
        id: ticketMessages.id,
        authorType: ticketMessages.authorType,
        authorId: ticketMessages.authorId,
        bodyText: ticketMessages.bodyText,
        createdAt: ticketMessages.createdAt,
        ticketContactId: tickets.contactId,
      })
      .from(ticketMessages)
      .innerJoin(tickets, eq(tickets.id, ticketMessages.ticketId))
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          inArray(ticketMessages.ticketId, secondaries),
          inArray(ticketMessages.kind, ['public', 'ai']),
        ),
      )
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id))
      .limit(MESSAGE_LIMIT);
    const files =
      messages.length === 0
        ? []
        : await tx
            .select(fileColumns)
            .from(attachments)
            .where(
              and(
                eq(attachments.brandId, brandId),
                eq(attachments.status, 'ready'),
                inArray(
                  attachments.messageId,
                  messages.map((message) => message.id),
                ),
              ),
            );
    return { messages, files };
  });

const fileColumns = {
  id: attachments.id,
  messageId: attachments.messageId,
  name: attachments.originalName,
  mime: attachments.mime,
  size: attachments.size,
  kind: attachments.kind,
};

/** Who a message is from, to this viewer; pure, over the names the system-side lookups returned. */
export const authorOf = (
  scope: CustomerScope,
  row: ThreadRow,
  contactsById: ReadonlyMap<string, ContactName>,
  staff: ReadonlyMap<string, string>,
): PortalAuthor => {
  switch (row.authorType) {
    case 'staff': {
      const name = row.authorId === null ? undefined : staff.get(row.authorId);
      return name === undefined ? { kind: 'brand' } : { kind: 'staff', name };
    }
    case 'contact': {
      const id =
        row.authorId !== null && contactsById.has(row.authorId)
          ? row.authorId
          : row.ticketContactId;
      if (id === scope.contactId) {
        return { kind: 'you' };
      }
      const known = id === null ? undefined : contactsById.get(id);
      if (known?.sameAccount === true && known.name !== null) {
        return { kind: 'coworker', name: known.name };
      }
      return { kind: 'other', name: known?.name ?? null };
    }
    default:
      return { kind: 'brand' };
  }
};

export const readTicket = async (
  db: Db,
  scope: CustomerScope,
  reference: TicketReference,
): Promise<TicketLookup> => {
  const own = await withTenant(db, customerTenantContext(scope), async (tx) => {
    const [ticket] = await tx
      .select({
        id: tickets.id,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        statusId: tickets.statusId,
        contactId: tickets.contactId,
        channel: tickets.channel,
        createdAt: tickets.createdAt,
        closed: sql<boolean>`(${tickets.closedAt} is not null)`,
        snoozed: sql<boolean>`(${tickets.snoozedUntil} is not null)`,
      })
      .from(tickets)
      .where(
        and(
          visibleTickets(scope),
          eq(tickets.prefix, reference.prefix),
          eq(tickets.number, reference.number),
        ),
      )
      .limit(1);
    if (ticket === undefined) {
      return null;
    }
    const messages = await tx
      .select({
        id: ticketMessages.id,
        authorType: ticketMessages.authorType,
        authorId: ticketMessages.authorId,
        bodyText: ticketMessages.bodyText,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, scope.brandId),
          eq(ticketMessages.ticketId, ticket.id),
          inArray(ticketMessages.kind, ['public', 'ai']),
          ownMessages(scope),
        ),
      )
      .orderBy(asc(ticketMessages.seq))
      .limit(MESSAGE_LIMIT);
    const files =
      messages.length === 0
        ? []
        : await tx
            .select(fileColumns)
            .from(attachments)
            .where(
              and(
                eq(attachments.brandId, scope.brandId),
                eq(attachments.status, 'ready'),
                inArray(
                  attachments.messageId,
                  messages.map((message) => message.id),
                ),
                ownAttachments(scope),
              ),
            );
    return { ticket, messages, files };
  });

  if (own === null) {
    return movedTo(db, scope, reference);
  }
  const { ticket } = own;
  const merged = await mergedThread(db, scope.brandId, ticket.id);
  const thread: ThreadRow[] = [
    ...own.messages.map((message) => ({ ...message, ticketContactId: ticket.contactId })),
    ...merged.messages,
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const files = [...own.files, ...merged.files];

  const contactIds = new Set<string>();
  const staffIds = new Set<string>();
  if (ticket.contactId !== null) {
    contactIds.add(ticket.contactId);
  }
  for (const row of thread) {
    if (row.ticketContactId !== null) {
      contactIds.add(row.ticketContactId);
    }
    if (row.authorType === 'contact' && row.authorId !== null && UUID.test(row.authorId)) {
      contactIds.add(row.authorId);
    }
    if (row.authorType === 'staff' && row.authorId !== null) {
      staffIds.add(row.authorId);
    }
  }
  const [statuses, names, staff] = await Promise.all([
    statusFacts(db, scope.brandId, [ticket.statusId]),
    contactNames(db, scope, [...contactIds]),
    staffNames(db, scope.brandId, [...staffIds]),
  ]);

  const filesOf = new Map<string, PortalAttachment[]>();
  for (const file of files) {
    if (file.messageId !== null) {
      filesOf.set(file.messageId, [
        ...(filesOf.get(file.messageId) ?? []),
        portalAttachmentSchema.parse({
          id: file.id,
          name: file.name,
          mime: file.mime,
          size: file.size,
          kind: file.kind,
        }),
      ]);
    }
  }
  const messages: PortalMessage[] = thread.map((row) =>
    portalMessageSchema.parse({
      id: row.id,
      author: authorOf(scope, row, names, staff),
      at: row.createdAt.toISOString(),
      text: row.bodyText,
      attachments: filesOf.get(row.id) ?? [],
    }),
  );

  return {
    kind: 'found',
    ticket: portalTicketSchema.parse({
      reference: formatTicketReference(ticket.prefix, ticket.number),
      subject: ticket.subject,
      status: customerStatusOf({
        status: statuses.get(ticket.statusId),
        closed: ticket.closed,
        snoozed: ticket.snoozed,
      }),
      openedBy: openedByOf(scope, ticket.contactId, names),
      createdAt: ticket.createdAt.toISOString(),
      channel: ticket.channel,
      mine: ticket.contactId === scope.contactId,
      messages,
    }),
  };
};

/**
 * A merged-away ticket's reference leads to the ticket it was merged into, and
 * only when the customer can see that one (DOMAIN-RULES §2.4); otherwise the
 * reference is as unknown as any other. What this reveals to a customer who can
 * see the primary is that the reference was merged into it.
 */
const movedTo = async (
  db: Db,
  scope: CustomerScope,
  reference: TicketReference,
): Promise<TicketLookup> => {
  const primaryId = await asProjection(db, scope.brandId, async (tx) => {
    const [secondary] = await tx
      .select({ mergedIntoId: tickets.mergedIntoId })
      .from(tickets)
      .where(
        and(
          eq(tickets.brandId, scope.brandId),
          eq(tickets.prefix, reference.prefix),
          eq(tickets.number, reference.number),
          isNotNull(tickets.mergedIntoId),
        ),
      )
      .limit(1);
    return secondary?.mergedIntoId ?? null;
  });
  if (primaryId === null) {
    return { kind: 'missing' };
  }
  const primary = await withTenant(db, customerTenantContext(scope), async (tx) => {
    const [row] = await tx
      .select({ prefix: tickets.prefix, number: tickets.number })
      .from(tickets)
      .where(and(visibleTickets(scope), eq(tickets.id, primaryId)))
      .limit(1);
    return row;
  });
  return primary === undefined
    ? { kind: 'missing' }
    : { kind: 'moved', reference: formatTicketReference(primary.prefix, primary.number) };
};

// ---------------------------------------------------------------- one file

type Downloader = Pick<MediaService, 'download'>;

/** The variants tried, in order: the bytes as uploaded, else the re-encoded image. */
const VARIANTS = ['original', 'webp'] as const;

const presign = async (
  media: Downloader,
  tx: DbTransaction,
  brandId: string,
  ticketId: string,
  attachmentId: string,
): Promise<string | null> => {
  for (const variant of VARIANTS) {
    try {
      return (await media.download(brandId, ticketId, attachmentId, { variant }, tx)).url;
    } catch (error) {
      if (error instanceof NotFoundException) {
        continue;
      }
      if (error instanceof ConflictException) {
        return null;
      }
      throw error;
    }
  }
  return null;
};

/**
 * The short-lived address of one file of a ticket the customer can see, or null
 * for every reason there is not one (DOMAIN-RULES §4.5): the file is another
 * customer's, a note's, not ready, or on a ticket that is not theirs. The
 * ticket is read under the customer's policy first; the file is then read under
 * it too, so a file the policy hides has no row to build an address from.
 * A file of a ticket merged into this one is authorised through this one.
 */
export const attachmentUrl = async (
  db: Db,
  media: Downloader,
  scope: CustomerScope,
  reference: TicketReference,
  attachmentId: string,
): Promise<AttachmentLookup> => {
  const ticketId = await withTenant(db, customerTenantContext(scope), async (tx) => {
    const [row] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          visibleTickets(scope),
          eq(tickets.prefix, reference.prefix),
          eq(tickets.number, reference.number),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
  if (ticketId === null) {
    return null;
  }
  const direct = await withTenant(db, customerTenantContext(scope), async (tx) => {
    const [row] = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.brandId, scope.brandId),
          eq(attachments.ticketId, ticketId),
          eq(attachments.status, 'ready'),
          ownAttachments(scope),
        ),
      )
      .limit(1);
    return row === undefined ? null : presign(media, tx, scope.brandId, ticketId, attachmentId);
  });
  if (direct !== null) {
    return { url: direct };
  }
  return asProjection(db, scope.brandId, async (tx) => {
    const [row] = await tx
      .select({ ticketId: attachments.ticketId })
      .from(attachments)
      .innerJoin(ticketMessages, eq(ticketMessages.id, attachments.messageId))
      .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.brandId, scope.brandId),
          eq(attachments.status, 'ready'),
          inArray(ticketMessages.kind, ['public', 'ai']),
          eq(tickets.mergedIntoId, ticketId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      return null;
    }
    const url = await presign(media, tx, scope.brandId, row.ticketId, attachmentId);
    return url === null ? null : { url };
  });
};
