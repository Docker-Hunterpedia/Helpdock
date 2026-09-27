/**
 * Which brand a hostname belongs to. Help-center pages arrive on a brand's own
 * domain and carry no session, so the `Host` header is the only thing that
 * names the tenant (ARCHITECTURE §6, §11).
 *
 * The implementation is M5-07's `domains/brand-host.ts`, which reads verified
 * `helpcenter` rows of `brand_domains` behind a short in-process cache.
 * {@link NoopBrandResolver} resolves every host to nothing, which is the safe
 * answer for a suite that does not care: a request with no brand and no
 * principal reaches only `@Public()` routes.
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
