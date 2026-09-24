import type { Locale } from '@helpdock/i18n';
import type { Ticket, TicketPriority } from '@helpdock/schemas';

/**
 * The small decisions the ticket screens make about what to print. They are
 * here rather than inside a component so they can be read, and tested, without
 * rendering anything.
 *
 * Two rules from DESIGN §7 shape all of it: **numerals are Latin in both
 * locales**, so every duration is built from template strings rather than from
 * `Intl.NumberFormat`, and a formatted date asks for the Latin numbering
 * system explicitly, because `ar` would otherwise print Arabic-Indic digits.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What a person reads: `HD-1042`. The prefix is copied onto the row, not joined. */
export const ticketReference = (ticket: Pick<Ticket, 'prefix' | 'number'>): string =>
  `${ticket.prefix}-${ticket.number}`;

/**
 * A duration as the list prints it: `12m`, `4h`, `3d`. Under a minute is `now`,
 * because "0m" reads like a measurement of nothing.
 */
export const shortDuration = (milliseconds: number): string => {
  const absolute = Math.abs(milliseconds);

  if (absolute < MINUTE) {
    return 'now';
  }
  if (absolute < HOUR) {
    return `${Math.floor(absolute / MINUTE)}m`;
  }
  if (absolute < DAY) {
    return `${Math.floor(absolute / HOUR)}h`;
  }

  return `${Math.floor(absolute / DAY)}d`;
};

/** How long ago a row last moved, for the time at the end of a `TicketRow`. */
export const elapsed = (iso: string, now: number): string => shortDuration(now - Date.parse(iso));

/** DESIGN §6.2 PriorityBadge, and the 8 px dot at the start of a row. */
export const PRIORITY_TONE: Readonly<
  Record<TicketPriority, 'danger' | 'warning' | 'info' | 'neutral'>
> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

/** DESIGN §6.2 SlaTimer. Four states and nothing between them. */
export type SlaState =
  | { readonly kind: 'none' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'running' | 'atRisk'; readonly remaining: string }
  | { readonly kind: 'breached'; readonly over: string };

/** Under a fifth of the window left is "at risk" (DESIGN §6.2). */
const AT_RISK_FRACTION = 0.2;

/**
 * Which SLA state a ticket is in, from the two due dates M3-02 fills.
 *
 * The first response clock is read before the resolution clock: it is the one
 * that runs out first and the one an agent can still do something about. A
 * closed ticket has no clock at all — the work is over, and a red timer on it
 * would be a number nobody can act on.
 */
export const slaState = (ticket: Ticket, now: number): SlaState => {
  if (ticket.status.systemState === 'closed') {
    return { kind: 'none' };
  }

  if (ticket.status.pausesSla) {
    return { kind: 'paused' };
  }

  const due = ticket.firstResponseDueAt ?? ticket.resolutionDueAt;
  if (due === null) {
    return { kind: 'none' };
  }

  const dueAt = Date.parse(due);
  if (ticket.slaBreached || dueAt <= now) {
    return { kind: 'breached', over: shortDuration(now - dueAt) };
  }

  const window = dueAt - Date.parse(ticket.createdAt);
  const remaining = shortDuration(dueAt - now);

  return window > 0 && (dueAt - now) / window < AT_RISK_FRACTION
    ? { kind: 'atRisk', remaining }
    : { kind: 'running', remaining };
};

/**
 * A date as a message caption prints it: `Tue 11:48`, and `19 Sep 11:48` once
 * it is more than a week old, because a weekday stops meaning anything then.
 */
export const messageTime = (iso: string, locale: Locale, now: number): string => {
  const at = new Date(iso);
  const within = now - at.getTime() < 7 * DAY;

  return new Intl.DateTimeFormat(numbering(locale), {
    ...(within ? { weekday: 'short' } : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
};

/** DESIGN §7: Latin digits in both locales; Arabic-Indic is a v1.1 setting. */
const numbering = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : locale);

/** The brand's own name for a status, in the locale it is being read in. */
export const statusName = (
  status: { readonly name: string; readonly nameAr: string | null },
  locale: Locale,
): string => (locale === 'ar' ? (status.nameAr ?? status.name) : status.name);

/**
 * Plain text as the one paragraph the api will sanitise, with the four
 * characters that would otherwise be markup escaped.
 *
 * The composer holds **text**: an agent who types `<b>` means those characters,
 * and a screen that passed them through as markup would be relying on the
 * sanitiser to undo its own mistake. The sanitiser is the second line here, as
 * it is for every other channel, never the first.
 */
export const paragraph = (text: string): string =>
  `<p>${text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '<br />')}</p>`;

/** How much of the window is gone, clamped: a bar never runs past its track. */
export const elapsedFraction = (createdAt: string, dueAt: string, now: number): number => {
  const window = Date.parse(dueAt) - Date.parse(createdAt);
  if (window <= 0) {
    return 1;
  }

  return Math.min(Math.max((now - Date.parse(createdAt)) / window, 0), 1);
};
