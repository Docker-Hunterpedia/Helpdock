import { encryptSecret, type Keyring } from '@helpdock/config';
import { type Db, type DbTransaction, withTenant } from '@helpdock/db';
import { AUTH_EMAIL_KINDS, enqueueOutbox } from '@helpdock/jobs';
import { z } from 'zod';
import { AUTH_SYSTEM_PRINCIPAL, type StaffRepository } from './staff.repository.js';

/**
 * The request half of auth email: a sign-in link, a password reset or a staff
 * invitation becomes one `auth.email_requested` outbox row, and the worker's
 * `auth.email` job renders and sends it (`auth-email.job.ts`). Nothing here
 * talks to a mail server, so no request waits on one and none sends anything
 * the transaction it belongs to later rolls back (AGENTS.md, side effects).
 *
 * **The link is sealed.** It is a working credential — Redis only ever holds
 * its hash — so it is encrypted under `APP_MASTER_KEY` before it reaches the
 * outbox, and stays sealed in the job's data too. The worker opens it only to
 * put it in the message. A reference alone would not do: the token cannot be
 * derived again from the hash Redis keeps, which is the point of keeping a hash.
 */

export const AUTH_EMAIL_EVENT = 'auth.email_requested';

/** What an `auth.email_requested` row holds. The job adds its brand and outbox id. */
export const authEmailEventSchema = z.object({
  kind: z.enum(AUTH_EMAIL_KINDS),
  userId: z.uuid(),
  urlEncrypted: z.string().min(1),
  expiresIn: z.int().positive(),
  values: z.record(z.string(), z.string()).optional(),
});
export type AuthEmailEvent = z.infer<typeof authEmailEventSchema>;

export type AuthEmailKind = AuthEmailEvent['kind'];

/** One auth email as a service asks for it, with the link still in the clear. */
export interface AuthEmailRequest {
  readonly kind: AuthEmailKind;
  readonly userId: string;
  readonly url: string;
  readonly expiresIn: number;
  readonly values?: Readonly<Record<string, string>>;
}

/** What `AuthService` and `StaffService` need; a unit test passes a recorder. */
export interface AuthMail {
  /** Queues the email in the caller's transaction, which already names `brandId`. */
  queue(tx: DbTransaction, brandId: string, request: AuthEmailRequest): Promise<void>;
  /**
   * Queues the email in a transaction of its own, for a flow with no request
   * transaction to join. Answers false when the account holds no role in any
   * active brand, which also means it could not sign in with the link.
   */
  queueForAccount(request: AuthEmailRequest): Promise<boolean>;
}

export class OutboxAuthMail implements AuthMail {
  readonly #db: Db;
  readonly #keyring: Keyring;
  readonly #staff: Pick<StaffRepository, 'membershipsOf'>;

  constructor({
    db,
    keyring,
    staff,
  }: {
    readonly db: Db;
    readonly keyring: Keyring;
    readonly staff: Pick<StaffRepository, 'membershipsOf'>;
  }) {
    this.#db = db;
    this.#keyring = keyring;
    this.#staff = staff;
  }

  async queue(tx: DbTransaction, brandId: string, request: AuthEmailRequest): Promise<void> {
    await enqueueOutbox(tx, { brandId, event: AUTH_EMAIL_EVENT, payload: this.#seal(request) });
  }

  /**
   * The sign-in link and the password reset are anonymous requests whose token
   * lives in Redis alone, so there is no domain transaction to write the outbox
   * row in. The token is issued first and the row written second, in a
   * transaction of its own: if the write fails, the person gets no email and
   * a token nobody holds expires unused; the reverse order could send a link
   * whose token was never stored. The outbox needs a brand, and any brand the
   * account works in will do — the row routes the job and nothing else.
   */
  async queueForAccount(request: AuthEmailRequest): Promise<boolean> {
    const memberships = await this.#staff.membershipsOf(request.userId);
    const [brandId] = memberships.map((membership) => membership.brandId).sort();
    if (brandId === undefined) {
      return false;
    }

    await withTenant(
      this.#db,
      {
        brandIds: [brandId],
        departmentIds: 'all',
        principalType: 'system',
        principalId: AUTH_SYSTEM_PRINCIPAL,
      },
      (tx) => this.queue(tx, brandId, request),
    );

    return true;
  }

  #seal({ kind, userId, url, expiresIn, values }: AuthEmailRequest): AuthEmailEvent {
    return {
      kind,
      userId,
      urlEncrypted: encryptSecret(url, this.#keyring),
      expiresIn,
      ...(values === undefined ? {} : { values: { ...values } }),
    };
  }
}
