import type { Locale } from '@helpdock/i18n';
import { NOTIFICATION_PAUSE_MAX_DAYS, type NotificationPreferencesView } from '@helpdock/schemas';
import { fromWallClock, toWallClock } from '../screens/help-center/time.js';

/**
 * What stops notification email for this person, and the pause choices (M14-11,
 * `Admin/Account-Notifications-Schedule`). Pure, so every state and every
 * preset is provable without a screen.
 */

export type EmailStatusKind = 'unsubscribed' | 'paused' | 'off' | 'notConfigured';

/**
 * The reasons email is not reaching this person, most lasting first: an
 * unsubscribe, then a pause, then the Off schedule, then an install that cannot
 * send email at all. The card draws each; the bell's panel draws the first.
 */
export const emailStatuses = (
  view: Pick<NotificationPreferencesView, 'emailDelivery' | 'emailConfigured'>,
  now: number,
): EmailStatusKind[] => {
  const { emailDelivery } = view;
  const kinds: EmailStatusKind[] = [];

  if (emailDelivery.unsubscribedAt !== null) {
    kinds.push('unsubscribed');
  }
  if (emailDelivery.pausedUntil !== null && Date.parse(emailDelivery.pausedUntil) > now) {
    kinds.push('paused');
  }
  if (emailDelivery.schedule === 'off') {
    kinds.push('off');
  }
  if (!view.emailConfigured) {
    kinds.push('notConfigured');
  }

  return kinds;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The zone the browser reads in, for a view that names none. */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of the day `at` falls on in the zone, which is what a date input holds. */
export const localDate = (at: Date, zone: string): string =>
  toWallClock(at.toISOString(), zone).date;

/** `YYYY-MM-DD` of the day after `date`, by the calendar. */
const nextDay = (date: string, days = 1): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));

  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
};

/** 09:00 on a `YYYY-MM-DD` day in the zone, or null when it is not a day. */
const nineOn = (date: string, zone: string): Date | null => {
  const iso = fromWallClock({ date, time: '09:00' }, zone);

  return iso === null ? null : new Date(iso);
};

/**
 * The presets of the pause menu, worked out in the zone given: the person's
 * own (Your account › Profile, M14-12), the brand's until they choose one.
 * "Until tomorrow 09:00" is 09:00 of the next calendar day there.
 */
export const pausePresets = (
  now: Date,
  zone: string,
): { hour: Date; tomorrow: Date; week: Date } => ({
  hour: new Date(now.getTime() + HOUR_MS),
  // A day after a valid date is always a valid date, so the fallback never shows.
  tomorrow: nineOn(nextDay(localDate(now, zone)), zone) ?? new Date(now.getTime() + DAY_MS),
  week: new Date(now.getTime() + 7 * DAY_MS),
});

/** The first and last day "Until a date…" offers: tomorrow, and the api's limit less a day. */
export const pauseDateBounds = (now: Date, zone: string): { min: string; max: string } => {
  const today = localDate(now, zone);

  return { min: nextDay(today), max: nextDay(today, NOTIFICATION_PAUSE_MAX_DAYS - 1) };
};

export type PauseDateProblem = 'invalid' | 'tooSoon' | 'tooFar';

/** Why a typed day cannot end a pause, or `null`, with the instant it means (09:00 that day in the zone). */
export const pauseDateEnd = (
  value: string,
  now: Date,
  zone: string,
): { problem: PauseDateProblem } | { problem: null; end: Date } => {
  const end = nineOn(value, zone);
  if (end === null || Number.isNaN(end.getTime()) || nextDay(value, 0) !== value) {
    return { problem: 'invalid' };
  }
  const { min, max } = pauseDateBounds(now, zone);
  if (value < min) {
    return { problem: 'tooSoon' };
  }

  return value > max ? { problem: 'tooFar' } : { problem: null, end };
};

const FORMAT_TAG: Record<Locale, string> = { en: 'en-GB', ar: 'ar-u-nu-latn' };

/**
 * "17:00" for a time today, "Tue 27 Oct, 09:00" for another day: Latin digits
 * in both languages, as every artboard writes times.
 */
export const whenLabel = (
  iso: string | Date,
  locale: Locale,
  now: number,
  zone: string = browserZone(),
): string => {
  const at = typeof iso === 'string' ? new Date(iso) : iso;
  const sameDay = localDate(new Date(now), zone) === localDate(at, zone);

  return new Intl.DateTimeFormat(
    FORMAT_TAG[locale],
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }
      : {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone: zone,
        },
  ).format(at);
};

/** "27 Oct", for the date an unsubscribe happened. */
export const dayLabel = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(FORMAT_TAG[locale], { day: 'numeric', month: 'short' }).format(
    new Date(iso),
  );

export const hourOptions: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);
export const hourLabel = (hour: number): string => `${pad(hour)}:00`;
