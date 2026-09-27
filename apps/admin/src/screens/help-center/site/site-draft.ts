import {
  type HcLink,
  type HcLinks,
  type HcLocale,
  type HcStaffPassRequest,
  type HcTheme,
  hcLinksSchema,
  hcSitePathSchema,
  whiteContrastOn,
} from '@helpdock/schemas';
import { validateBrandTheme } from '@helpdock/ui';

/**
 * The Settings tab's drafts (M5-06, `Admin/HelpCenter-Settings`) and the
 * "open the help center" address (M5-03): pure, so the rules the api
 * enforces are tested here without a screen.
 */

// ------------------------------------------------------------------- theme

export type AccentCheck =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'pass' | 'fail'; readonly ratio: number };

// The `#` stays out of the pattern: scripts/controller-scan.ts tokenizes
// source without a parser, and `/^#` reads to it as a private name.
const SIX_HEX_DIGITS = /^[0-9a-fA-F]{6}$/;

/**
 * The line under Accent: white text on it, as the artboard words it, and
 * whether DESIGN §8 lets it be saved — which is the accent against the page,
 * 3:1 at least in every mode the brand shows.
 */
export const checkAccent = (theme: HcTheme): AccentCheck => {
  const hex = theme.accent.trim();
  if (!(hex.startsWith('#') && SIX_HEX_DIGITS.test(hex.slice(1)))) {
    return { kind: 'invalid' };
  }
  const blocked = validateBrandTheme({ ...theme, accent: hex }).some(
    (problem) => problem.severity === 'error',
  );
  return { kind: blocked ? 'fail' : 'pass', ratio: Math.round(whiteContrastOn(hex) * 10) / 10 };
};

/** The radius field's text as a radius, or null when it is not a whole number from 0 to 12. */
export const radiusOf = (text: string): number | null => {
  const value = Number(text.trim());
  return /^\d{1,2}$/.test(text.trim()) && value <= 12 ? value : null;
};

// ------------------------------------------------------------------ lists

/** `list` with the item at `index` moved by `delta`, or the same list at an edge. */
export const moved = <T>(list: readonly T[], index: number, delta: -1 | 1): T[] => {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
};

export const EMPTY_LINK: HcLink = { labelEn: '', labelAr: '', url: 'https://' };

/** Whether the links card may be saved as it stands. */
export const linksValid = (links: HcLinks): boolean => hcLinksSchema.safeParse(links).success;

/** A link's name for the row's labels: its label in the reader's language, or the other one. */
export const linkName = (link: HcLink, locale: HcLocale, untitled: string): string =>
  (locale === 'ar' ? link.labelAr || link.labelEn : link.labelEn || link.labelAr) || untitled;

// ----------------------------------------------------- opening the help center

/** The admin route that exchanges a staff pass and lands on the help center (M5-03). */
export const OPEN_HELP_CENTER_PATH = '/help-center/open';

/**
 * The address "View help center", "Preview" and the internal-only wall's
 * sign-in link to. It is an admin page, so an expired session signs in first
 * and comes back here (`returnTo`).
 */
export const openHelpCenterHref = (
  brandId: string,
  target: { readonly path?: string; readonly preview?: { articleId: string; locale: HcLocale } },
): string => {
  const params = new URLSearchParams({ brand: brandId });
  if (target.preview !== undefined) {
    params.set('article', target.preview.articleId);
    params.set('locale', target.preview.locale);
  } else if (target.path !== undefined) {
    params.set('path', target.path);
  }
  return `${OPEN_HELP_CENTER_PATH}?${params.toString()}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `/help-center/open` was asked for, or null for an address it cannot act on. */
export const openRequestOf = (
  search: URLSearchParams,
): { readonly brandId: string; readonly request: HcStaffPassRequest } | null => {
  const brandId = search.get('brand') ?? '';
  if (!UUID.test(brandId)) {
    return null;
  }
  const article = search.get('article');
  const locale = search.get('locale');
  if (article !== null) {
    return UUID.test(article) && (locale === 'en' || locale === 'ar')
      ? { brandId, request: { preview: { articleId: article, locale } } }
      : null;
  }
  const path = search.get('path');
  if (path === null) {
    return { brandId, request: {} };
  }
  return hcSitePathSchema.safeParse(path).success ? { brandId, request: { path } } : null;
};
