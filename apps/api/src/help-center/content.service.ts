import { type Db, type DbTransaction, systemContext, withTenant } from '@helpdock/db';
import type {
  HcArticleLookup,
  HcAudience,
  HcChangedVersion,
  HcLocale,
  HcSitemapEntry,
  HcTreeCategory,
} from '@helpdock/schemas';
import {
  CHANGED_SINCE_LIMIT,
  defaultLocaleOf,
  readArticle,
  readChangedSince,
  readSitemap,
  readTree,
} from './content-reader.js';

/**
 * `HelpCenterContentService`: the read service the help center pages (M5-03),
 * the sitemap (M5-04), search (M5-05) and the widget (M5-10) are built on.
 *
 * Every method takes the `audience` it reads for (AGENTS.md, "Retrieval
 * always takes an `audience`") and answers only what that audience may read,
 * filtered in SQL before anything else (`visibility.ts`). It opens its own
 * transaction for the brand, as the system principal, because a visitor has
 * no principal of their own to scope one with; the audience, not the tenant
 * context, is what narrows the rows.
 *
 * Whether a request is *allowed* the internal audience — a signed-in staff
 * member of this brand — is the caller's decision, made before it asks.
 */

export interface ArticleQuery {
  readonly brandId: string;
  readonly audience: HcAudience;
  readonly locale: HcLocale;
}

/** Why the transaction was opened, as the audit trail's principal id. */
const READ_PRINCIPAL = 'help_center.read';

export class HelpCenterContentService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Categories → sections → readable articles, in staff's order, empty ones left out. */
  tree(query: ArticleQuery): Promise<HcTreeCategory[]> {
    return this.#read(query.brandId, async (tx) =>
      readTree(tx, { ...query, defaultLocale: await defaultLocaleOf(tx, query.brandId) }),
    );
  }

  /** One article by slug: found (possibly in the default language), gone (410) or not found (404). */
  articleBySlug(query: ArticleQuery & { readonly slug: string }): Promise<HcArticleLookup> {
    return this.#read(query.brandId, async (tx) =>
      readArticle(
        tx,
        { ...query, defaultLocale: await defaultLocaleOf(tx, query.brandId) },
        query.slug,
      ),
    );
  }

  /** The public sitemap's entries. Always the public audience; empty when internal-only. */
  sitemap(brandId: string): Promise<HcSitemapEntry[]> {
    return this.#read(brandId, (tx) => readSitemap(tx));
  }

  /** Versions whose published state moved after `since`, oldest first, at most 500 per call. */
  changedSince(query: {
    readonly brandId: string;
    readonly audience: HcAudience;
    readonly since: Date;
    readonly limit?: number;
  }): Promise<HcChangedVersion[]> {
    return this.#read(query.brandId, (tx) =>
      readChangedSince(tx, query.audience, query.since, query.limit ?? CHANGED_SINCE_LIMIT),
    );
  }

  #read<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.#db, systemContext(brandId, READ_PRINCIPAL), fn);
  }
}
