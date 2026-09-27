import { brandDomains, brands, type Db, withTenant } from '@helpdock/db';
import { domainCheckQuerySchema } from '@helpdock/schemas';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { BrandResolver, ResolvedBrandDomain } from '../context/brand-resolver.js';

/**
 * Which brand a help center hostname belongs to (ARCHITECTURE §6, §11), for
 * the two readers that arrive with nothing but a hostname: Caddy's on-demand
 * TLS check, and a help center request whose `Host` names the brand.
 *
 * Only a **verified** `helpcenter` row answers. An unverified one is a claim
 * nobody has proved, and a `widget_origin` row is an allow-list entry for the
 * widget's embedding pages, not a host this install serves.
 */

export interface HelpcenterHost {
  readonly brandId: string;
  readonly domainId: string;
  /** The host that was asked about, normalised. */
  readonly domain: string;
  /** Cloudflare terminates TLS for it, so Caddy must not issue a certificate. */
  readonly cloudflareProxied: boolean;
  /**
   * The brand's primary help center host, for canonical links and a redirect
   * from a secondary host: the verified domain marked primary, or this one.
   */
  readonly primaryDomain: string;
}

/**
 * `help.acme.com:443`, `HELP.ACME.COM.`, `[::1]:3000` → the bare, lower-case
 * name, or `undefined` for anything that cannot be a stored help center host.
 * Hosts are compared exactly as `brand_domains.domain` stores them.
 */
export const normaliseHost = (host: string | undefined): string | undefined => {
  if (host === undefined || host.startsWith('[')) {
    return undefined;
  }
  const bare = host.replace(/:\d+$/, '');
  const parsed = domainCheckQuerySchema.safeParse({ domain: bare });
  // An IPv4 literal passes the label pattern; no stored host ends in digits.
  return parsed.success && !/\.\d+$/.test(parsed.data.domain) ? parsed.data.domain : undefined;
};

/**
 * One uncached lookup. The brand is the unknown, so this is an install-scope
 * read of the kind ARCHITECTURE §6 allows: every brand id is put in the context
 * explicitly, as `system` under `principalId`, and the statement reads
 * `brand_domains` and nothing else.
 */
export const findHelpcenterHost = async (
  db: Db,
  domain: string,
  principalId: string,
): Promise<HelpcenterHost | undefined> => {
  const brandIds = (await db.select({ id: brands.id }).from(brands).orderBy(asc(brands.id))).map(
    (row) => row.id,
  );
  if (brandIds.length === 0) {
    return undefined;
  }

  return withTenant(
    db,
    { brandIds, departmentIds: 'all', principalType: 'system', principalId },
    async (tx) => {
      const [match] = await tx
        .select({
          id: brandDomains.id,
          brandId: brandDomains.brandId,
          cloudflareProxied: brandDomains.cloudflareProxied,
        })
        .from(brandDomains)
        .where(
          and(
            eq(brandDomains.domain, domain),
            eq(brandDomains.kind, 'helpcenter'),
            isNotNull(brandDomains.verifiedAt),
          ),
        )
        .limit(1);
      if (match === undefined) {
        return undefined;
      }

      const [primary] = await tx
        .select({ domain: brandDomains.domain })
        .from(brandDomains)
        .where(
          and(
            eq(brandDomains.brandId, match.brandId),
            eq(brandDomains.kind, 'helpcenter'),
            isNotNull(brandDomains.verifiedAt),
          ),
        )
        .orderBy(desc(brandDomains.isPrimary), asc(brandDomains.createdAt))
        .limit(1);

      return {
        brandId: match.brandId,
        domainId: match.id,
        domain,
        cloudflareProxied: match.cloudflareProxied,
        primaryDomain: primary?.domain ?? domain,
      };
    },
  );
};

export interface BrandHostResolverOptions {
  readonly db: Db;
  /** Replaces {@link findHelpcenterHost}; the unit tests of the cache use it. */
  readonly lookup?: (domain: string) => Promise<HelpcenterHost | undefined>;
  /** The install's own hosts. They never belong to a brand, so they are never looked up. */
  readonly ownHosts?: readonly string[];
  /** How long an answer, found or not, is reused. Default 30 s. */
  readonly ttlMs?: number;
  /** Hosts remembered at once. Default 1 000; the oldest is forgotten first. */
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export const BRAND_HOST_PRINCIPAL = 'brand-host.resolve';
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * The `Host` → brand map the help center SSR (M5-03) resolves its brand with,
 * and the implementation of the request middleware's {@link BrandResolver}.
 *
 * Every request passes through the middleware, so the answer is cached in
 * process for a short while, misses included: a stranger's hostname costs one
 * query per interval, not one per request. The cost is that adding, verifying
 * or removing a domain reaches routing up to `ttlMs` later. Caddy's
 * certificate check does not use this cache (`routes/domain-check.service.ts`):
 * a domain the worker has just verified must be able to get its certificate on
 * the very next handshake.
 */
export class BrandHostResolver implements BrandResolver {
  readonly #lookup: (domain: string) => Promise<HelpcenterHost | undefined>;
  readonly #ownHosts: ReadonlySet<string>;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #cache = new Map<
    string,
    { readonly value: HelpcenterHost | null; readonly expires: number }
  >();

  constructor(options: BrandHostResolverOptions) {
    this.#lookup =
      options.lookup ?? ((domain) => findHelpcenterHost(options.db, domain, BRAND_HOST_PRINCIPAL));
    this.#ownHosts = new Set(options.ownHosts ?? []);
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  async resolve(host: string | undefined): Promise<ResolvedBrandDomain | null> {
    const found = await this.resolveHelpcenter(host);
    return found === null ? null : { brandId: found.brandId, kind: 'helpcenter' };
  }

  async resolveHelpcenter(host: string | undefined): Promise<HelpcenterHost | null> {
    const domain = normaliseHost(host);
    if (domain === undefined || this.#ownHosts.has(domain)) {
      return null;
    }

    const now = this.#now();
    const cached = this.#cache.get(domain);
    if (cached !== undefined && cached.expires > now) {
      return cached.value;
    }

    const value = (await this.#lookup(domain)) ?? null;
    this.#remember(domain, value, now);
    return value;
  }

  #remember(domain: string, value: HelpcenterHost | null, now: number): void {
    this.#cache.delete(domain);
    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) {
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(domain, { value, expires: now + this.#ttlMs });
  }
}
