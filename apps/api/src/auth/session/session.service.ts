import { uuidv7 } from '@helpdock/db';
import type { AuthSessionResponse, Session } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import type { Logger } from '../../logging/logger.js';
import { brandPreferenceKey, PRINCIPAL_REVOKED_CHANNEL } from '../redis-keys.js';
import { buildSession, toClaimBrands } from '../session-view.js';
import type { Queryable, StaffRepository } from '../staff.repository.js';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken } from './access-token.js';
import type { RefreshStore } from './refresh-store.js';
import type { SigningKeys } from './signing-keys.js';

/**
 * Sessions, from issue to revoke. Everything that mints an access token goes
 * through here — password, second factor, magic link, OAuth, refresh — so
 * there is one place where claims are built and one place where a revocation
 * is announced.
 */

export interface IssuedSession extends AuthSessionResponse {
  /** The value for the refresh cookie. The caller sets it; this service never touches a reply. */
  readonly refreshCookieValue: { readonly fam: string; readonly token: string };
}

export type RefreshOutcome =
  | { readonly status: 'rotated'; readonly issued: IssuedSession }
  /** Reuse of a rotated token. The family is already dead by the time this is returned. */
  | { readonly status: 'reused' }
  | { readonly status: 'rejected' };

export class SessionService {
  readonly #staff: StaffRepository;
  readonly #refresh: RefreshStore;
  readonly #redis: Redis;
  readonly #keys: SigningKeys;
  readonly #logger: Logger;
  readonly #appUrl: string;

  constructor({
    staff,
    refresh,
    redis,
    keys,
    logger,
    appUrl,
  }: {
    readonly staff: StaffRepository;
    readonly refresh: RefreshStore;
    readonly redis: Redis;
    readonly keys: SigningKeys;
    readonly logger: Logger;
    readonly appUrl: string;
  }) {
    this.#staff = staff;
    this.#refresh = refresh;
    this.#redis = redis;
    this.#keys = keys;
    this.#logger = logger;
    this.#appUrl = appUrl;
  }

  /**
   * Opens a new family and mints the first access token for it. `null` when the
   * account holds no brand role: every admin screen is brand-scoped, so there
   * is nothing to sign them in to (see `buildSession`).
   */
  async open({
    userId,
    userAgent,
  }: {
    readonly userId: string;
    readonly userAgent: string | undefined;
  }): Promise<IssuedSession | null> {
    const view = await this.#view(userId);
    if (view === null) {
      return null;
    }

    const { familyId, token } = await this.#refresh.createFamily({ userId, userAgent });
    const accessToken = await this.#mint({ userId, familyId, view });

    this.#logger.info({ userId, familyId }, 'Opened a staff session');

    return {
      ...accessToken,
      session: view.session,
      refreshCookieValue: { fam: familyId, token },
    };
  }

  /** Mints a fresh access token on an existing family. Used by the code exchange. */
  async resume({
    userId,
    familyId,
  }: {
    readonly userId: string;
    readonly familyId: string;
  }): Promise<AuthSessionResponse | null> {
    const view = await this.#view(userId);
    if (view === null) {
      return null;
    }

    const accessToken = await this.#mint({ userId, familyId, view });
    return { ...accessToken, session: view.session };
  }

  /**
   * Rotates the refresh token and re-reads the roles, so a role change reaches
   * the claims within one access-token lifetime without any request having to
   * ask the database (DOMAIN-RULES §12).
   */
  async refresh({
    familyId,
    token,
    userAgent,
  }: {
    readonly familyId: string;
    readonly token: string;
    readonly userAgent: string | undefined;
  }): Promise<RefreshOutcome> {
    const outcome = await this.#refresh.rotate({ familyId, token, userAgent });

    if (outcome.status === 'unknown') {
      return { status: 'rejected' };
    }

    if (outcome.status === 'reused') {
      this.#logger.warn(
        { userId: outcome.userId, familyId },
        'A rotated refresh token was presented again; the session family was revoked',
      );
      await this.#announceRevocation(outcome.userId, 'refresh-token-reuse');
      return { status: 'reused' };
    }

    const view = await this.#view(outcome.userId);
    if (view === null) {
      // The account lost its last brand role while it held a session.
      await this.revokeFamily(familyId, 'no-brand-role');
      return { status: 'rejected' };
    }

    const accessToken = await this.#mint({ userId: outcome.userId, familyId, view });

    return {
      status: 'rotated',
      issued: {
        ...accessToken,
        session: view.session,
        refreshCookieValue: { fam: familyId, token: outcome.token },
      },
    };
  }

  /** One browser. The other families this user holds keep working. */
  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const userId = await this.#refresh.revokeFamily(familyId);
    if (userId !== null) {
      await this.#announceRevocation(userId, reason);
    }
  }

  /** "Log out everywhere", a password reset, a deactivation (DOMAIN-RULES §12). */
  async revokeEverything(userId: string, reason: string): Promise<number> {
    const revoked = await this.#refresh.revokeAllForUser(userId);
    await this.#announceRevocation(userId, reason);

    return revoked;
  }

  /**
   * The session for `GET /api/auth/me`, without minting anything. The request's
   * own transaction is passed in, so the read does not take a second connection
   * while the first one is still held.
   */
  async describe(userId: string, tx?: Queryable): Promise<Session | null> {
    return (await this.#view(userId, tx))?.session ?? null;
  }

  async #mint({
    userId,
    familyId,
    view,
  }: {
    userId: string;
    familyId: string;
    view: SessionView;
  }): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const sessionId = uuidv7();
    const accessToken = await issueAccessToken(
      {
        userId,
        sessionId,
        familyId,
        brands: view.claimBrands,
        installAdmin: view.installAdmin,
      },
      this.#keys,
    );

    // Recorded before the token is handed out, so a revocation that lands a
    // millisecond later still reaches it.
    await this.#refresh.registerSession(familyId, sessionId);

    return { accessToken, expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS };
  }

  async #view(userId: string, tx?: Queryable): Promise<SessionView | null> {
    const user = await this.#staff.findById(userId, tx);
    if (user === undefined || user.deactivatedAt !== null || user.status === 'deactivated') {
      return null;
    }

    const memberships = await this.#staff.membershipsOf(userId, tx);
    const brands = await this.#staff.brandsByIds(
      memberships.map((membership) => membership.brandId),
      tx,
    );
    // Whichever milestone adds brand switching writes this key; until one
    // does, every session lands in the first brand the account holds a role in.
    const preferredBrandId = await this.#redis.get(brandPreferenceKey(userId));

    const session = buildSession({
      user,
      memberships,
      brands,
      appUrl: this.#appUrl,
      preferredBrandId,
    });

    if (session === null) {
      return null;
    }

    return {
      session,
      claimBrands: toClaimBrands(memberships),
      installAdmin: user.installAdmin,
    };
  }

  /**
   * "The server publishes `principal.revoked` over Redis and every replica
   * disconnects that principal's sockets within 5 seconds" (DOMAIN-RULES §1.4).
   * M0-13 is the subscriber; publishing without one costs nothing and means the
   * gateway has something to listen to on the day it arrives.
   *
   * A failure to publish must not fail the sign-out that caused it: the family
   * is already gone, and the access token expires within ten minutes anyway.
   */
  async #announceRevocation(userId: string, reason: string): Promise<void> {
    try {
      await this.#redis.publish(
        PRINCIPAL_REVOKED_CHANNEL,
        JSON.stringify({ principalType: 'staff', principalId: userId, reason }),
      );
    } catch (error) {
      this.#logger.error({ err: error, userId }, 'Could not publish principal.revoked');
    }
  }
}

interface SessionView {
  readonly session: Session;
  readonly claimBrands: ReturnType<typeof toClaimBrands>;
  readonly installAdmin: boolean;
}
