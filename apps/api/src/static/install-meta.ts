/**
 * The two meta tags the admin sign-in card reads before anyone has signed in
 * (`apps/admin/src/install/public-info.ts`). The checked-in `index.html` carries
 * the development fixture; the api rewrites them per install on the way out, so
 * no endpoint has to enumerate brands to an anonymous visitor.
 */

export interface InstallMeta {
  /** Help-center host of the install's first brand. */
  readonly primaryDomain: string;
  /** How many brands this install serves. The caption drops its clause at 1. */
  readonly brandCount: number;
}

export const PRIMARY_DOMAIN_META = 'helpdock:primary-domain';
export const BRAND_COUNT_META = 'helpdock:brand-count';

/** Escapes a value for a double-quoted HTML attribute. */
const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

// The two names are module constants, and `:` is not a regular-expression
// metacharacter, so nothing here interpolates anything a request supplied.
const metaPattern = (name: string): RegExp => new RegExp(`<meta\\s+name="${name}"[^>]*>`, 'i');

const replaceMeta = (html: string, name: string, content: string): string =>
  html.replace(metaPattern(name), `<meta name="${name}" content="${escapeAttribute(content)}" />`);

/**
 * Rewrites both tags in place. A document that carries neither is returned
 * unchanged: the admin falls back to the host it was served from and to a single
 * brand, which is the right answer for a build served from somewhere else.
 */
export const rewriteInstallMeta = (html: string, meta: InstallMeta): string =>
  replaceMeta(
    replaceMeta(html, PRIMARY_DOMAIN_META, meta.primaryDomain),
    BRAND_COUNT_META,
    String(meta.brandCount),
  );
