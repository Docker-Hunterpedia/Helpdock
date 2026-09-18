export interface PublicInstallInfo {
  /** Help center host of the install's first brand, shown on the sign-in card. */
  readonly primaryDomain: string;
  /** How many brands this install serves. 1 drops the "and n others" clause. */
  readonly brandCount: number;
}

const DOMAIN_META = 'helpdock:primary-domain';
const BRAND_COUNT_META = 'helpdock:brand-count';

const metaContent = (doc: Document, name: string): string | undefined =>
  doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || undefined;

/**
 * The only thing the sign-in screen knows before anyone has signed in, and the
 * only thing it is allowed to know: no endpoint may enumerate brands to an
 * anonymous visitor. The api serves `index.html` (ARCHITECTURE §3) and rewrites
 * these two meta tags per install; the checked-in values are the dev fixture.
 */
export function readPublicInstallInfo(doc: Document = document): PublicInstallInfo {
  const parsed = Number.parseInt(metaContent(doc, BRAND_COUNT_META) ?? '', 10);

  return {
    primaryDomain: metaContent(doc, DOMAIN_META) ?? globalThis.location?.hostname ?? '',
    brandCount: Number.isInteger(parsed) && parsed > 0 ? parsed : 1,
  };
}
