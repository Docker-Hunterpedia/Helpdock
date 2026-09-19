import type { InstallState } from '@helpdock/schemas';
import { installStateSchema } from '@helpdock/schemas';

export interface PublicInstallInfo {
  /** Help center host of the install's first brand, shown on the sign-in card. */
  readonly primaryDomain: string;
  /** How many brands this install serves. 1 drops the "and n others" clause. */
  readonly brandCount: number;
  /**
   * Whether anybody has set this install up. `fresh` sends every route to the
   * wizard; `configured` means there is no wizard to reach (M0-08).
   */
  readonly installState: InstallState;
  /** What the wizard's caption prints, because nobody is signed in to ask. */
  readonly version: string;
}

const DOMAIN_META = 'helpdock:primary-domain';
const BRAND_COUNT_META = 'helpdock:brand-count';
const INSTALL_STATE_META = 'helpdock:install-state';
const VERSION_META = 'helpdock:version';

const metaContent = (doc: Document, name: string): string | undefined =>
  doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || undefined;

/**
 * The only thing the app knows before anyone has signed in, and the only thing
 * it is allowed to know: no endpoint may enumerate brands to an anonymous
 * visitor. The api serves `index.html` (ARCHITECTURE §3) and rewrites these
 * meta tags per install; the checked-in values are the dev fixture.
 *
 * Anything missing or unreadable falls back to the safe answer. For the install
 * state that is `configured`: a build served from somewhere else, or a tag a
 * proxy stripped, must land on sign-in rather than offer to create an owner.
 */
export function readPublicInstallInfo(doc: Document = document): PublicInstallInfo {
  const parsed = Number.parseInt(metaContent(doc, BRAND_COUNT_META) ?? '', 10);
  const state = installStateSchema.safeParse(metaContent(doc, INSTALL_STATE_META));

  return {
    primaryDomain: metaContent(doc, DOMAIN_META) ?? globalThis.location?.hostname ?? '',
    brandCount: Number.isInteger(parsed) && parsed > 0 ? parsed : 1,
    installState: state.success ? state.data : 'configured',
    version: metaContent(doc, VERSION_META) ?? '',
  };
}
