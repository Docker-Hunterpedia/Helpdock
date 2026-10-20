import {
  type TicketArrival,
  type TicketArrivalEntry,
  type TicketChannel,
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

const ENTRY_OF_CHANNEL: Readonly<Record<TicketChannel, TicketArrivalEntry>> = {
  email: 'mailbox',
  chat: 'widget',
  form: 'web_form',
  telegram: 'telegram_bot',
  whatsapp: 'meta_account',
  messenger: 'meta_account',
  instagram: 'meta_account',
  api: 'api_key',
  manual: 'staff',
};

/**
 * A continuation's arrival (§2.3): the closed ticket's entry point, in the
 * closed ticket's department. A ticket closed before M14 recorded no entry, so
 * its channel stands in for it, without an id.
 */
export const continuationArrival = (
  closed: { readonly channel: TicketChannel; readonly arrival: TicketArrival | undefined },
  departmentId: string,
): TicketArrival => ({
  entry: closed.arrival?.entry ?? ENTRY_OF_CHANNEL[closed.channel],
  entryId: closed.arrival?.entryId ?? null,
  ...(closed.arrival?.address === undefined ? {} : { address: closed.arrival.address }),
  departmentId,
  reason: 'continued_from',
});
