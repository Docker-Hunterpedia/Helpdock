import type { HcLocale } from '@helpdock/schemas';
import { formatDate } from '../help-center/site/render/text.js';

/**
 * Times as the portal's pages print them: in the brand's time zone, with Latin
 * digits in both languages (DESIGN §7), never the viewer's machine's zone, so a
 * page reads the same wherever it is opened.
 */

const zoneOr = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
};

/** `10 Nov, 11:48` / `10 نوفمبر، 11:48`: a message's time, the year left to the ticket's header. */
export const formatMessageTime = (date: Date, locale: HcLocale, timeZone: string): string => {
  const zone = zoneOr(timeZone);
  const part = (tag: string, options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(tag, { ...options, timeZone: zone }).format(date);
  const day = part('en-US', { day: 'numeric' });
  const month =
    locale === 'ar' ? part('ar-u-nu-latn', { month: 'long' }) : part('en-US', { month: 'short' });
  const time = part('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day} ${month}${locale === 'ar' ? '،' : ','} ${time}`;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 hours ago", "yesterday", "3 days ago"; a date once it is a month old. The
 * words come from `Intl`, so Arabic gets its own plurals ("قبل ساعتين").
 */
export const formatAgo = (date: Date, now: Date, locale: HcLocale, timeZone: string): string => {
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  const rtf = new Intl.RelativeTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
    numeric: 'auto',
  });
  if (elapsed < MINUTE) {
    return rtf.format(0, 'second');
  }
  if (elapsed < HOUR) {
    return rtf.format(-Math.floor(elapsed / MINUTE), 'minute');
  }
  if (elapsed < DAY) {
    return rtf.format(-Math.floor(elapsed / HOUR), 'hour');
  }
  if (elapsed < 30 * DAY) {
    return rtf.format(-Math.floor(elapsed / DAY), 'day');
  }
  return formatDate(date, locale, timeZone);
};
