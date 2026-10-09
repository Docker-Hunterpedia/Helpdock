import type { Db } from '@helpdock/db';
import { GoneException, HttpException, HttpStatus } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import type { PrincipalRequest, PrincipalResolver } from '../auth/principal-resolver.js';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { bearerTokenOf } from '../auth/session/access-token.js';
import { isBrandGone } from '../brands/brand-availability.js';
import { hashApiKey, isApiKey } from './api-key-credential.js';
import type { ApiKeysRepository } from './api-keys.repository.js';

/**
 * Step 2 of ARCHITECTURE §6 for an integration: `Authorization: Bearer
 * hd_live_…` becomes the `apikey` principal of DOMAIN-RULES §1.1, bound to the
 * key's one brand and carrying its scopes. Any other bearer goes to the
 * resolver this one wraps, so the session path is untouched.
 *
 * A key over its per-minute budget is answered 429 here, before any route
 * runs: the throttle is the key's, whatever it is asking for. A key of a brand
 * in its deletion grace is answered 410, as the brand's public surfaces are
 * (M8-07): `/api/v1` is not `@Public()`, so `BrandGoneGuard` never sees it.
 */

export const apiKeyRateRule = (perMinute: number): RateLimitRule => ({
  bucket: 'api-key',
  limit: perMinute,
  windowSeconds: 60,
});

export interface ApiKeyPrincipalResolverOptions {
  readonly db: Db;
  readonly keys: Pick<ApiKeysRepository, 'findActiveByHash'>;
  readonly limiter: Pick<RateLimiter, 'consume'>;
  /** Everything that is not an API key: the session resolver, in production. */
  readonly fallback: PrincipalResolver;
  /** Whether the brand is `deleting` or `deleted`; a suite passes a stand-in for the read. */
  readonly brandIsGone?: (brandId: string) => Promise<boolean>;
}

export class ApiKeyPrincipalResolver implements PrincipalResolver {
  readonly #options: ApiKeyPrincipalResolverOptions;

  constructor(options: ApiKeyPrincipalResolverOptions) {
    this.#options = options;
  }

  async resolve(request: PrincipalRequest): Promise<Principal | null> {
    const token = bearerTokenOf(request.headers.authorization);
    if (token === null || !isApiKey(token)) {
      return this.#options.fallback.resolve(request);
    }

    const key = await this.#options.keys.findActiveByHash(this.#options.db, hashApiKey(token));
    if (key === undefined) {
      return null;
    }

    const gone = this.#options.brandIsGone ?? ((brandId) => isBrandGone(this.#options.db, brandId));
    if (await gone(key.brandId)) {
      throw new GoneException('This brand is no longer available');
    }

    if (!(await this.#options.limiter.consume(apiKeyRateRule(key.rateLimitPerMinute), key.id))) {
      throw new HttpException('This API key is over its rate limit', HttpStatus.TOO_MANY_REQUESTS);
    }

    return { type: 'apikey', id: key.id, brandId: key.brandId, scopes: [...key.scopes] };
  }
}
