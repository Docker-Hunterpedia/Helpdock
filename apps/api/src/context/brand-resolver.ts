/**
 * Which brand a hostname belongs to. Help-center pages and widget requests
 * arrive on a brand's own domain and carry no session, so the `Host` header is
 * the only thing that names the tenant (ARCHITECTURE §6, §11).
 *
 * M5 adds the `brand_domains` table and the implementation that reads it,
 * cached in Redis. Until then every host resolves to nothing, which is the safe
 * answer: a request with no brand and no principal reaches only `@Public()`
 * routes.
 */

export type BrandDomainKind = 'helpcenter' | 'widget_origin';

export interface ResolvedBrandDomain {
  readonly brandId: string;
  readonly kind: BrandDomainKind;
}

export interface BrandResolver {
  /** `host` is the raw header, port included and unvalidated. */
  resolve(host: string | undefined): Promise<ResolvedBrandDomain | null>;
}

export class NoopBrandResolver implements BrandResolver {
  resolve(): Promise<ResolvedBrandDomain | null> {
    return Promise.resolve(null);
  }
}
