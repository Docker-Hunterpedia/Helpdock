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
 *
 * Header trust: a sender can put `Authentication-Results` headers of its own
 * into the message, and they sit *below* the one the last receiving hop
 * added, which is the first in message order. So anything that can make the
 * result `aligned` is read from the topmost header only, while evidence
 * against the message is read from every header (a forged failure only hurts
 * its own sender).
 */
export type SenderCheck = 'aligned' | 'misaligned' | 'unknown';

interface AuthResult {
  readonly method: 'spf' | 'dkim' | 'dmarc';
  readonly result: string;
  /**
   * The domain the result is about: `smtp.mailfrom` for SPF, `header.d` (or
   * the domain of `header.i`, as Gmail writes it) for DKIM. Lower-cased.
   */
  readonly domain: string | null;
}

const domainOfAddress = (value: string): string => {
  const at = value.lastIndexOf('@');
  return (at === -1 ? value : value.slice(at + 1)).toLowerCase();
};

const labelCount = (domain: string): number => domain.split('.').filter(Boolean).length;

/**
 * Whether a pass for `authenticated` speaks for a From on `from`: the same
 * domain, or the authenticated one is a parent of the From (`bank.com`
 * signing for `news.bank.com`).
 *
 * The other direction (a pass on `evil.bank.com` for a From on `bank.com`) is
 * not accepted here: a domain that hands out subdomains would let any tenant
 * speak for the parent. Only a `dmarc=pass` from the receiving server vouches
 * for it. The parent needs two labels, so `com` never speaks for anyone, but
 * with no public-suffix list a two-label suffix such as `co.uk` is not
 * recognised; that gap is documented in the email guide.
 */
export const domainsAlign = (authenticated: string, from: string): boolean => {
  const parent = authenticated.toLowerCase();
  const child = from.toLowerCase();
  return labelCount(parent) >= 2 && (parent === child || child.endsWith(`.${parent}`));
};

/** Drops `( ... )` comments, nested, honouring quoted strings and backslashes. */
const stripComments = (value: string): string => {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '\\' && index + 1 < value.length) {
      if (depth === 0) {
        out += char + value.charAt(index + 1);
      }
      index += 1;
    } else if (char === '"' && depth === 0) {
      quoted = !quoted;
      out += char;
    } else if (!quoted && char === '(') {
      depth += 1;
    } else if (!quoted && char === ')' && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
};

/** A quoted string's content is somebody else's text; it never names a property. */
const blankQuotes = (value: string): string => value.replace(/"(?:[^"\\]|\\.)*"/g, '"_"');

const PROPERTY_VALUE = '((?:"_"|[^\\s";])+)';

/** The last `name=value` of a clause (a later one is the one the server wrote after any decoy). */
const lastProperty = (clause: string, names: readonly string[]): string | null => {
  const matches = [
    ...clause.matchAll(new RegExp(`\\b(?:${names.join('|')})\\s*=\\s*${PROPERTY_VALUE}`, 'gi')),
  ];
  const value = matches.at(-1)?.[1];
  if (value === undefined) {
    return null;
  }
  const domain = domainOfAddress(value.replace(/"_"/g, ''));
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
};

/** The results one `Authentication-Results` header reports. A malformed clause is skipped. */
const resultsOfHeader = (header: string): AuthResult[] => {
  const found: AuthResult[] = [];
  for (const clause of blankQuotes(stripComments(header)).split(';')) {
    const head = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(clause);
    if (head === null) {
      continue;
    }
    const method = (head[1] ?? '').toLowerCase() as AuthResult['method'];
    found.push({
      method,
      result: (head[2] ?? '').toLowerCase(),
      domain:
        method === 'spf'
          ? lastProperty(clause, ['smtp\\.mailfrom'])
          : method === 'dkim'
            ? (lastProperty(clause, ['header\\.d']) ?? lastProperty(clause, ['header\\.i']))
            : null,
    });
  }
  return found;
};

/**
 * The truth table, first row that applies wins. "Top" is the first
 * `Authentication-Results` header in message order, the receiving server's own.
 *
 * | Report | Result |
 * |---|---|
 * | `dmarc=fail` in any header | misaligned |
 * | `dmarc=pass` in the top header | aligned |
 * | top `dkim=pass` for a domain that speaks for the From domain (this also rescues forwarded mail whose SPF soft-fails) | aligned |
 * | an SPF or DKIM failure ({@link authenticationFailed}) in any header | misaligned |
 * | top `spf=pass` whose `smtp.mailfrom` speaks for the From domain | aligned |
 * | top `spf=pass` or `dkim=pass` naming a domain, none of them speaking for it | misaligned |
 * | anything else: no header, none, neutral, temperror, malformed, a pass naming no domain | unknown |
 *
 * Headers are kept in message order by every inbound path (mailparser's header
 * lines, the providers' ordered header lists); the generic JSON endpoint can
 * carry one value per name, which is then the top.
 */
export const senderCheck = (email: InboundEmail): SenderCheck => {
  const fromDomain = domainOfAddress(email.from?.address ?? '');
  const headers = email.headers.get('authentication-results') ?? [];
  const everything = headers.flatMap(resultsOfHeader);
  const top = headers.length === 0 ? [] : resultsOfHeader(headers[0] ?? '');
  const passes = top.filter((entry) => entry.result === 'pass');
  const speaks = (entry: AuthResult): boolean =>
    entry.domain !== null && domainsAlign(entry.domain, fromDomain);

  if (everything.some((entry) => entry.method === 'dmarc' && entry.result === 'fail')) {
    return 'misaligned';
  }
  if (passes.some((entry) => entry.method === 'dmarc')) {
    return 'aligned';
  }
  if (passes.some((entry) => entry.method === 'dkim' && speaks(entry))) {
    return 'aligned';
  }
  if (authenticationFailed(email)) {
    return 'misaligned';
  }
  if (passes.some((entry) => entry.method === 'spf' && speaks(entry))) {
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
