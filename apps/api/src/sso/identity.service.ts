import type { Settings } from '@helpdock/config';
import type { Db, DbTransaction, User } from '@helpdock/db';
import {
  auditLog,
  brands,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  ssoConnections,
  ssoRoleMappings,
  userBrandRoles,
  userSsoIdentities,
  users,
  withTenant,
} from '@helpdock/db';
import { ssoAccessSchema } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AuthFailure } from '../auth/auth-failure.js';
import { EmailTokenStore } from '../auth/email-token.store.js';
import { lockSessionWriteAuthority } from '../auth/session/authority-lock.js';
import type { SessionService } from '../auth/session/session.service.js';
import { writeStaffAudit } from '../staff/audit.js';
import { InviteStore } from '../staff/invite.store.js';
import { type SsoAssertion, ssoAssertionSchema } from './oidc-contracts.js';
import { mappedSsoAccess, type SsoAccess, ssoRoleSyncPlan } from './role-sync.js';
import { SSO_CONFIG_LOCK } from './sp-keys.js';

type Connection = typeof ssoConnections.$inferSelect;
type SyncPlan = ReturnType<typeof ssoRoleSyncPlan>;
export type SsoIdentityPreview = {
  user: { id: string; name: string; email: string } | null;
  wouldCreate: boolean;
  access: SsoAccess[];
  conflict: boolean;
};

/**
 * Audited pre-tenant authentication path. A protocol-verified assertion is the
 * only caller. Tenant reads/writes name every brand explicitly, retain FORCE
 * RLS, and are confined to this identity's memberships plus install audit rows.
 */
export class SsoIdentityService {
  constructor(
    private readonly options: {
      db: Db;
      sessions: SessionService;
      redis: Redis;
      settings: Settings;
    },
  ) {}

  async signIn(assertion: SsoAssertion): Promise<{ user: User; idpEnforcesMfa: boolean }> {
    const verified = ssoAssertionSchema.parse(assertion);
    const completion = await this.#transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SSO_CONFIG_LOCK})`);
      // Serializes email linking/JIT across different subjects and connections.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${verified.email.toLowerCase()}, 11))`,
      );
      const connection = await this.#connection(tx, verified);
      const candidate = await this.#candidate(tx, connection, verified);
      if (candidate && !['active', 'invited'].includes(candidate.status))
        throw new AuthFailure('no-account');
      const desired = await this.#desiredAccess(tx, connection, verified);
      if (!candidate && !connection.jitEnabled) throw new AuthFailure('no-account');
      if (!candidate && desired.length === 0) throw new AuthFailure('sso-no-access');
      const user = candidate ?? (await this.#provision(tx, verified));
      if (!(await this.#synchronize(tx, { user, connection, desired }))) {
        if (!candidate) throw new AuthFailure('sso-no-access');
        return null;
      }
      await this.#link(tx, {
        userId: user.id,
        connectionId: connection.id,
        assertion: verified,
        provisioned: candidate === undefined,
      });
      const name = verified.name?.trim();
      if (!name || name === user.name) return { user, idpEnforcesMfa: connection.idpEnforcesMfa };
      const [updated] = await tx
        .update(users)
        .set({ name })
        .where(eq(users.id, user.id))
        .returning();
      return { user: updated ?? user, idpEnforcesMfa: connection.idpEnforcesMfa };
    });
    if (completion === null) throw new AuthFailure('sso-no-access');
    return completion;
  }

  /** Called only after all required factors succeed; a pending MFA challenge accepts nothing. */
  async acceptInvitation(userId: string): Promise<void> {
    const memberships = await this.#transaction(async (tx) => {
      await lockSessionWriteAuthority(tx, userId);
      const [activated] = await tx
        .update(users)
        .set({ status: 'active' })
        .where(and(eq(users.id, userId), eq(users.status, 'invited')))
        .returning();
      const grants = await tx
        .select()
        .from(userBrandRoles)
        .where(eq(userBrandRoles.userId, userId));
      if (activated) {
        for (const grant of grants)
          await writeStaffAudit(tx, {
            brandId: grant.brandId,
            actorId: userId,
            actorType: 'system',
            action: 'staff.invite.accepted',
            targetId: userId,
            meta: { method: 'sso', role: grant.role, departmentIds: grant.departmentIds },
          });
      }
      return grants;
    });
    const invites = new InviteStore(this.options.redis);
    const tokens = new EmailTokenStore(this.options.redis);
    for (const grant of memberships) {
      const pending = await invites.read(grant.brandId, userId);
      if (pending) {
        await tokens.revokeByHash(pending.tokenHash);
        await invites.take(grant.brandId, userId);
      }
    }
  }

  async assertLinked(userId: string, connectionId: string): Promise<void> {
    const [linked] = await this.options.db
      .select({ id: userSsoIdentities.id })
      .from(userSsoIdentities)
      .innerJoin(ssoConnections, eq(ssoConnections.id, userSsoIdentities.connectionId))
      .where(
        and(
          eq(userSsoIdentities.userId, userId),
          eq(userSsoIdentities.connectionId, connectionId),
          eq(ssoConnections.enabled, true),
        ),
      );
    if (!linked) throw new AuthFailure('sso-connection-disabled');
  }

  async preview(assertion: SsoAssertion): Promise<SsoIdentityPreview> {
    const verified = ssoAssertionSchema.parse(assertion);
    return this.#transaction(async (tx) => {
      const connection = await this.#connection(tx, verified);
      const user = await this.#candidate(tx, connection, verified);
      if (user && !['active', 'invited'].includes(user.status)) throw new AuthFailure('no-account');
      const current = user
        ? await tx.select().from(userBrandRoles).where(eq(userBrandRoles.userId, user.id))
        : [];
      const desired = await this.#desiredAccess(tx, connection, verified);
      const plan = ssoRoleSyncPlan({ connectionId: connection.id, current, desired });
      return {
        user: user ? { id: user.id, name: user.name, email: user.email } : null,
        wouldCreate: !user && connection.jitEnabled && desired.length > 0,
        access: await this.#usableAccess(plan.after),
        conflict: plan.conflicts.length > 0,
      };
    });
  }

  async #transaction<T>(callback: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const allBrands = await this.options.db.select({ id: brands.id }).from(brands);
    return withTenant(
      this.options.db,
      {
        brandIds: [INSTALL_SCOPE_BRAND_ID, ...allBrands.map((brand) => brand.id)],
        departmentIds: 'all',
        principalType: 'system',
        principalId: 'auth:sso',
      },
      callback,
    );
  }

  async #connection(tx: DbTransaction, assertion: SsoAssertion): Promise<Connection> {
    const [connection] = await tx
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, assertion.connectionId));
    if (!connection?.enabled) throw new AuthFailure('sso-connection-disabled');
    if (
      assertion.connectionRevision !== undefined &&
      assertion.connectionRevision !== connection.updatedAt.toISOString()
    )
      throw new AuthFailure('sso-invalid-response');
    return connection;
  }

  async #candidate(
    tx: DbTransaction,
    connection: Connection,
    assertion: SsoAssertion,
  ): Promise<User | undefined> {
    const [linked] = await tx
      .select({ user: users })
      .from(userSsoIdentities)
      .innerJoin(users, eq(users.id, userSsoIdentities.userId))
      .where(
        and(
          eq(userSsoIdentities.connectionId, connection.id),
          eq(userSsoIdentities.subject, assertion.subject),
        ),
      );
    if (linked) return linked.user;
    if (!connection.emailDomains.includes(assertion.email.split('@')[1]?.toLowerCase() ?? ''))
      throw new AuthFailure('sso-email-unverified');
    const [matched] = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${assertion.email})`);
    return matched;
  }

  async #desiredAccess(
    tx: DbTransaction,
    connection: Connection,
    assertion: SsoAssertion,
  ): Promise<SsoAccess[]> {
    const mappings = await tx
      .select()
      .from(ssoRoleMappings)
      .where(eq(ssoRoleMappings.connectionId, connection.id));
    const desired = mappedSsoAccess({
      groups: assertion.groups,
      mappings,
      defaultAccess:
        connection.defaultAccess === null ? null : ssoAccessSchema.parse(connection.defaultAccess),
    });
    const activeBrands = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.status, 'active'));
    const activeAccess = desired.filter((grant) =>
      activeBrands.some((brand) => brand.id === grant.brandId),
    );
    for (const grant of activeAccess) {
      if (grant.departmentIds === null) continue;
      const available = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.brandId, grant.brandId));
      if (grant.departmentIds.some((id) => !available.some((department) => department.id === id)))
        throw new AuthFailure('sso-no-access');
    }
    return this.#usableAccess(activeAccess);
  }

  async #usableAccess(grants: SsoAccess[]): Promise<SsoAccess[]> {
    return (await this.options.settings.get('roles.viewerEnabled'))
      ? grants
      : grants.filter((grant) => grant.role !== 'viewer');
  }

  async #provision(tx: DbTransaction, assertion: SsoAssertion): Promise<User> {
    const [user] = await tx
      .insert(users)
      .values({
        email: assertion.email.toLowerCase(),
        name: assertion.name?.trim() || assertion.email,
        status: 'active',
        passwordHash: null,
      })
      .returning();
    if (!user) throw new Error('SSO user insert returned no account');
    return user;
  }

  async #synchronize(
    tx: DbTransaction,
    { user, connection, desired }: { user: User; connection: Connection; desired: SsoAccess[] },
  ): Promise<boolean> {
    await lockSessionWriteAuthority(tx, user.id);
    const current = await tx
      .select()
      .from(userBrandRoles)
      .where(eq(userBrandRoles.userId, user.id))
      .for('update');
    const plan = ssoRoleSyncPlan({ connectionId: connection.id, current, desired });
    if (plan.conflicts.length) throw new AuthFailure('sso-no-access');
    await this.#applyRoles(tx, user.id, connection.id, plan);
    if (plan.remove.length || plan.upsert.length) {
      await this.#audit(tx, user.id, 'sso.roles.synced', {
        connectionId: connection.id,
        before: current.map(({ brandId, role, departmentIds }) => ({
          brandId,
          role,
          departmentIds,
        })),
        after: plan.after,
      });
    }
    const activeBrands = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.status, 'active'));
    const usableAccess = await this.#usableAccess(plan.after);
    const hasAccess = usableAccess.some((grant) =>
      activeBrands.some((brand) => brand.id === grant.brandId),
    );
    // Return a denial instead of throwing: removed grants must commit even
    // when this was the last membership. Revocation fails closed inside the
    // transaction, just as existing staff role edits do.
    return hasAccess;
  }

  async #applyRoles(
    tx: DbTransaction,
    userId: string,
    connectionId: string,
    plan: SyncPlan,
  ): Promise<void> {
    if (plan.revokeSessions)
      await this.options.sessions.revokeEverything(userId, 'sso-roles-synced');
    for (const grant of plan.remove)
      await tx
        .delete(userBrandRoles)
        .where(
          and(
            eq(userBrandRoles.id, grant.id),
            eq(userBrandRoles.source, 'sso'),
            eq(userBrandRoles.ssoConnectionId, connectionId),
          ),
        );
    for (const grant of plan.upsert) {
      const applied = await tx
        .insert(userBrandRoles)
        .values({ ...grant, userId, source: 'sso', ssoConnectionId: connectionId })
        .onConflictDoUpdate({
          target: [userBrandRoles.userId, userBrandRoles.brandId],
          set: { role: grant.role, departmentIds: grant.departmentIds },
          setWhere: sql`${userBrandRoles.source} = 'sso' AND ${userBrandRoles.ssoConnectionId} = ${connectionId}`,
        })
        .returning({ id: userBrandRoles.id });
      if (applied.length === 0) throw new AuthFailure('sso-no-access');
    }
  }

  async #link(
    tx: DbTransaction,
    {
      userId,
      connectionId,
      assertion,
      provisioned,
    }: { userId: string; connectionId: string; assertion: SsoAssertion; provisioned: boolean },
  ): Promise<void> {
    const inserted = await tx
      .insert(userSsoIdentities)
      .values({
        userId,
        connectionId,
        subject: assertion.subject,
        emailAtLink: assertion.email,
        lastSignInAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length)
      await this.#audit(tx, userId, provisioned ? 'sso.user.provisioned' : 'sso.user.linked', {
        connectionId,
      });
    await tx
      .update(userSsoIdentities)
      .set({ lastSignInAt: new Date() })
      .where(
        and(
          eq(userSsoIdentities.connectionId, connectionId),
          eq(userSsoIdentities.subject, assertion.subject),
        ),
      );
    // Successful sign-ins must not invalidate outstanding protocol requests by
    // changing the configuration revision's updated_at column.
    await tx
      .update(ssoConnections)
      .set({ lastSignInAt: new Date(), updatedAt: sql`${ssoConnections.updatedAt}` })
      .where(eq(ssoConnections.id, connectionId));
  }

  async #audit(
    tx: DbTransaction,
    userId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'system',
      actorId: 'auth:sso',
      action,
      targetType: 'user',
      targetId: userId,
      meta,
    });
  }
}
