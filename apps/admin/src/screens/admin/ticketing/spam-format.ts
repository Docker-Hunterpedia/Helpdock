import type { Locale } from '@helpdock/i18n';
import type { BlockedSender } from '@helpdock/schemas';

/**
 * The two small decisions the Spam tab makes about a block-list row, kept
 * apart from the component so they can be tested on values.
 */

/** The artboard's "18 Sep", in the locale's order and Latin digits in both locales (DESIGN §7). */
export const addedOn = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));

/**
 * Whether a row answers the search box. The value is stored normalised, so the
 * term is compared the same way — lower-cased, and for a phone number without
 * the spaces a person types between groups.
 */
export const matchesSender = (row: Pick<BlockedSender, 'value'>, term: string): boolean => {
  const wanted = term.trim().toLowerCase();
  if (wanted === '') {
    return true;
  }

  return (
    row.value.toLowerCase().includes(wanted) ||
    row.value.includes(wanted.replaceAll(/[\s\-().]/g, ''))
  );
};
