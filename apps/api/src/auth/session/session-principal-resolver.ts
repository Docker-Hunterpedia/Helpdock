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

export interface ResolvedSession {
  readonly principal: Principal;
  /** `sid`: this access token's own id, and what revocation is recorded against. */
  readonly sessionId: string;
  /** `fam`: the refresh family, which is to say the browser. */
  readonly familyId: string;
  /** `exp`, in epoch seconds. A socket outlives a request and has to honour it. */
  readonly expiresAt: number;
}

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

    return (await this.resolveSession(token))?.principal ?? null;
  }

  /**
   * The same answer plus the session and family the token came from.
   *
   * The socket gateway (M0-13) needs them: a handshake is authenticated exactly
   * as a request is, but the socket then outlives the token, so it has to
   * remember which session it was opened on in order to re-ask whether that
   * session is still alive (DOMAIN-RULES §1.4).
   */
  async resolveSession(token: string): Promise<ResolvedSession | null> {
    const claims = await verifyAccessToken(token, this.#keys);
    if (claims === null) {
      return null;
    }

    if (await this.#isRevoked(claims.sid)) {
      return null;
    }

    return {
      principal: {
        type: 'staff',
        id: claims.sub,
        brands: claims.brands,
        installAdmin: claims.installAdmin,
      },
      sessionId: claims.sid,
      familyId: claims.fam,
      expiresAt: claims.exp,
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
