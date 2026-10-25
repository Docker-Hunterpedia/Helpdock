/**
 * The repository's star count, a snapshot the Pages workflow takes at build
 * time and passes as `HELPDOCK_STARS`. Unlike the release number, a missing or
 * unreadable value is not an error: the site shows its links without a count.
 */
export function parseStars(fromEnv: string | undefined): number | undefined {
  const value = fromEnv?.trim() ?? '';
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

type StarLocale = 'en' | 'ar';

// Arabic pages keep Latin digits (DESIGN.md §3.2).
const NUMBER_LOCALE: Record<StarLocale, string> = { en: 'en', ar: 'ar-u-nu-latn' };

/** "999", "1.2K": the count as the header shows it. */
export function formatStars(count: number, locale: StarLocale): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale], {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(count);
}

/** The link's accessible name, with the full count. */
export function starLabel(count: number | undefined, locale: StarLocale): string {
  if (count === undefined) {
    return locale === 'ar' ? 'أضف نجمة لـ Helpdock على GitHub' : 'Star Helpdock on GitHub';
  }
  const full = new Intl.NumberFormat(NUMBER_LOCALE[locale]).format(count);
  return locale === 'ar'
    ? `أضف نجمة لـ Helpdock على GitHub، عدد النجوم: ${full}`
    : `Star Helpdock on GitHub, ${full} ${count === 1 ? 'star' : 'stars'}`;
}
