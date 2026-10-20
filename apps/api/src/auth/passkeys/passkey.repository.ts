import { randomBytes } from 'node:crypto';
import {
  type Db,
  type DbTransaction,
  users,
  type WebauthnCredential,
  webauthnCredentials,
} from '@helpdock/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../staff.repository.js';
import type { RegisteredPasskey } from '../webauthn/webauthn.service.js';

const USER_HANDLE_BYTES = 32;

/**
 * `webauthn_credentials`, read and written by a person's own `/api/me/passkeys`
 * routes. It is a global table (`GLOBAL_TABLES` in `@helpdock/db`), so it is
 * queried directly, as `StaffRepository` queries `users`; every method names
 * the account it acts on, and the routes pass only the caller's own id. There
 * is no method that takes a credential id without a user id, which is what
 * keeps one account away from another's passkeys.
 */
export class PasskeyRepository {
  readonly #db: Db;

  constructor({ db }: { readonly db: Db }) {
    this.#db = db;
  }

  /** For the sign-in path, which has no request transaction and needs a real one (lock, count, insert). */
  async transaction<T>(run: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.#db.transaction(run);
  }

  async ofUser(userId: string, tx?: Queryable): Promise<WebauthnCredential[]> {
    return (tx ?? this.#db)
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(asc(webauthnCredentials.createdAt), asc(webauthnCredentials.id));
  }

  async find(userId: string, id: string, tx?: Queryable): Promise<WebauthnCredential | undefined> {
    const [row] = await (tx ?? this.#db)
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)));
    return row;
  }

  /** The stored credential an assertion names, for any account; the caller compares owners. */
  async byCredentialId(
    credentialId: Uint8Array,
    tx?: Queryable,
  ): Promise<WebauthnCredential | undefined> {
    const [row] = await (tx ?? this.#db)
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId));
    return row;
  }

  /**
   * Serialises the writers of one account's passkeys: the row lock is what
   * makes "at most ten" and "never the last second factor" true under two
   * parallel requests, which a count followed by an insert would not be.
   */
  async lockAccount(userId: string, tx: Queryable): Promise<void> {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);
  }

  /**
   * The account's 32-byte user handle, drawn at its first registration. The
   * handle is not the account id, which would leak when the account was made.
   */
  async userHandle(userId: string, tx?: Queryable): Promise<Uint8Array> {
    const db = tx ?? this.#db;
    const [existing] = await db
      .select({ handle: users.webauthnUserHandle })
      .from(users)
      .where(eq(users.id, userId));
    if (existing?.handle) {
      return existing.handle;
    }

    const [drawn] = await db
      .update(users)
      .set({ webauthnUserHandle: new Uint8Array(randomBytes(USER_HANDLE_BYTES)) })
      .where(and(eq(users.id, userId), sql`${users.webauthnUserHandle} IS NULL`))
      .returning({ handle: users.webauthnUserHandle });
    if (drawn?.handle) {
      return drawn.handle;
    }

    // Lost a race to another request that drew one first.
    const [raced] = await db
      .select({ handle: users.webauthnUserHandle })
      .from(users)
      .where(eq(users.id, userId));
    if (!raced?.handle) {
      throw new Error(`Could not draw a WebAuthn user handle for ${userId}`);
    }
    return raced.handle;
  }

  /** `duplicate` when this authenticator's credential id is already stored, for anybody. */
  async add(
    userId: string,
    name: string,
    passkey: RegisteredPasskey,
    tx: Queryable,
  ): Promise<WebauthnCredential | 'duplicate'> {
    const [row] = await tx
      .insert(webauthnCredentials)
      .values({
        userId,
        name,
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        algorithm: passkey.algorithm,
        signCount: passkey.signCount,
        transports: passkey.transports,
        aaguid: passkey.aaguid,
        discoverable: passkey.discoverable,
        backupEligible: passkey.backupEligible,
        backedUp: passkey.backedUp,
      })
      .onConflictDoNothing({ target: webauthnCredentials.credentialId })
      .returning();
    return row ?? 'duplicate';
  }

  async rename(
    userId: string,
    id: string,
    name: string,
    tx: Queryable,
  ): Promise<WebauthnCredential | undefined> {
    const [row] = await tx
      .update(webauthnCredentials)
      .set({ name })
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning();
    return row;
  }

  async remove(userId: string, id: string, tx: Queryable): Promise<WebauthnCredential | undefined> {
    const [row] = await tx
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId)))
      .returning();
    return row;
  }

  /**
   * Records an assertion: the new counter, the backup state it reported, and
   * when. The counter only ever grows (`GREATEST`), so two assertions checked
   * against the same stored value cannot leave the lower one behind; an
   * authenticator that never counts stays at 0.
   */
  async markUsed(
    credentialId: Uint8Array,
    signCount: number,
    backedUp: boolean,
    tx?: Queryable,
  ): Promise<void> {
    await (tx ?? this.#db)
      .update(webauthnCredentials)
      .set({
        signCount: sql`GREATEST(${webauthnCredentials.signCount}, ${signCount})`,
        backedUp,
        lastUsedAt: new Date(),
      })
      .where(eq(webauthnCredentials.credentialId, credentialId));
  }

  async count(userId: string, tx?: Queryable): Promise<number> {
    const [row] = await (tx ?? this.#db)
      .select({ total: sql<number>`count(*)::int` })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));
    return row?.total ?? 0;
  }
}
