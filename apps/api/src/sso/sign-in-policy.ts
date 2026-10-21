import type { Keyring, Settings } from '@helpdock/config';
import { type Db, INSTALL_SCOPE_BRAND_ID, ssoConnections, users, withSystem } from '@helpdock/db';
import { eq, sql } from 'drizzle-orm';
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
