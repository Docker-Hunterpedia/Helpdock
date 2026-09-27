/**
 * Deterministic `Message-ID`s (DOMAIN-RULES §6: "the SMTP `Message-ID` is
 * deterministic from `ticket_message_id`").
 *
 * The id is what makes an at-least-once job safe to deliver twice: a mail
 * client or relay that already holds a message with this id treats the second
 * copy as the same message, and M2-04's threading recognises a customer's
 * `In-Reply-To` as one of ours by it.
 *
 * `kind` keeps the three sources apart: a reply is keyed by its ticket
 * message, and each auto-reply by its ticket, since there is at most one of
 * each per ticket.
 */

export type OutboundMessageKind = 'reply' | 'acknowledgment' | 'out_of_hours';

const KIND_TAG: Readonly<Record<OutboundMessageKind, string>> = {
  reply: 'm',
  acknowledgment: 'a',
  out_of_hours: 'o',
};

/** Characters RFC 5322 allows in a dot-atom; anything else in a domain is dropped. */
const DOT_ATOM = /[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/g;

/** The domain half of an address, or `helpdock.invalid` when there is none to use. */
export const messageIdDomain = (fromAddress: string): string => {
  const at = fromAddress.lastIndexOf('@');
  const domain = (at === -1 ? '' : fromAddress.slice(at + 1)).replace(DOT_ATOM, '').toLowerCase();

  return domain === '' ? 'helpdock.invalid' : domain;
};

export const outboundMessageId = ({
  kind,
  id,
  fromAddress,
}: {
  readonly kind: OutboundMessageKind;
  /** The ticket message for a reply, the ticket for an auto-reply. */
  readonly id: string;
  readonly fromAddress: string;
}): string => `<hd.${KIND_TAG[kind]}.${id}@${messageIdDomain(fromAddress)}>`;
