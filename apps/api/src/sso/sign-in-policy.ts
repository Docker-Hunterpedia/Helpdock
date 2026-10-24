import type { Keyring, Settings } from '@helpdock/config';
import {
  type Db,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  ssoConnections,
  type User,
  users,
  withSystem,
} from '@helpdock/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { AuthFailure } from '../auth/auth-failure.js';
import { enforcementAllows, isBreakGlassEligible, passkeyCounts } from './break-glass.js';
import { readSsoSetting } from './sso-settings.js';

/** Install-global pre-tenant policy; never uses the cached enforcement settings. */
export class SsoSignInPolicy {
  constructor(private readonly options: { db: Db; settings: Settings; keyring: Keyring }) {}

  async enforced(): Promise<boolean> {
    return withSystem(this.options.db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      readSsoSetting(tx, this.options.settings, this.options.keyring, 'sso.enforced'),
    );
  }

  async assertLocal(email: string, method: string): Promise<void> {
    await withSystem(this.options.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      if (!(await readSsoSetting(tx, this.options.settings, this.options.keyring, 'sso.enforced')))
        return;
      // Emergency access is a password followed by a fresh app code or a fresh
      // passkey assertion (ADR 0053). Magic links, OAuth, passwordless passkeys,
      // recovery codes and trusted-browser cookies do not qualify.
      if (method !== 'password') throw new AuthFailure('sso-required');
      const allowed = await readSsoSetting(
        tx,
        this.options.settings,
        this.options.keyring,
        'sso.breakGlassUserIds',
      );
      const [user] = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`);
      if (!user || !allowed.includes(user.id)) throw new AuthFailure('sso-required');
      const held = (await passkeyCounts(tx, [user.id])).get(user.id) ?? 0;
      if (!isBreakGlassEligible(user, held)) throw new AuthFailure('sso-required');
    });
  }

  /**
   * Whether a recovery code may not stand in as a step-up proof for this
   * account. Under enforcement, a break-glass account (on the list, or eligible
   * for it) is the install's emergency way in, and recovery codes are kept out
   * of break-glass (ADR 0053); a code that could install its next factor would
   * be a way round that. Never barred while SSO is not enforced.
   */
  async recoveryCodeBarred(user: User): Promise<boolean> {
    return withSystem(this.options.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      if (!(await readSsoSetting(tx, this.options.settings, this.options.keyring, 'sso.enforced')))
        return false;
      const listed = await readSsoSetting(
        tx,
        this.options.settings,
        this.options.keyring,
        'sso.breakGlassUserIds',
      );
      if (listed.includes(user.id)) return true;
      return isBreakGlassEligible(user, (await passkeyCounts(tx, [user.id])).get(user.id) ?? 0);
    });
  }

  /**
   * How many configured break-glass accounts would stop being eligible if every
   * passkey on the install were removed: those that are eligible now and rely on
   * a verified passkey because they have no authenticator app. Zero while SSO is
   * not enforced, since nothing then depends on break-glass. Passkeys are about
   * to be removed (M18-06 "Move passkeys"), so this is the lockout it would cause.
   */
  async breakGlassLosingPasskeys(within?: DbTransaction): Promise<number> {
    const count = async (tx: DbTransaction): Promise<number> => {
      if (!(await readSsoSetting(tx, this.options.settings, this.options.keyring, 'sso.enforced')))
        return 0;
      const allowed = await readSsoSetting(
        tx,
        this.options.settings,
        this.options.keyring,
        'sso.breakGlassUserIds',
      );
      if (allowed.length === 0) return 0;
      const candidates = await tx
        .select()
        .from(users)
        .where(inArray(users.id, [...allowed]));
      const held = await passkeyCounts(
        tx,
        candidates.map((user) => user.id),
      );
      return candidates.filter(
        (user) =>
          isBreakGlassEligible(user, held.get(user.id) ?? 0) && !isBreakGlassEligible(user, 0),
      ).length;
    };

    return within === undefined
      ? withSystem(this.options.db, INSTALL_SCOPE_BRAND_ID, count)
      : count(within);
  }

  /**
   * Whether a sign-in that began with `firstFactor` may finish with `factor`
   * under the current enforcement. Always true when SSO is not enforced.
   */
  async allows(firstFactor: string, factor: string | null): Promise<boolean> {
    return !(await this.enforced()) || enforcementAllows(firstFactor, factor);
  }

  /** The refusing form of {@link allows}. */
  async assertAllowed(firstFactor: string, factor: string | null): Promise<void> {
    if (!(await this.allows(firstFactor, factor))) throw new AuthFailure('sso-required');
  }

  async connections(): Promise<{ id: string; name: string }[]> {
    return this.options.db
      .select({ id: ssoConnections.id, name: ssoConnections.name })
      .from(ssoConnections)
      .where(eq(ssoConnections.enabled, true));
  }

  async discover(email: string): Promise<{ connections: { id: string; name: string }[] }> {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    const connections = await this.options.db
      .select({
        id: ssoConnections.id,
        name: ssoConnections.name,
        domains: ssoConnections.emailDomains,
      })
      .from(ssoConnections)
      .where(eq(ssoConnections.enabled, true));
    return {
      connections: connections
        .filter((connection) => connection.domains.includes(domain))
        .map(({ id, name }) => ({ id, name })),
    };
  }
}
