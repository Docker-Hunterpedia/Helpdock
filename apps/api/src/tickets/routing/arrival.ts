import {
  TICKET_ARRIVAL_ADDRESS_MAX,
  type TicketArrival,
  ticketArrivalSchema,
} from '@helpdock/schemas';
import type { ActivityActor } from '../ticket-activity.js';

/**
 * M14-08: the one way a creation path records how a ticket arrived
 * (DOMAIN-RULES §2.8).
 *
 * Every writer that files a ticket — the tickets service, the email, Telegram
 * and Meta routers, the widget, the web form, a split, a reopen-policy
 * continuation and an importer — spreads this into its creation activity's
 * `to`, so the shape cannot drift between them and the trail can read any of
 * them back. Parsed on the way in, so a writer that passes a malformed value
 * fails its own transaction instead of leaving a row the trail cannot read.
 */
export const arrivalOf = (arrival: TicketArrival): { readonly arrival: TicketArrival } => ({
  arrival: ticketArrivalSchema.parse(arrival),
});

/** The arrival a creation row recorded, or undefined for a ticket filed before M14. */
export const recordedArrival = (
  to: Readonly<Record<string, unknown>> | null,
): TicketArrival | undefined => {
  const parsed = ticketArrivalSchema.safeParse(to?.arrival);
  return parsed.success ? parsed.data : undefined;
};

/**
 * A ticket filed by a request — `POST /tickets` or a split: a key names its
 * department, a person chooses it. The request's actor is the entry point.
 */
export const requestArrival = (
  actor: Pick<ActivityActor, 'actorType' | 'actorId'>,
  departmentId: string,
): TicketArrival =>
  actor.actorType === 'apikey'
    ? { entry: 'api_key', entryId: actor.actorId, departmentId, reason: 'named_by_api' }
    : { entry: 'staff', entryId: actor.actorId, departmentId, reason: 'chosen_by_staff' };

/** Where a message came in: the arrival without its department and reason. */
export type ArrivalEntryPoint = Pick<TicketArrival, 'entry' | 'entryId' | 'address'>;

/**
 * The brand's one widget, which has no id of its own until M19-02. A visitor
 * writing through the tickets service is writing through it too.
 */
export const WIDGET_ENTRY: ArrivalEntryPoint = { entry: 'widget', entryId: null };

/**
 * A continuation's arrival (§2.3): the door the customer's reply came in
 * through — which may not be the closed ticket's, as when a reply to
 * billing@ continues a ticket that arrived at support@ — in the closed
 * ticket's department, which is where the new ticket is filed.
 */
export const continuationArrival = (
  inbound: ArrivalEntryPoint,
  departmentId: string,
): TicketArrival => ({ ...inbound, departmentId, reason: 'continued_from' });

/**
 * The address the customer wrote to, as the inbound message names it: the
 * mailbox's own when it is among the recipients, otherwise the first
 * recipient (an alias forwarded into an IMAP mailbox), envelope first, then
 * To, then Cc. None, or one too long to be an address, records none rather
 * than refusing the mail.
 */
export const addressWrittenTo = (
  recipients: readonly string[],
  mailboxAddress: string,
): string | undefined => {
  const mailbox = mailboxAddress.toLowerCase();
  const written = recipients.includes(mailbox) ? mailbox : recipients[0];
  return written !== undefined && written.length <= TICKET_ARRIVAL_ADDRESS_MAX
    ? written
    : undefined;
};
