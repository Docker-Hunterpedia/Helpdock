import type { Locale } from '@helpdock/i18n';
import { NOTIFICATION_PAUSE_MAX_DAYS, type NotificationPreferencesView } from '@helpdock/schemas';

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

/** 09:00 on the given local day. */
const nineOn = (day: Date): Date => {
  const at = new Date(day);
  at.setHours(9, 0, 0, 0);

  return at;
};

/**
 * The presets of the pause menu, in the reader's own time zone (the person's
 * time zone arrives with M14-12; until then it is the browser's, which is where
 * M14-12 starts it). "Until tomorrow 09:00" is 09:00 of the next calendar day.
 */
export const pausePresets = (now: Date): { hour: Date; tomorrow: Date; week: Date } => {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    hour: new Date(now.getTime() + HOUR_MS),
    tomorrow: nineOn(tomorrow),
    week: new Date(now.getTime() + 7 * DAY_MS),
  };
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` in local time, which is what a date input holds. */
export const localDate = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** The first and last day "Until a date…" offers: tomorrow, and the api's limit less a day. */
export const pauseDateBounds = (now: Date): { min: string; max: string } => {
  const first = new Date(now);
  first.setDate(first.getDate() + 1);
  const last = new Date(now);
  last.setDate(last.getDate() + NOTIFICATION_PAUSE_MAX_DAYS - 1);

  return { min: localDate(first), max: localDate(last) };
};

export type PauseDateProblem = 'invalid' | 'tooSoon' | 'tooFar';

/** Why a typed day cannot end a pause, or `null`, with the instant it means (09:00 that day). */
export const pauseDateEnd = (
  value: string,
  now: Date,
): { problem: PauseDateProblem } | { problem: null; end: Date } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return { problem: 'invalid' };
  }
  const end = nineOn(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(end.getTime())) {
    return { problem: 'invalid' };
  }
  const { min, max } = pauseDateBounds(now);
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
export const whenLabel = (iso: string | Date, locale: Locale, now: number): string => {
  const at = typeof iso === 'string' ? new Date(iso) : iso;
  const sameDay = new Date(now).toDateString() === at.toDateString();

  return new Intl.DateTimeFormat(
    FORMAT_TAG[locale],
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
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
