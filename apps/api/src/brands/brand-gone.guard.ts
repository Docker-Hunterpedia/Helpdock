import {
  type CanActivate,
  type ExecutionContext,
  GoneException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { routeDeclarationOf } from '../auth/route-declaration.js';
import { currentRequestContext } from '../context/request-context.js';
import { HC_FALLBACK_PREFIX } from '../help-center/site/paths.js';
import { BrandAvailability } from './brand-availability.js';

interface PublicRequest {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly url?: string;
}

const FALLBACK_BRAND = new RegExp(
  `^${HC_FALLBACK_PREFIX}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)`,
  'i',
);

/**
 * The brand a public request is for: the `:brandId` of the widget, the web
 * form and the help center's media, else the brand the `Host` header named (a
 * help center or web form on the brand's own domain), else the brand in the
 * help center's fallback path `/hc/<brand id>/…`.
 */
export const publicBrandOf = (
  request: PublicRequest,
  hostBrandId: string | null,
): string | null => {
  const fromParams = request.params?.brandId;
  if (typeof fromParams === 'string') {
    return fromParams;
  }
  if (hostBrandId !== null) {
    return hostBrandId;
  }

  return FALLBACK_BRAND.exec(request.url ?? '')?.[1] ?? null;
};

/**
 * M8-07: every `@Public()` route of a brand that is being deleted, or has
 * been, answers 410 Gone (DOMAIN-RULES §11). One guard rather than a check in
 * each surface, so a public route added later is covered without anybody
 * remembering it. Staff routes are untouched: the brand's people can still
 * sign in and look during the grace period, and an install admin can restore
 * it.
 */
@Injectable()
export class BrandGoneGuard implements CanActivate {
  readonly #reflector: Reflector;
  readonly #availability: BrandAvailability;

  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(BrandAvailability) availability: BrandAvailability,
  ) {
    this.#reflector = reflector;
    this.#availability = availability;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    if (routeDeclarationOf(this.#reflector, context)?.kind !== 'public') {
      return true;
    }
    const brandId = publicBrandOf(
      context.switchToHttp().getRequest<PublicRequest>(),
      currentRequestContext()?.hostBrandId ?? null,
    );
    if (brandId !== null && (await this.#availability.isGone(brandId))) {
      throw new GoneException('This brand is no longer available');
    }

    return true;
  }
}
