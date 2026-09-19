import { INSTALL_SCOPE_BRAND_ID, isUuid } from '@helpdock/db';
import { brandsOf, type Principal } from './principal.js';

/**
 * Which brand a route acts on. Everything downstream depends on getting this
 * right: it is the brand the permission is checked in, and the only brand the
 * request's transaction may name.
 *
 * The order is most explicit first. A principal with several brands and no
 * `:brandId` is an ambiguous request, not a licence to open all of them.
 */

export const BRAND_ID_PARAM = 'brandId';

export type TargetBrand =
  | { readonly ok: true; readonly brandId: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'ambiguous' };

export interface TargetBrandInput {
  readonly principal: Principal;
  /** Raw path parameters, as the router parsed them. */
  readonly params: Readonly<Record<string, unknown>> | undefined;
  /** The brand the `Host` header named, for help-center and widget routes. */
  readonly hostBrandId: string | null;
}

/**
 * The install sentinel is a brand id in shape only: it is the scope that reads
 * and writes install-wide `settings` and `audit_log` rows. A brand-scoped route
 * may never name it, whatever a path parameter or a principal says, or the
 * `@Requires('install:admin')` gate would have a way around it.
 */
export const isNamedBrand = (brandId: string): boolean =>
  isUuid(brandId) && brandId !== INSTALL_SCOPE_BRAND_ID;

export const resolveTargetBrand = ({
  principal,
  params,
  hostBrandId,
}: TargetBrandInput): TargetBrand => {
  const fromPath = params?.[BRAND_ID_PARAM];
  if (fromPath !== undefined) {
    return typeof fromPath === 'string' && isNamedBrand(fromPath)
      ? { ok: true, brandId: fromPath }
      : { ok: false, reason: 'invalid' };
  }

  if (hostBrandId !== null) {
    return isNamedBrand(hostBrandId)
      ? { ok: true, brandId: hostBrandId }
      : { ok: false, reason: 'invalid' };
  }

  const brands = brandsOf(principal).filter(isNamedBrand);
  const only = brands.length === 1 ? brands[0] : undefined;
  return only === undefined ? { ok: false, reason: 'ambiguous' } : { ok: true, brandId: only };
};
