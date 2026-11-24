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
// Does the From address match what the receiving server checked?
// --------------------------------------------------------------------------

/**
 * What the receiving server's report says about the `From` address:
 *
 * - `misaligned`: there is evidence against it (a failure, `dmarc=fail`, or
 *   passes that belong to some other domain). Such mail adds no Cc
 *   participants and verifies no sender (DOMAIN-RULES §4.3, §4.4).
 * - `aligned`: a pass that belongs to the From domain.
 * - `unknown`: no usable report, so nothing is held against the message.
 *
 * Helpdock only reads what the receiving server wrote. A relay the operator
 * does not control can write its own `Authentication-Results`, so this is a
 * best-effort check, not proof of who sent the message.
 */
export type SenderCheck = 'aligned' | 'misaligned' | 'unknown';

interface AuthResult {
  readonly method: 'spf' | 'dkim' | 'dmarc';
  readonly result: string;
  /** `smtp.mailfrom` (SPF) or `header.d` (DKIM), lower-cased, without a local part. */
  readonly domain: string | null;
}

const domainOfAddress = (value: string): string => {
  const at = value.lastIndexOf('@');
  return (at === -1 ? value : value.slice(at + 1)).toLowerCase();
};

/**
 * Same organisational domain, approximated as "equal, or one is a subdomain
 * of the other". There is no public-suffix list behind it, so it is a little
 * generous for a From on a shared suffix; it adds no dependency.
 */
export const domainsAlign = (a: string, b: string): boolean => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return (
    left !== '' &&
    right !== '' &&
    (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`))
  );
};

/** The results of every `Authentication-Results` header. A malformed clause is skipped. */
const authResultsOf = (email: InboundEmail): AuthResult[] => {
  const found: AuthResult[] = [];
  for (const header of email.headers.get('authentication-results') ?? []) {
    for (const clause of header.split(';')) {
      const head = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(clause);
      if (head === null) {
        continue;
      }
      const property = (name: string): string | null => {
        const match = new RegExp(`\\b${name}\\s*=\\s*"?([^\\s;"]+)`, 'i').exec(clause);
        return match?.[1] === undefined ? null : domainOfAddress(match[1]);
      };
      const method = (head[1] ?? '').toLowerCase() as AuthResult['method'];
      found.push({
        method,
        result: (head[2] ?? '').toLowerCase(),
        domain: method === 'spf' ? property('smtp\\.mailfrom') : property('header\\.d'),
      });
    }
  }
  return found;
};

/**
 * The truth table, first row that applies wins:
 *
 * | Report | Result |
 * |---|---|
 * | a `dkim=pass` whose `header.d` aligns with the From domain | aligned (this also rescues forwarded mail whose SPF soft-fails) |
 * | `dmarc=fail` | misaligned |
 * | `dmarc=pass` | aligned |
 * | an SPF or DKIM failure ({@link authenticationFailed}) | misaligned |
 * | an `spf=pass` whose `smtp.mailfrom` aligns with the From domain | aligned |
 * | `spf=pass` or `dkim=pass` naming a domain, none of them aligned | misaligned |
 * | anything else: no header, none, neutral, temperror, malformed | unknown |
 *
 * With several `Authentication-Results` headers all are read, and any
 * evidence against the message wins unless an aligned DKIM pass exists.
 */
export const senderCheck = (email: InboundEmail): SenderCheck => {
  const fromDomain = domainOfAddress(email.from?.address ?? '');
  const results = authResultsOf(email);
  const passes = results.filter((entry) => entry.result === 'pass');
  const aligns = (entry: AuthResult): boolean =>
    entry.domain !== null && domainsAlign(entry.domain, fromDomain);

  if (passes.some((entry) => entry.method === 'dkim' && aligns(entry))) {
    return 'aligned';
  }
  if (results.some((entry) => entry.method === 'dmarc' && entry.result === 'fail')) {
    return 'misaligned';
  }
  if (passes.some((entry) => entry.method === 'dmarc')) {
    return 'aligned';
  }
  if (authenticationFailed(email)) {
    return 'misaligned';
  }
  if (passes.some((entry) => entry.method === 'spf' && aligns(entry))) {
    return 'aligned';
  }
  // A pass that names no domain neither matches nor contradicts the From.
  return passes.some((entry) => entry.method !== 'dmarc' && entry.domain !== null)
    ? 'misaligned'
    : 'unknown';
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
