import type { Translate } from './i18n/translator.js';
import type { WidgetLocale } from './transport/types.js';

/**
 * Dates and times in the visitor's language with Latin digits in both locales
 * (DESIGN §7: Arabic-Indic digits are a v1.1 setting) and a 24-hour clock, as
 * the boards draw them.
 */
const intlLocale = (locale: WidgetLocale) => (locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB');

export function formatTime(iso: string, locale: WidgetLocale, timeZone?: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today", "Yesterday", a weekday within the last week, otherwise a date. */
export function dayLabel(iso: string, now: Date, locale: WidgetLocale, t: Translate): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) {
    return t('thread.today');
  }
  if (days === 1) {
    return t('thread.yesterday');
  }
  const options: Intl.DateTimeFormatOptions =
    days > 1 && days < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'long' };
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(date);
}

export function formatDate(iso: string, locale: WidgetLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

/** The pieces of "We open Sunday at 09:00 (Gulf Standard Time)", in the brand's zone. */
export function nextOpening(
  iso: string,
  timeZone: string,
  locale: WidgetLocale,
): { day: string; time: string; zone: string } {
  const date = new Date(iso);
  const zonePart = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    timeZoneName: 'longGeneric',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName');

  return {
    day: new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', timeZone }).format(date),
    time: formatTime(iso, locale, timeZone),
    zone: zonePart?.value ?? timeZone,
  };
}

/** The calendar date of an instant in a zone, as a UTC midnight, so two of them subtract to whole days. */
const dateInZone = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
};

/**
 * M7-06: how to word "The team is away until …". `key` is how far away the
 * opening is, counted in whole calendar days of the team's zone, because the
 * time shown is in that zone and not the visitor's: today, tomorrow, a
 * weekday within six days, otherwise the date.
 */
export function awayWhen(
  iso: string,
  timeZone: string,
  now: Date,
  locale: WidgetLocale,
): {
  key: 'today' | 'tomorrow' | 'weekday' | 'date';
  day: string;
  date: string;
  time: string;
  zone: string;
} {
  const opening = new Date(iso);
  const days = Math.round((dateInZone(opening, timeZone) - dateInZone(now, timeZone)) / 86_400_000);

  return {
    key: days <= 0 ? 'today' : days === 1 ? 'tomorrow' : days < 7 ? 'weekday' : 'date',
    ...nextOpening(iso, timeZone, locale),
    date: new Intl.DateTimeFormat(intlLocale(locale), {
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(opening),
  };
}

/** 0:07, 2:00 — a timer, so Latin digits and no locale formatting. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? [words[0]?.[0], words[words.length - 1]?.[0]] : [words[0]?.[0]];
  return letters.join('').toUpperCase();
}

/** "Lina, Karim and Sara" in English, "لينا وكريم وسارة" in Arabic. */
export function listNames(names: readonly string[], locale: WidgetLocale): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}

/** "2nd" in English; Arabic uses the bare number inside its own sentence. */
export function ordinal(position: number, locale: WidgetLocale, t: Translate): string {
  const form = new Intl.PluralRules(locale, { type: 'ordinal' }).select(position);
  const key = form === 'one' || form === 'two' || form === 'few' ? form : 'other';
  return t(`queue.ordinal.${key}`, { n: position });
}
