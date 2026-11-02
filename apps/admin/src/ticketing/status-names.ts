/** What a status is called in the reader's language, and the other name under it. */
export interface StatusNames {
  readonly primary: string;
  readonly primaryLang: 'en' | 'ar';
  readonly secondary: string | null;
  readonly secondaryLang: 'en' | 'ar';
}

interface Named {
  readonly name: string;
  readonly nameAr: string | null;
}

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== '';

/**
 * In the Arabic UI the Arabic name leads and the English one is the second
 * line; in English it is the other way round. A status with no Arabic name
 * shows its one name in both and has no second line.
 */
export function statusNames(status: Named, locale: 'en' | 'ar'): StatusNames {
  if (!present(status.nameAr)) {
    return { primary: status.name, primaryLang: 'en', secondary: null, secondaryLang: 'ar' };
  }
  return locale === 'ar'
    ? { primary: status.nameAr, primaryLang: 'ar', secondary: status.name, secondaryLang: 'en' }
    : { primary: status.name, primaryLang: 'en', secondary: status.nameAr, secondaryLang: 'ar' };
}

/** The one name to print where a status shows a single label (a pill, a chip). */
export const statusLabel = (status: Named, locale: 'en' | 'ar'): string =>
  statusNames(status, locale).primary;
