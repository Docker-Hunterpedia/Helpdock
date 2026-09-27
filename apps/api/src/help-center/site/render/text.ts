import { escapeHtml } from '@helpdock/channels';
import { createI18n } from '@helpdock/i18n';
import type { HcLocale } from '@helpdock/schemas';

/**
 * The pages' words and numbers. The i18n instance does not escape
 * (`escapeValue: false`), so whatever reaches markup goes through
 * {@link esc}; nothing a brand or a visitor typed is ever built into html
 * any other way.
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const instances = new Map<HcLocale, Translate>();

/** The `hcSite` catalog in one language. Built once per language per process. */
export const translator = (locale: HcLocale): Translate => {
  let t = instances.get(locale);
  if (t === undefined) {
    const fixed = createI18n({ lng: locale }).getFixedT(locale, 'hcSite');
    // Keys are built from codes (`preview.${state}.title`), which i18next's
    // literal key union cannot check, so the call goes through a looser type.
    t = (key, options) => (fixed as unknown as Translate)(key, options);
    instances.set(locale, t);
  }
  return t;
};

export const esc = escapeHtml;

/** Text in the other language, marked so a screen reader and the bidi algorithm get it right. */
export const inLanguage = (text: string, lang: HcLocale, page: HcLocale): string =>
  lang === page
    ? esc(text)
    : `<span lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">${esc(text)}</span>`;

/** A zone `Intl` accepts: the brand's, or UTC for one it does not know. */
const zoneOr = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
};

/**
 * The day, month and year of `date` in the zone, day first in both languages
 * (`12 Sep 2026`, `12 سبتمبر 2026`) with Latin digits (DESIGN §7). Built from
 * parts because `en-GB` spells September "Sept" and the artboards do not.
 */
const dayMonthYear = (date: Date, locale: HcLocale, timeZone: string): string => {
  const part = (tag: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(tag, { ...options, timeZone }).format(date);
  const day = part('en-US', { day: 'numeric' });
  const month =
    locale === 'ar' ? part('ar-u-nu-latn', { month: 'long' }) : part('en-US', { month: 'short' });
  const year = part('en-US', { year: 'numeric' });
  return `${day} ${month} ${year}`;
};

export const formatDate = (date: Date, locale: HcLocale, timeZone: string): string =>
  dayMonthYear(date, locale, zoneOr(timeZone));

/** The same, with the time and the zone, for a scheduled publish. */
export const formatDateTime = (date: Date, locale: HcLocale, timeZone: string): string => {
  const zone = zoneOr(timeZone);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  }).format(date);
  return `${dayMonthYear(date, locale, zone)} ${time} (${zone})`;
};

/** Words per minute a reader is assumed to manage. */
const READING_SPEED = 200;

/** Minutes to read an article's html, at least one. */
export const readingMinutes = (html: string): number => {
  const words = html
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '').length;
  return Math.max(1, Math.ceil(words / READING_SPEED));
};
