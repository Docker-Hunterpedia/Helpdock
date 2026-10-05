import type { Locale } from '@helpdock/i18n';

/**
 * Month names in the reader's language, digits Latin in both (DESIGN §7),
 * which is what `-u-nu-latn` asks `Intl` for.
 */
const dateLocale = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

/** `5 Sep 2026`. */
export const formatDay = (iso: string, locale: Locale, timeZone?: string): string =>
  new Intl.DateTimeFormat(dateLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));

/** `5 Sep`, for a range whose year is said once at its end. */
export const formatDayMonth = (iso: string, locale: Locale, timeZone?: string): string =>
  new Intl.DateTimeFormat(dateLocale(locale), {
    day: 'numeric',
    month: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));

/** `04:00`, in the reader's clock. */
export const formatClock = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(dateLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

/** `78.4 %` from 0.784: one decimal and a space before the sign, as the artboards print it. */
export const formatShare = (share: number): string => `${(share * 100).toFixed(1)} %`;
