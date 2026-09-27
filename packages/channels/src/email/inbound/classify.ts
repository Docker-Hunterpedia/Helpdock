import type { ThreadHints } from '../../adapter.js';
import { headerValue, type InboundEmail } from './inbound-email.js';

/**
 * What the headers say about a message, before anybody reads it.
 */

// --------------------------------------------------------------------------
// Automated senders (DOMAIN-RULES §4.3)
// --------------------------------------------------------------------------

/**
 * Local parts that never belong to a person. DOMAIN-RULES §4.3 names
 * `noreply@` and `mailer-daemon@`; the spellings beside them are the same
 * address written the other ways senders write it.
 */
const AUTOMATED_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
  'postmaster',
]);

/** Why a message counts as automated. Logged, so an Admin can tell why mail did not open a ticket. */
export type AutomatedReason =
  | 'auto-submitted'
  | 'precedence'
  | 'list'
  | 'automated-address'
  | 'auto-reply';

/**
 * Why this message is automated, or null when a person sent it.
 *
 * Automated mail "never creates tickets unless the brand allow-lists" the
 * sender (§4.3) — the other half of M2-06's loop protection: an auto-reply
 * answering our auto-reply must not become a ticket that auto-replies again.
 *
 * - `Auto-Submitted` with any value but `no` (RFC 3834).
 * - `Precedence: bulk`, `list` or `junk`.
 * - `List-Id` or `List-Unsubscribe`: a mailing list, which is what `Precedence:
 *   list` says in the headers modern senders actually write.
 * - `X-Autoreply` or `X-Autorespond` on an out-of-office. Exchange's
 *   `X-Auto-Response-Suppress` is deliberately not read: Outlook writes it on
 *   ordinary mail too, and a customer on Outlook must still reach the desk.
 * - A `noreply@`-style sender.
 */
export const automatedReason = (email: InboundEmail): AutomatedReason | null => {
  const autoSubmitted = headerValue(email, 'auto-submitted')?.toLowerCase().trim();
  if (autoSubmitted !== undefined && autoSubmitted !== '' && !autoSubmitted.startsWith('no')) {
    return 'auto-submitted';
  }

  const precedence = headerValue(email, 'precedence')?.toLowerCase().trim();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return 'precedence';
  }

  if (headerValue(email, 'list-id') !== null || headerValue(email, 'list-unsubscribe') !== null) {
    return 'list';
  }

  if (headerValue(email, 'x-autoreply') !== null || headerValue(email, 'x-autorespond') !== null) {
    return 'auto-reply';
  }

  const local = email.from?.address.split('@')[0] ?? '';
  if (AUTOMATED_LOCAL_PARTS.has(local)) {
    return 'automated-address';
  }

  return null;
};

// --------------------------------------------------------------------------
// SPF and DKIM (M2-07)
// --------------------------------------------------------------------------

/**
 * Whether a receiving server reported an SPF or DKIM **failure**.
 *
 * Only failures are read. A header claiming `pass` proves nothing, because the
 * sender can write it; a header claiming `fail` only ever hurts the message it
 * is on, so a forged one is the sender's own loss. A `softfail` counts, because
 * it is how most domains publish "not us" (`~all`).
 *
 * It is a heuristic, off by default per mailbox, and what it does is file the
 * ticket under Spam, never drop it: a forwarded message fails SPF honestly.
 */
export const authenticationFailed = (email: InboundEmail): boolean => {
  const results = email.headers.get('authentication-results') ?? [];
  if (results.some((value) => /\b(?:spf=(?:fail|softfail)|dkim=fail)\b/i.test(value))) {
    return true;
  }

  const receivedSpf = email.headers.get('received-spf') ?? [];
  return receivedSpf.some((value) => /^\s*(?:fail|softfail)\b/i.test(value));
};

// --------------------------------------------------------------------------
// Thread hints (DOMAIN-RULES §4.3, part 1)
// --------------------------------------------------------------------------

/**
 * `[HD-1042]`. The prefix follows the brand rule (`TICKET_PREFIX`: two to six
 * of A-Z and 0-9), read case-insensitively because mail clients and people
 * both lower-case subjects.
 */
const TICKET_TOKEN = /\[([A-Za-z0-9]{2,6})-(\d{1,9})\]/g;

export const ticketTokensIn = (subject: string): ThreadHints['ticketNumbers'] =>
  [...subject.matchAll(TICKET_TOKEN)].map((match) => ({
    prefix: (match[1] ?? '').toUpperCase(),
    number: Number(match[2]),
  }));

/** The hints a message carries, newest reference first. */
export const threadHintsOf = (email: InboundEmail): ThreadHints => ({
  messageIds: [
    ...new Set([
      ...(email.inReplyTo === null ? [] : [email.inReplyTo]),
      ...[...email.references].reverse(),
    ]),
  ],
  ticketNumbers: ticketTokensIn(email.subject),
});
