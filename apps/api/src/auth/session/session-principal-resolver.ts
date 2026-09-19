import type { Principal } from '@helpdock/schemas';
import type { Logger } from '../../logging/logger.js';
import type { PrincipalRequest, PrincipalResolver } from '../principal-resolver.js';
import { bearerTokenOf, verifyAccessToken } from './access-token.js';
import type { RefreshStore } from './refresh-store.js';
import type { SigningKeys } from './signing-keys.js';

/**
 * Step 2 of ARCHITECTURE §6, for a signed-in staff member: the bearer token in
 * the `Authorization` header becomes a `Principal`, or the request is 401.
 *
 * It reads nothing from the database. The claims already carry the brands, the
 * roles and the department scope, which is the point of putting them there: a
 * request costs one signature verification and one Redis `EXISTS`, and neither
 * grows with the number of brands a person works in.
 *
 * The one thing claims cannot express is "this session ended a minute ago", so
 * that is the Redis lookup. A revoked session id is marked for as long as an
 * access token can live, which is what closes the gap DOMAIN-RULES §1.6 caps at
 * ten minutes.
 *
 * Visitors (M4) and API keys (M8) arrive with different credentials and get
 * their own resolvers behind the same interface.
 */
export class SessionPrincipalResolver implements PrincipalResolver {
  readonly #keys: SigningKeys;
  readonly #refresh: RefreshStore;
  readonly #logger: Logger;

  constructor({
    keys,
    refresh,
    logger,
  }: {
    readonly keys: SigningKeys;
    readonly refresh: RefreshStore;
    readonly logger: Logger;
  }) {
    this.#keys = keys;
    this.#refresh = refresh;
    this.#logger = logger;
  }

  async resolve(request: PrincipalRequest): Promise<Principal | null> {
    const token = bearerTokenOf(request.headers.authorization);
    if (token === null) {
      return null;
    }

    const claims = await verifyAccessToken(token, this.#keys);
    if (claims === null) {
      return null;
    }

    if (await this.#isRevoked(claims.sid)) {
      return null;
    }

    return {
      type: 'staff',
      id: claims.sub,
      brands: claims.brands,
      installAdmin: claims.installAdmin,
    };
  }

  /**
   * Redis being unreachable must not turn into "everybody is signed in": a
   * revocation that cannot be checked is treated as in force, and the request
   * is refused. The alternative fails open, which is the one thing a
   * revocation check may never do.
   */
  async #isRevoked(sessionId: string): Promise<boolean> {
    try {
      return await this.#refresh.isSessionRevoked(sessionId);
    } catch (error) {
      this.#logger.error(
        { err: error },
        'Could not check the session revocation marker; refusing the request',
      );
      return true;
    }
  }
}
