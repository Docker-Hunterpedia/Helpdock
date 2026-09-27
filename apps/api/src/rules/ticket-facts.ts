import {
  contactIdentities,
  contacts,
  type DbTransaction,
  ticketMessages,
  ticketStatuses,
  tickets,
  ticketTags,
} from '@helpdock/db';
import type { RuleTicketFacts } from '@helpdock/schemas';
import { and, asc, desc, eq } from 'drizzle-orm';

/**
 * What a rule's conditions are asked about, read once per ticket per rule
 * run. Plain data, so the condition evaluator is a pure function over it and
 * the test run can evaluate a draft against the same shape it would be
 * evaluated against for real.
 */
export interface TicketFacts extends RuleTicketFacts {
  readonly id: string;
  readonly reference: string;
  readonly contactId: string | null;
  readonly contactLocale: 'en' | 'ar' | null;
  /** Spam, merged, soft-deleted: no rule acts on these (DOMAIN-RULES §2.2). */
  readonly inert: boolean;
}

const newestContactMessage = async (tx: DbTransaction, ticketId: string): Promise<string> => {
  const [row] = await tx
    .select({ text: ticketMessages.bodyText })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, ticketId),
        eq(ticketMessages.kind, 'public'),
        eq(ticketMessages.authorType, 'contact'),
      ),
    )
    .orderBy(desc(ticketMessages.seq))
    .limit(1);

  return row?.text ?? '';
};

const contactOf = async (
  tx: DbTransaction,
  contactId: string | null,
): Promise<{ emails: string[]; locale: 'en' | 'ar' | null; accountId: string | null }> => {
  if (contactId === null) {
    return { emails: [], locale: null, accountId: null };
  }

  const [contact, identities] = await Promise.all([
    tx
      .select({ locale: contacts.locale, accountId: contacts.accountId })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1),
    tx
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, 'email')))
      .orderBy(asc(contactIdentities.value)),
  ]);

  return {
    emails: identities.map((identity) => identity.value),
    locale: contact[0]?.locale ?? null,
    accountId: contact[0]?.accountId ?? null,
  };
};

/**
 * The facts of one ticket, or `undefined` when this transaction cannot see it
 * — deleted by retention between the event and the job, or never this brand's.
 */
export const loadTicketFacts = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<TicketFacts | undefined> => {
  const [row] = await tx
    .select({
      ticket: tickets,
      isSpam: ticketStatuses.isSpam,
      excluded: ticketStatuses.excludedFromReports,
    })
    .from(tickets)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (row === undefined) {
    return undefined;
  }

  const { ticket } = row;
  const [body, contact, tags] = await Promise.all([
    newestContactMessage(tx, ticketId),
    contactOf(tx, ticket.contactId),
    tx
      .select({ tagId: ticketTags.tagId })
      .from(ticketTags)
      .where(eq(ticketTags.ticketId, ticketId)),
  ]);

  return {
    id: ticket.id,
    reference: `${ticket.prefix}-${ticket.number}`,
    subject: ticket.subject,
    body,
    channel: ticket.channel,
    departmentId: ticket.departmentId,
    teamId: ticket.teamId,
    assigneeId: ticket.assigneeId,
    priority: ticket.priority,
    statusId: ticket.statusId,
    statusChangedAt: ticket.statusChangedAt,
    tagIds: tags.map((tag) => tag.tagId).sort(),
    contactId: ticket.contactId,
    contactEmails: contact.emails,
    contactLocale: contact.locale,
    accountId: contact.accountId,
    custom: ticket.custom,
    inert: row.isSpam || ticket.mergedIntoId !== null || ticket.deletedAt !== null,
  };
};
