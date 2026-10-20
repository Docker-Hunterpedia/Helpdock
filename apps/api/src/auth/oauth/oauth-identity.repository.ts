import { type Db, type UserOauthIdentity, userOauthIdentities } from '@helpdock/db';
import type { OauthProvider } from '@helpdock/schemas';
import { and, asc, eq } from 'drizzle-orm';
import type { Queryable } from '../staff.repository.js';

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
