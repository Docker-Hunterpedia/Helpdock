import { type DbTransaction, departments, ticketStatuses, tickets, users } from '@helpdock/db';
import type { ContactStats, ContactTimelineItem } from '@helpdock/schemas';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  ContactTimelineProvider,
  ContactTimelineResult,
  TicketStatsProvider,
} from '../contacts/providers.js';

/**
 * What the contact screens of M1-04 need from tickets.
 *
 * M1-04 shipped first and left two null providers behind
 * (`apps/api/src/contacts/providers.ts`); these are the real ones, and they
 * live here rather than there because the direction of the dependency matters:
 * tickets know the contact contract, contacts know nothing about the ticket
 * schema.
 *
 * Every read runs in the request's own transaction, so it is department-scoped
 * like everything else (DOMAIN-RULES §1.3). That is the point: "an agent
 * viewing a contact timeline sees only the tickets they are allowed to see"
 * (§1.2). The one number that cannot come from a scoped read is the count of
 * what is *hidden* — see {@link DbContactTimelineProvider}.
 */

/** How many tickets a contact's timeline shows. It does not page yet; M1-15 decides. */
const TIMELINE_PAGE = 50;

const openTicket = ne(ticketStatuses.systemState, 'closed');

/**
 * `max(created_at)` inside a raw fragment is an *expression*, not a column, so
 * the driver has no type for it and hands back Postgres' own text rendering
 * rather than a `Date`. Asking Postgres for the ISO-8601 string outright is
 * shorter than guessing which of the two arrived, and it is exactly the shape
 * `z.iso.datetime()` accepts.
 */
const lastTicketAt = sql<string | null>`to_char(
  max(${tickets.createdAt}) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
)`;

export class DbTicketStatsProvider implements TicketStatsProvider {
  /**
   * One query for the whole page. Fifty rows must not be fifty queries, which
   * is why the interface takes the ids together rather than one at a time.
   *
   * `csat` and `averageFirstReplySeconds` stay null: CSAT is M1-12 and the
   * first-response clock is M3-02, and a zero would read as "rated badly" and
   * "answered instantly" rather than "not measured yet".
   */
  async forContacts(
    tx: DbTransaction,
    _brandId: string,
    contactIds: readonly string[],
  ): Promise<ReadonlyMap<string, ContactStats>> {
    if (contactIds.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select({
        contactId: tickets.contactId,
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${openTicket})::int`,
        lastTicketAt,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(inArray(tickets.contactId, [...contactIds]))
      .groupBy(tickets.contactId);

    return new Map(
      rows.flatMap((row) =>
        row.contactId === null
          ? []
          : [
              [
                row.contactId,
                {
                  openTickets: row.open,
                  totalTickets: row.total,
                  csat: null,
                  averageFirstReplySeconds: null,
                  lastTicketAt: row.lastTicketAt,
                },
              ] as const,
            ],
      ),
    );
  }

  /**
   * Never null now that there is a table to ask. A contact whose only open
   * ticket is in another department is correctly absent: the filter says "has
   * an open ticket *you can see*", which is the only question this principal
   * can be answered honestly.
   */
  async withOpenTickets(
    tx: DbTransaction,
    _brandId: string,
    candidates: readonly string[],
  ): Promise<readonly string[] | null> {
    if (candidates.length === 0) {
      return [];
    }

    const rows = await tx
      .selectDistinct({ contactId: tickets.contactId })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(and(inArray(tickets.contactId, [...candidates]), openTicket));

    return rows.flatMap((row) => (row.contactId === null ? [] : [row.contactId]));
  }
}

export class DbContactTimelineProvider implements ContactTimelineProvider {
  /**
   * The contact's tickets, newest first, and how many of them this principal
   * cannot see.
   *
   * The items come from the request's own transaction, so the policies decide
   * what is in the list. `hiddenCount` cannot: a row the policy hides is a row
   * no scoped query can count. It comes from `helpdock_contact_ticket_count`,
   * which turns `app.all_departments` on for one call and leaves
   * `app.brand_ids` alone — past the department predicate and not past the
   * brand one, with the caller's own rights, returning a number and never a
   * row. The migration that declares it says why in full.
   *
   * That is exactly what DOMAIN-RULES §1.2 asks for: "the timeline shows a
   * count of hidden tickets so the agent knows history exists". The agent
   * learns that history exists and nothing whatever about what is in it.
   */
  async forContact(
    tx: DbTransaction,
    brandId: string,
    contactId: string,
  ): Promise<ContactTimelineResult> {
    const assignee = users;
    const rows = await tx
      .select({
        id: tickets.id,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        status: ticketStatuses.name,
        channel: tickets.channel,
        departmentName: departments.name,
        assigneeName: assignee.name,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .leftJoin(assignee, eq(assignee.id, tickets.assigneeId))
      .where(eq(tickets.contactId, contactId))
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(TIMELINE_PAGE);

    const [visible] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(tickets)
      .where(eq(tickets.contactId, contactId));

    const [all] = await tx.execute<{ total: number }>(
      sql`SELECT helpdock_contact_ticket_count(${brandId}::uuid, ${contactId}::uuid)::int AS total`,
    );

    return {
      items: rows.map(
        (row): ContactTimelineItem => ({
          id: row.id,
          reference: `${row.prefix}-${row.number}`,
          subject: row.subject,
          status: row.status,
          channel: row.channel,
          departmentName: row.departmentName,
          assigneeName: row.assigneeName,
          createdAt: row.createdAt.toISOString(),
        }),
      ),
      // Never negative, whatever the two reads disagree about.
      hiddenCount: Math.max(0, (all?.total ?? 0) - (visible?.total ?? 0)),
    };
  }
}
