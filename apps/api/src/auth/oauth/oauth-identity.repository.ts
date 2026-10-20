import {
  auditLog,
  type Db,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  type UserOauthIdentity,
  userOauthIdentities,
  withTenant,
} from '@helpdock/db';
import type { OauthProvider } from '@helpdock/schemas';
import { and, asc, count, eq, notInArray, sql } from 'drizzle-orm';
import type { Queryable } from '../staff.repository.js';

/** Thrown inside the replacement transaction so it rolls back whole. */
class ReplacementRefused extends Error {}

export interface OauthLink {
  readonly userId: string;
  readonly provider: OauthProvider;
  readonly subject: string;
  readonly email: string;
  readonly via: OauthLinkedVia;
}

export type OauthLinkedVia = NonNullable<UserOauthIdentity['linkedVia']>;

/**
 * `user_oauth_identities`, read and written by the sign-in path before any
 * brand is known and by a person's own security routes. It is a global table
 * (`GLOBAL_TABLES` in `@helpdock/db`), so it is queried directly, as
 * `StaffRepository` queries `users`; every method that changes a row names the
 * account it belongs to, and the routes that reach them pass only the caller's
 * own id.
 *
 * Every method takes the request's transaction when there is one, for the
 * reason `StaffRepository` gives.
 */
export class OauthIdentityRepository {
  readonly #db: Db;

  constructor({ db }: { readonly db: Db }) {
    this.#db = db;
  }

  /** The account this provider account is bound to, if any. */
  async userFor(
    provider: OauthProvider,
    subject: string,
    tx?: Queryable,
  ): Promise<string | undefined> {
    const [row] = await (tx ?? this.#db)
      .select({ userId: userOauthIdentities.userId })
      .from(userOauthIdentities)
      .where(
        and(
          eq(userOauthIdentities.provider, provider),
          eq(userOauthIdentities.providerSubject, subject),
        ),
      );
    return row?.userId;
  }

  async ofUser(userId: string, tx?: Queryable): Promise<UserOauthIdentity[]> {
    return (tx ?? this.#db)
      .select()
      .from(userOauthIdentities)
      .where(eq(userOauthIdentities.userId, userId))
      .orderBy(asc(userOauthIdentities.provider));
  }

  async hasProvider(userId: string, provider: OauthProvider, tx?: Queryable): Promise<boolean> {
    const rows = await this.ofUser(userId, tx);
    return rows.some((row) => row.provider === provider);
  }

  /**
   * Binds a provider account. `conflict` when that provider account is bound to
   * somebody else, or this person already has one of the provider: the unique
   * keys decide, so two callbacks racing cannot both win.
   */
  async link(link: OauthLink, tx?: Queryable): Promise<'linked' | 'conflict'> {
    const inserted = await (tx ?? this.#db)
      .insert(userOauthIdentities)
      .values({
        userId: link.userId,
        provider: link.provider,
        providerSubject: link.subject,
        emailAtLink: link.email,
        linkedVia: link.via,
        // A link made by signing in, or by accepting an invitation, is also its first use.
        lastUsedAt: link.via === 'connect' ? null : new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: userOauthIdentities.id });
    if (inserted.length > 0) {
      return 'linked';
    }
    // A repeat of the same link (a double callback) is not a conflict.
    return (await this.userFor(link.provider, link.subject, tx)) === link.userId
      ? 'linked'
      : 'conflict';
  }

  /** Records a sign-in through this provider account, for the person's list of sign-in methods. */
  async markUsed(provider: OauthProvider, subject: string, tx?: Queryable): Promise<void> {
    await (tx ?? this.#db)
      .update(userOauthIdentities)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(userOauthIdentities.provider, provider),
          eq(userOauthIdentities.providerSubject, subject),
        ),
      );
  }

  /**
   * Replaces a person's Microsoft identity that names a tenant the install no
   * longer accepts with a new link, and everything that must go with it, in one
   * transaction scoped to `brandId` (and to the install scope for the audit row):
   * a failure anywhere leaves the old row, no audit row and no email.
   *
   * `none` when they have no Microsoft identity, so the caller links normally;
   * `conflict` when the one they have is still accepted, or the new subject is
   * bound to somebody else. A stranded row cannot sign anyone in, so leaving it
   * until its holder reconnects costs nothing, and deleting it for them would
   * remove a sign-in method behind the last-way-in guard's back.
   */
  async replaceStrandedMicrosoft({
    link,
    acceptedTenants,
    brandId,
    afterReplace,
  }: {
    readonly link: OauthLink;
    readonly acceptedTenants: readonly string[];
    readonly brandId: string;
    afterReplace(tx: DbTransaction): Promise<void>;
  }): Promise<'replaced' | 'none' | 'conflict'> {
    const tenantOf = (subject: string): string => subject.slice(0, subject.indexOf(':'));
    try {
      return await withTenant(
        this.#db,
        {
          brandIds: [brandId, INSTALL_SCOPE_BRAND_ID],
          departmentIds: 'all',
          principalType: 'system',
          principalId: 'auth',
        },
        async (tx) => {
          const [existing] = await tx
            .select()
            .from(userOauthIdentities)
            .where(
              and(
                eq(userOauthIdentities.userId, link.userId),
                eq(userOauthIdentities.provider, 'microsoft'),
              ),
            );
          if (existing === undefined) {
            return 'none';
          }
          if (acceptedTenants.includes(tenantOf(existing.providerSubject))) {
            return 'conflict';
          }

          await tx.delete(userOauthIdentities).where(eq(userOauthIdentities.id, existing.id));
          const inserted = await tx
            .insert(userOauthIdentities)
            .values({
              userId: link.userId,
              provider: 'microsoft',
              providerSubject: link.subject,
              emailAtLink: link.email,
              linkedVia: link.via,
              lastUsedAt: link.via === 'connect' ? null : new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: userOauthIdentities.id });
          if (inserted.length === 0) {
            throw new ReplacementRefused();
          }
          await tx.insert(auditLog).values({
            brandId: INSTALL_SCOPE_BRAND_ID,
            actorType: link.via === 'connect' ? 'staff' : 'system',
            actorId: link.via === 'connect' ? link.userId : 'auth',
            action: 'auth.oauth.identity_replaced',
            targetType: 'user',
            targetId: link.userId,
            meta: {
              provider: 'microsoft',
              via: link.via,
              fromTenant: tenantOf(existing.providerSubject),
              toTenant: tenantOf(link.subject),
            },
          });
          await afterReplace(tx);

          return 'replaced';
        },
      );
    } catch (error) {
      if (error instanceof ReplacementRefused) {
        return 'conflict';
      }
      throw error;
    }
  }

  /** How many Microsoft identities name a tenant outside `acceptedTenants`: for a boot-time warning, never a write. */
  async countMicrosoftOutside(acceptedTenants: readonly string[], tx?: Queryable): Promise<number> {
    if (acceptedTenants.length === 0) {
      return 0;
    }
    const [row] = await (tx ?? this.#db)
      .select({ total: count() })
      .from(userOauthIdentities)
      .where(
        and(
          eq(userOauthIdentities.provider, 'microsoft'),
          notInArray(sql`split_part(${userOauthIdentities.providerSubject}, ':', 1)`, [
            ...acceptedTenants,
          ]),
        ),
      );
    return row?.total ?? 0;
  }

  /** The address the removed link was made with, or undefined when there was none to remove. */
  async unlink(
    userId: string,
    provider: OauthProvider,
    tx?: Queryable,
  ): Promise<{ readonly emailAtLink: string } | undefined> {
    const [removed] = await (tx ?? this.#db)
      .delete(userOauthIdentities)
      .where(
        and(eq(userOauthIdentities.userId, userId), eq(userOauthIdentities.provider, provider)),
      )
      .returning({ emailAtLink: userOauthIdentities.emailAtLink });
    return removed;
  }
}
