/**
 * Deterministic `Message-ID`s (DOMAIN-RULES §6: "the SMTP `Message-ID` is
 * deterministic from `ticket_message_id`").
 *
 * The id is what makes an at-least-once job safe to deliver twice: a mail
 * client or relay that already holds a message with this id treats the second
 * copy as the same message, and M2-04's threading recognises a customer's
 * `In-Reply-To` as one of ours by it.
 *
 * `kind` keeps the sources apart: a reply is keyed by its ticket message,
 * each auto-reply by its ticket, since there is at most one of each per
 * ticket, a widget transcript (M4-08) by its own delivery row, and a
 * satisfaction survey (M8-06) by its survey.
 */

export type OutboundMessageKind =
  | 'reply'
  | 'acknowledgment'
  | 'out_of_hours'
  | 'transcript'
  | 'csat';

const KIND_TAG: Readonly<Record<OutboundMessageKind, string>> = {
  reply: 'm',
  acknowledgment: 'a',
  out_of_hours: 'o',
  // M4-08. Keyed by the delivery, since a visitor may ask for a transcript twice.
  transcript: 't',
  // M8-06. One survey email per survey.
  csat: 'c',
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
  /**
   * The ticket message for a reply, the ticket for an auto-reply, the delivery
   * for a transcript, the survey for a survey.
   */
  readonly id: string;
  readonly fromAddress: string;
}): string => `<hd.${KIND_TAG[kind]}.${id}@${messageIdDomain(fromAddress)}>`;

/** One RFC 5322 `msg-id` without its angle brackets: a dot-atom, one `@`, a dot-atom. */
const SAFE_MESSAGE_ID = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const MESSAGE_ID_MAX_LENGTH = 255;

/**
 * A stored `Message-ID` or `References` entry, as it may go into a header we
 * write (M14-31): bare, one well-formed id and nothing else. Anything that
 * could carry a second header, a second id or markup is refused, so a value a
 * sender chose can never shape ours. Returns the bare id, or undefined.
 */
export const safeMessageId = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const bare = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;

  return bare.length <= MESSAGE_ID_MAX_LENGTH && SAFE_MESSAGE_ID.test(bare) ? bare : undefined;
};
