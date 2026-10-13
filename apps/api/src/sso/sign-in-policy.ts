import type { Keyring, Settings } from '@helpdock/config';
import { type Db, INSTALL_SCOPE_BRAND_ID, ssoConnections, users, withSystem } from '@helpdock/db';
import { eq, sql } from 'drizzle-orm';
import { AuthFailure } from '../auth/auth-failure.js';
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
      // Emergency access is a password followed by a fresh stored TOTP. Magic
      // links, OAuth, recovery codes and trusted-browser cookies do not qualify.
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
      if (
        !user ||
        !allowed.includes(user.id) ||
        !user.installAdmin ||
        user.status !== 'active' ||
        !user.passwordHash ||
        !user.totpEnabled ||
        !user.totpSecretEncrypted
      )
        throw new AuthFailure('sso-required');
    });
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
