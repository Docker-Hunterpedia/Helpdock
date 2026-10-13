import type { Locale } from '@helpdock/i18n';
import type { MetaTicketContext } from '@helpdock/schemas';
import type { useT } from '../../../app/i18n.js';
import { clockDuration, numbering } from '../format.js';

/**
 * The small decisions the Meta half of the ticket view makes about what to
 * print (M10-08, `Admin/Ticket-Meta`): which string names the account, the
 * customer's handle, how long is left, when a window closes. Plain functions,
 * so they are read and tested without rendering anything.
 *
 * DESIGN §7: numerals are Latin in both locales, so every date asks for the
 * Latin numbering system, and durations are built from template strings.
 */

type Translate = ReturnType<typeof useT>;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The brand's account as the header, the "via" line and the composer name it: the number, the Page or the `@handle`. */
export const accountLabel = (account: MetaTicketContext['account']): string => {
  switch (account.platform) {
    case 'whatsapp':
      return account.displayPhone ?? account.displayName;
    case 'messenger':
      return account.displayName;
    case 'instagram':
      return account.username === undefined ? account.displayName : `@${account.username}`;
  }
};

/** The customer's number or `@handle`, when the platform gave one; Messenger gives neither. */
export const customerHandle = (context: MetaTicketContext): string | undefined => {
  switch (context.account.platform) {
    case 'whatsapp':
      return context.phone;
    case 'instagram':
      return context.username === undefined ? undefined : `@${context.username}`;
    case 'messenger':
      return undefined;
  }
};

/** What the strip and the composer call the customer: the contact's name, else "the customer". */
export const customerLabel = (name: string | null, t: Translate): string =>
  name === null || name.trim() === '' ? t('tickets:meta.theCustomer') : name;

/**
 * Time left in a window, as the SLA card prints a clock: `22h 54m`, `5d 18h`.
 * Under a minute is a sentence rather than "0m", which reads like a measurement
 * of nothing.
 */
export const windowLeft = (closesAt: string, now: number, t: Translate): string => {
  const left = Date.parse(closesAt) - now;
  return left < MINUTE ? t('tickets:meta.window.lessThanAMinute') : clockDuration(left);
};

/** The last hour of a window, when the strip turns to the warning tone. */
export const isClosing = (closesAt: string, now: number): boolean => {
  const left = Date.parse(closesAt) - now;
  return left > 0 && left <= HOUR;
};

/** `09:25`, in the reader's language and Latin digits. */
export const clockTime = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(numbering(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

const startOfDay = (instant: number): number => {
  const day = new Date(instant);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * When a window closes, in words: "today at 09:25", "tomorrow at 09:25",
 * "Thursday at 10:02", and a date once it is more than six days away. The
 * `<time>` carrying it holds the exact instant.
 */
export const closesWhen = (iso: string, locale: Locale, now: number, t: Translate): string => {
  const at = Date.parse(iso);
  const time = clockTime(iso, locale);
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);

  if (days === 0) {
    return t('tickets:meta.window.today', { time });
  }
  if (days === 1) {
    return t('tickets:meta.window.tomorrow', { time });
  }
  const day = new Intl.DateTimeFormat(
    numbering(locale),
    days > 1 && days < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'short' },
  ).format(new Date(at));

  return t('tickets:meta.window.on', { day, time });
};

/** "2 hours ago", "7 days ago": how long since a window closed, in the reader's language. */
export const agoLabel = (iso: string, locale: Locale, now: number): string => {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const format = new Intl.RelativeTimeFormat(numbering(locale), { numeric: 'auto' });

  if (elapsed < HOUR) {
    return format.format(-Math.max(1, Math.floor(elapsed / MINUTE)), 'minute');
  }
  if (elapsed < 2 * DAY) {
    return format.format(-Math.floor(elapsed / HOUR), 'hour');
  }

  return format.format(-Math.floor(elapsed / DAY), 'day');
};
