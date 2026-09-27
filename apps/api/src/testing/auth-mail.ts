import type { EmailMessage } from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import { brands, type Db, outbox, users, withTenant } from '@helpdock/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { composeAuthEmail } from '../auth/auth-email.job.js';
import { AUTH_EMAIL_EVENT, authEmailEventSchema } from '../auth/auth-email.js';

/**
 * The auth emails an api under test has queued, read back out of the outbox
 * and rendered exactly as the worker's `auth.email` job would render them. The
 * HTTP suites follow a sign-in link or an invitation with it, without running
 * a worker; `auth-email.integration.test.ts` proves the worker half against
 * Mailpit.
 */
export class QueuedAuthMail {
  readonly #db: Db;
  readonly #keyring: Keyring;
  #seen = 0;

  constructor({ db, keyring }: { readonly db: Db; readonly keyring: Keyring }) {
    this.#db = db;
    this.#keyring = keyring;
  }

  /** The `auth.email_requested` rows as stored, oldest first: what a leak would be read from. */
  async payloads(): Promise<Record<string, unknown>[]> {
    const brandIds = (await this.#db.select({ id: brands.id }).from(brands)).map((row) => row.id);
    if (brandIds.length === 0) {
      return [];
    }

    // A test reads every brand's rows at once; production code never widens a
    // system transaction this way (DOMAIN-RULES §1.4).
    const rows = await withTenant(
      this.#db,
      { brandIds, departmentIds: 'all', principalType: 'system', principalId: 'test' },
      (tx) =>
        tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, AUTH_EMAIL_EVENT))
          .orderBy(asc(outbox.id)),
    );

    return rows.map((row) => row.payload);
  }

  /** Forgets what was queued so far, as far as {@link all} is concerned. */
  async clear(): Promise<void> {
    this.#seen = (await this.payloads()).length;
  }

  /** Every auth email queued since the last {@link clear}, oldest first. */
  async all(): Promise<EmailMessage[]> {
    const events = (await this.payloads())
      .slice(this.#seen)
      .map((payload) => authEmailEventSchema.parse(payload));
    if (events.length === 0) {
      return [];
    }
    const recipients = await this.#db
      .select()
      .from(users)
      .where(
        inArray(
          users.id,
          events.map((event) => event.userId),
        ),
      );

    return events.map((event) => {
      const recipient = recipients.find((row) => row.id === event.userId);
      if (recipient === undefined) {
        throw new Error(`an auth email was queued for ${event.userId}, who does not exist`);
      }
      return composeAuthEmail(event, recipient, this.#keyring);
    });
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  async last(): Promise<EmailMessage> {
    const message = (await this.all()).at(-1);
    if (message === undefined) {
      throw new Error('no auth email was queued');
    }

    return message;
  }
}
