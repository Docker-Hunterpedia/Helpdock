import { brandDomains, type DbTransaction, hcArticleVersions } from '@helpdock/db';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { readableBy } from '../visibility.js';
import { HC_FALLBACK_PREFIX } from './paths.js';

/**
 * Where a brand's help center answers: its primary verified domain, or the
 * install's fallback path `/hc/<brandId>/` until it has one (ADR 0013). The
 * domain takes the scheme of `APP_URL`, so a plain-http development install
 * links to plain http.
 */
export const helpCenterSiteUrl = (
  appUrl: string,
  site: { readonly brandId: string; readonly primaryDomain: string | null },
): string => {
  const base = appUrl.replace(/\/$/, '');
  if (site.primaryDomain !== null) {
    const scheme = base.startsWith('https:') ? 'https' : 'http';
    return `${scheme}://${site.primaryDomain}/`;
  }
  return `${base}${HC_FALLBACK_PREFIX}/${site.brandId}/`;
};

/** The brand's primary verified help center host, else its oldest verified one, else null. */
export const readPrimaryDomain = async (
  tx: DbTransaction,
  brandId: string,
): Promise<string | null> => {
  const [domain] = await tx
    .select({ domain: brandDomains.domain })
    .from(brandDomains)
    .where(
      and(
        eq(brandDomains.brandId, brandId),
        eq(brandDomains.kind, 'helpcenter'),
        isNotNull(brandDomains.verifiedAt),
      ),
    )
    .orderBy(desc(brandDomains.isPrimary), asc(brandDomains.createdAt))
    .limit(1);
  return domain?.domain ?? null;
};

/**
 * The help center's address for somebody outside the brand — the CSAT page's
 * "Browse the help center" (`CsatEN`) — or null while it has nothing for them
 * to read: no public article published, or the help center internal-only
 * (`readableBy('public')` is false for every row then). Read in the brand's
 * transaction, so row-level security keeps it to the one brand.
 */
export const publicHelpCenterUrl = async (
  tx: DbTransaction,
  brandId: string,
  appUrl: string,
): Promise<string | null> => {
  const [readable] = await tx
    .select({ id: hcArticleVersions.id })
    .from(hcArticleVersions)
    .where(and(eq(hcArticleVersions.brandId, brandId), readableBy('public')))
    .limit(1);
  if (readable === undefined) {
    return null;
  }
  return helpCenterSiteUrl(appUrl, {
    brandId,
    primaryDomain: await readPrimaryDomain(tx, brandId),
  });
};
