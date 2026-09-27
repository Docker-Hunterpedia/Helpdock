import type { Env } from '@helpdock/config';
import { type Db, type DbTransaction, systemContext, withTenant } from '@helpdock/db';
import type { HelpCenterContentService } from '../content.service.js';
import type { SiteContent } from './site.js';
import { readSiteConfig } from './site-config.js';
import { readGone, readPreview } from './site-reads.js';

/**
 * `SiteContent` over the database: the content service for the published
 * help center, and the brand's configuration and the two page-only reads in
 * a transaction of their own, as the content service opens one per call (a
 * visitor has no principal to scope a transaction with).
 */

const READ_PRINCIPAL = 'help_center.site';

export class DbSiteContent implements SiteContent {
  readonly #db: Db;
  readonly #content: HelpCenterContentService;

  constructor(db: Db, content: HelpCenterContentService) {
    this.#db = db;
    this.#content = content;
  }

  config: SiteContent['config'] = (brandId) =>
    this.#read(brandId, (tx) => readSiteConfig(tx, brandId));

  tree: SiteContent['tree'] = (query) => this.#content.tree(query);

  article: SiteContent['article'] = (query) => this.#content.articleBySlug(query);

  sitemap: SiteContent['sitemap'] = (brandId) => this.#content.sitemap(brandId);

  gone: SiteContent['gone'] = (brandId, scope, slug) =>
    this.#read(brandId, (tx) => readGone(tx, scope, slug));

  preview: SiteContent['preview'] = (brandId, scope, slug) =>
    this.#read(brandId, (tx) => readPreview(tx, scope, slug));

  #read<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.#db, systemContext(brandId, READ_PRINCIPAL), fn);
  }
}

/**
 * Where an image the media redirect points at is served from, for the pages'
 * `img-src`: the bucket's origin, as a path under the endpoint or as a
 * subdomain of it (`S3_FORCE_PATH_STYLE`).
 */
export const imageSourcesOf = (
  env: Pick<Env, 'S3_ENDPOINT' | 'S3_BUCKET' | 'S3_FORCE_PATH_STYLE'>,
): string[] => {
  const endpoint = new URL(env.S3_ENDPOINT);
  return env.S3_FORCE_PATH_STYLE
    ? [endpoint.origin]
    : [`${endpoint.protocol}//${env.S3_BUCKET}.${endpoint.host}`];
};
