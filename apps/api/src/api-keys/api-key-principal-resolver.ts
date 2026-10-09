import type { Db } from '@helpdock/db';
import { API_KEY_DISPLAY_LENGTH } from '@helpdock/schemas';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import type { PrincipalRequest, PrincipalResolver } from '../auth/principal-resolver.js';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { bearerTokenOf } from '../auth/session/access-token.js';
import type { Logger } from '../logging/logger.js';
import { hashApiKey, isApiKey } from './api-key-credential.js';
import type { ApiKeysRepository } from './api-keys.repository.js';
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
 * A key that is refused (unknown, or revoked) is answered 401 and recorded
 * (ASVS 7.2.1): a warning with the key's prefix and the caller's address, never
 * the key, and for a key Helpdock issued and ended, an `api_key.refused` audit
 * row in its brand, at most once a minute per key.
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
  readonly keys: Pick<ApiKeysRepository, 'findActiveByHash'>;
  readonly limiter: Pick<RateLimiter, 'consume'>;
  readonly refused: Pick<RefusedApiKeys, 'find' | 'audit'>;
  readonly log: Pick<Logger, 'warn' | 'error'>;
  /** Everything that is not an API key: the session resolver, in production. */
  readonly fallback: PrincipalResolver;
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
      await this.#recordRefusal(token, request.ip);
      return null;
    }

    if (!(await this.#options.limiter.consume(apiKeyRateRule(key.rateLimitPerMinute), key.id))) {
      throw new HttpException('This API key is over its rate limit', HttpStatus.TOO_MANY_REQUESTS);
    }

    return { type: 'apikey', id: key.id, brandId: key.brandId, scopes: [...key.scopes] };
  }

  /**
   * Best effort: the answer is 401 whether or not the record could be written,
   * so a failure here is logged and does not turn a refusal into a 500.
   */
  async #recordRefusal(token: string, ip: string | undefined): Promise<void> {
    const { refused, limiter, log } = this.#options;
    const prefix = token.slice(0, API_KEY_DISPLAY_LENGTH);
    try {
      const key = await refused.find(hashApiKey(token));
      log.warn(
        {
          keyPrefix: prefix,
          ip,
          reason: key?.reason ?? 'unknown',
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
