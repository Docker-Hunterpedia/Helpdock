import type { IncomingHttpHeaders } from 'node:http';
import type { Env, EnvSource } from '@helpdock/config';
import { principalSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import type { Principal } from './principal.js';

/**
 * Step 2 of ARCHITECTURE §6. The real resolver is
 * {@link ./session/session-principal-resolver.js SessionPrincipalResolver},
 * which reads the access token out of the `Authorization` header; the widget's
 * `visitor_secret` (M4) and `hd_live_…` api keys (M8) arrive behind the same
 * interface. Nothing else in the app changes when one is swapped for another:
 * the guard, the tenant interceptor and every controller only ever see a
 * `Principal`.
 */

export interface PrincipalRequest {
  readonly headers: IncomingHttpHeaders;
}

export interface PrincipalResolver {
  resolve(request: PrincipalRequest): Promise<Principal | null>;
}

/**
 * Recognises no credential at all. It is what a misconfiguration falls back to,
 * and what the unit tests use when the question is "is this route guarded?".
 */
export class DenyAllPrincipalResolver implements PrincipalResolver {
  resolve(): Promise<Principal | null> {
    return Promise.resolve(null);
  }
}

export const DEV_PRINCIPAL_HEADER = 'x-hd-dev-principal';
/** Not a bootstrap key: it is opt-in tooling, and `loadEnv` must not require it. */
export const DEV_PRINCIPAL_ENV_KEY = 'HD_DEV_PRINCIPAL_HEADER';

/**
 * Reads a whole principal out of a request header, so tests and a local `pnpm
 * dev` can exercise the tenancy plumbing before M0-05 exists. It trusts the
 * caller completely, which is why it is enabled only outside production and
 * only when the operator asked for it by name.
 */
export class HeaderPrincipalResolver implements PrincipalResolver {
  resolve(request: PrincipalRequest): Promise<Principal | null> {
    const header = request.headers[DEV_PRINCIPAL_HEADER];
    if (typeof header !== 'string' || header.trim() === '') {
      return Promise.resolve(null);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(header);
    } catch {
      return Promise.resolve(null);
    }

    const parsed = principalSchema.safeParse(decoded);
    return Promise.resolve(parsed.success ? parsed.data : null);
  }
}

const enabledFlag = z.stringbool().catch(false);

/**
 * Whether the dev header resolver may be used: never in production, and only
 * when `HD_DEV_PRINCIPAL_HEADER` is on. Both conditions, because either one on
 * its own is a configuration mistake somebody will make.
 */
export const devPrincipalHeaderEnabled = (
  env: Pick<Env, 'NODE_ENV'>,
  source: EnvSource = process.env,
): boolean => env.NODE_ENV !== 'production' && enabledFlag.parse(source[DEV_PRINCIPAL_ENV_KEY]);

export interface CreatePrincipalResolverOptions {
  readonly env: Pick<Env, 'NODE_ENV'>;
  readonly logger: Logger;
  /** The session resolver, which is what a real deploy uses. */
  readonly session: PrincipalResolver;
  readonly source?: EnvSource;
}

/**
 * The session resolver, unless the operator deliberately asked for the
 * development header instead. The header is not an addition to the session: a
 * process that trusts it trusts it for every request, so the two are never both
 * in play and the choice is visible in one place.
 */
export const createPrincipalResolver = ({
  env,
  logger,
  session,
  source = process.env,
}: CreatePrincipalResolverOptions): PrincipalResolver => {
  if (devPrincipalHeaderEnabled(env, source)) {
    logger.warn(
      { header: DEV_PRINCIPAL_HEADER },
      `${DEV_PRINCIPAL_ENV_KEY} is on: any caller may name itself through the ${DEV_PRINCIPAL_HEADER} header. Never set this outside development.`,
    );
    return new HeaderPrincipalResolver();
  }

  if (enabledFlag.parse(source[DEV_PRINCIPAL_ENV_KEY])) {
    logger.error(
      `${DEV_PRINCIPAL_ENV_KEY} is set but NODE_ENV is production; the development principal header stays off.`,
    );
  }

  return session;
};
