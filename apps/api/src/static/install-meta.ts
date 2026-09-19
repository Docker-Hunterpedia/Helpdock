import type { InstallState } from '@helpdock/schemas';

/**
 * The meta tags the admin reads out of `index.html` before anything has been
 * fetched (`apps/admin/src/install/public-info.ts`). The checked-in
 * `index.html` carries the development fixture; the api rewrites them per
 * install on the way out, so no endpoint has to answer questions about an
 * install to an anonymous visitor (DOMAIN-RULES §1.1).
 *
 * There are four. The first two are what the sign-in card says; the third
 * decides whether the app is a wizard or an admin at all, which has to be known
 * before the first route renders; the fourth is the version in the wizard's
 * caption, which the System page cannot supply because nobody is signed in yet.
 */

export interface InstallMeta {
  /** Help-center host of the install's first brand. */
  readonly primaryDomain: string;
  /** How many brands this install serves. The caption drops its clause at 1. */
  readonly brandCount: number;
  /** `fresh` while the `users` table is empty; see `install/install-state.ts`. */
  readonly installState: InstallState;
  /** The api's own version, as the wizard's `v0.1.0 · …` caption prints it. */
  readonly version: string;
}

export const PRIMARY_DOMAIN_META = 'helpdock:primary-domain';
export const BRAND_COUNT_META = 'helpdock:brand-count';
export const INSTALL_STATE_META = 'helpdock:install-state';
export const VERSION_META = 'helpdock:version';

/** Escapes a value for a double-quoted HTML attribute. */
const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

// The names are module constants, and `:` is not a regular-expression
// metacharacter, so nothing here interpolates anything a request supplied.
const metaPattern = (name: string): RegExp => new RegExp(`<meta\\s+name="${name}"[^>]*>`, 'i');

const replaceMeta = (html: string, name: string, content: string): string =>
  html.replace(metaPattern(name), `<meta name="${name}" content="${escapeAttribute(content)}" />`);

/**
 * Rewrites every tag in place. A document that carries none is returned
 * unchanged: the admin falls back to the host it was served from, to a single
 * brand and to a configured install, which is the right answer for a build
 * served from somewhere else.
 */
export const rewriteInstallMeta = (html: string, meta: InstallMeta): string => {
  const replacements: readonly (readonly [string, string])[] = [
    [PRIMARY_DOMAIN_META, meta.primaryDomain],
    [BRAND_COUNT_META, String(meta.brandCount)],
    [INSTALL_STATE_META, meta.installState],
    [VERSION_META, meta.version],
  ];

  return replacements.reduce(
    (document, [name, content]) => replaceMeta(document, name, content),
    html,
  );
};
