import { createHash } from 'node:crypto';
import type { HcAudience, HcLocale } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * The help center's Redis render cache (M5-03, ARCHITECTURE §11, DOMAIN-RULES
 * §5): a rendered page per brand, host, path, locale and audience.
 *
 * **Only the public audience is ever stored.** A page rendered for staff, a
 * preview, the internal-only wall and a search are rendered on every request;
 * `HelpCenterSite` never calls {@link PageCache.store} for them. The audience is
 * in the key all the same, so a mistake there could only ever miss.
 *
 * **Invalidation is a generation per brand.** Every key carries the brand's
 * current generation; the `help_center.*` events bump it (`cache-events.ts`),
 * after which every key of the old generation is unreachable and expires on
 * its own. One `INCR` drops a whole help center, whatever its hosts, paths
 * and languages, with no key scan.
 *
 * The html is stored with a placeholder where the CSP nonce goes, so a cached
 * page still gets a fresh nonce per response and the ETag, taken over the
 * stored text, stays the same between them.
 */

export interface CachedPage {
  readonly status: number;
  readonly html: string;
  readonly etag: string;
  readonly noindex: boolean;
  /** The page loads the widget, which its CSP has to allow. */
  readonly widget: boolean;
  /** An article page: what a cache hit still counts a view of. */
  readonly view: { readonly articleId: string; readonly locale: HcLocale } | null;
}

export interface PageCacheKey {
  readonly brandId: string;
  readonly host: string;
  readonly path: string;
  readonly locale: HcLocale | null;
  readonly audience: HcAudience;
}

export interface CacheLookup {
  readonly hit: CachedPage | null;
  /**
   * The brand's generation when it was looked up. A miss is stored under this
   * one, not the current one: a page rendered from data an invalidation has
   * since replaced then lands where nobody reads it.
   */
  readonly generation: string;
}

export interface PageCache {
  lookup(key: PageCacheKey): Promise<CacheLookup>;
  store(key: PageCacheKey, generation: string, page: CachedPage): Promise<void>;
  /** Drops every page of the brand. */
  invalidate(brandId: string): Promise<void>;
}

/** Long, because invalidation is by event; the TTL only bounds what "Popular" lags behind. */
export const PAGE_TTL_SECONDS = 600;

export const generationKey = (brandId: string): string => `hc:page:gen:${brandId}`;

/**
 * The key of one page. The host and path are hashed: they arrive from the
 * request, and a key built from them verbatim could be made arbitrarily long.
 */
export const pageKey = (key: PageCacheKey, generation: string): string => {
  const where = createHash('sha256').update(`${key.host}\n${key.path}`).digest('hex').slice(0, 32);
  return `hc:page:${key.brandId}:${generation}:${key.audience}:${key.locale ?? '-'}:${where}`;
};

/** A strong ETag over the stored html (nonce placeholder included). */
export const etagOf = (html: string): string =>
  `"${createHash('sha256').update(html).digest('base64url').slice(0, 27)}"`;

const cachedPageSchema = z.object({
  status: z.int(),
  html: z.string(),
  etag: z.string(),
  noindex: z.boolean(),
  widget: z.boolean(),
  view: z.object({ articleId: z.uuid(), locale: z.enum(['en', 'ar']) }).nullable(),
});

const parseStored = (stored: string): CachedPage | null => {
  try {
    const parsed = cachedPageSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export class RedisPageCache implements PageCache {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async lookup(key: PageCacheKey): Promise<CacheLookup> {
    const generation = (await this.#redis.get(generationKey(key.brandId))) ?? '0';
    const stored = await this.#redis.get(pageKey(key, generation));
    return { hit: stored === null ? null : parseStored(stored), generation };
  }

  async store(key: PageCacheKey, generation: string, page: CachedPage): Promise<void> {
    if (key.audience !== 'public') {
      return;
    }
    await this.#redis.set(pageKey(key, generation), JSON.stringify(page), 'EX', PAGE_TTL_SECONDS);
  }

  async invalidate(brandId: string): Promise<void> {
    await this.#redis.incr(generationKey(brandId));
  }
}

/** For a suite, or a process with no Redis: never hits. */
export class NoPageCache implements PageCache {
  lookup(_key: PageCacheKey): Promise<CacheLookup> {
    return Promise.resolve({ hit: null, generation: '0' });
  }

  store(_key: PageCacheKey, _generation: string, _page: CachedPage): Promise<void> {
    return Promise.resolve();
  }

  invalidate(_brandId: string): Promise<void> {
    return Promise.resolve();
  }
}
