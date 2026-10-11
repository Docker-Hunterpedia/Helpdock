import type { Db } from '@helpdock/db';
import { API_KEY_DISPLAY_LENGTH } from '@helpdock/schemas';
import { GoneException, HttpException, HttpStatus } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import type { PrincipalRequest, PrincipalResolver } from '../auth/principal-resolver.js';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { bearerTokenOf } from '../auth/session/access-token.js';
import type { BrandAvailability } from '../brands/brand-availability.js';
import type { Logger } from '../logging/logger.js';
import { hashApiKey, isApiKey } from './api-key-credential.js';
import { type ApiKeysRepository, type EndedApiKey, isEnded } from './api-keys.repository.js';
import type { RefusedApiKeys } from './refused-api-key.js';

/**
 * Step 2 of ARCHITECTURE §6 for an integration: `Authorization: Bearer
 * hd_live_…` becomes the `apikey` principal of DOMAIN-RULES §1.1, bound to the
 * key's one brand and carrying its scopes. Any other bearer goes to the
 * resolver this one wraps, so the session path is untouched.
 *
 * A key over its per-minute budget is answered 429 here, before any route
 * runs: the throttle is the key's, whatever it is asking for.
 *
 * A key that is refused (unknown, revoked or past its expiry) is answered 401
 * and recorded (ASVS 7.2.1): a warning with the key's prefix and the caller's
 * address, never the key, and for a key Helpdock issued and ended, an
 * `api_key.refused` audit row in its brand, at most once a minute per key.
 *
 * A live key of a brand in its deletion grace is answered 410, as the brand's
 * public surfaces are (M8-07): `/api/v1` is not `@Public()`, so
 * `BrandGoneGuard` never sees it. The refusal above comes first, so a key that
 * is already ended is still 401 and audited, whatever its brand's state, and
 * the budget comes second, so a gone brand's key is throttled like any other
 * rather than reading the brand table without limit.
 */

export const apiKeyRateRule = (perMinute: number): RateLimitRule => ({
  bucket: 'api-key',
  limit: perMinute,
  windowSeconds: 60,
});

/** One audit row a minute per refused key: a script retrying a revoked key must not fill the log. */
export const apiKeyRefusedRule: RateLimitRule = {
  bucket: 'api-key-refused',
  limit: 1,
  windowSeconds: 60,
};

export interface ApiKeyPrincipalResolverOptions {
  readonly db: Db;
  readonly keys: Pick<ApiKeysRepository, 'findByHash'>;
  readonly limiter: Pick<RateLimiter, 'consume'>;
  readonly refused: Pick<RefusedApiKeys, 'audit'>;
  readonly log: Pick<Logger, 'warn' | 'error'>;
  /** Everything that is not an API key: the session resolver, in production. */
  readonly fallback: PrincipalResolver;
  /** The cache `BrandGoneGuard` reads, so one deletion is seen by both within the same seconds. */
  readonly availability: Pick<BrandAvailability, 'isGone'>;
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

    const key = await this.#options.keys.findByHash(this.#options.db, hashApiKey(token));
    if (key === undefined || isEnded(key)) {
      await this.#recordRefusal(token, request.ip, key);
      return null;
    }

    if (!(await this.#options.limiter.consume(apiKeyRateRule(key.rateLimitPerMinute), key.id))) {
      throw new HttpException('This API key is over its rate limit', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (await this.#options.availability.isGone(key.brandId)) {
      throw new GoneException('This brand is no longer available');
    }

    return { type: 'apikey', id: key.id, brandId: key.brandId, scopes: [...key.scopes] };
  }

  /**
   * Best effort: the answer is 401 whether or not the record could be written,
   * so a failure here is logged and does not turn a refusal into a 500.
   */
  async #recordRefusal(
    token: string,
    ip: string | undefined,
    key: EndedApiKey | undefined,
  ): Promise<void> {
    const { refused, limiter, log } = this.#options;
    const prefix = token.slice(0, API_KEY_DISPLAY_LENGTH);
    try {
      log.warn(
        {
          keyPrefix: prefix,
          ip,
          reason: key?.state ?? 'unknown',
          ...(key === undefined ? {} : { keyId: key.id, brandId: key.brandId }),
        },
        'API key refused',
      );
      if (key !== undefined && (await limiter.consume(apiKeyRefusedRule, key.id))) {
        await refused.audit(key, { prefix, ip });
      }
    } catch (error) {
      log.error({ err: error, keyPrefix: prefix }, 'Could not record a refused API key');
    }
  }
}
