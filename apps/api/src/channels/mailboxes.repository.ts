import {
  type Db,
  type DbTransaction,
  departments,
  type InboundParseSettings as InboundParseSettingsRow,
  inboundParseSettings,
  type Mailbox as MailboxRow,
  mailboxes,
  type NewMailbox,
  users,
} from '@helpdock/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * The `mailboxes` and `inbound_parse_settings` tables (M2-02, M2-03, M2-08).
 *
 * Every method but two takes the caller's transaction, so row-level security
 * decides what it sees. The two that do not — {@link findByAddresses} and
 * {@link listPollable} — answer questions asked *before* a brand is known: an
 * inbound-parse request names only a recipient, and a worker booting has to
 * re-register every brand's poller. Both are install-scope reads that put
 * every brand id in the context explicitly, the shape `DomainCheckService` and
 * the outbox relay use, and both read this one table and nothing else.
 */

export interface MailboxWithNames {
  readonly mailbox: MailboxRow;
  readonly departmentName: string;
  readonly passwordUpdatedByName: string | null;
}

/** Enough to route a message or schedule a poll, without a tenant context. */
export interface MailboxLocator {
  readonly id: string;
  readonly brandId: string;
  readonly address: string;
  readonly method: MailboxRow['method'];
  readonly pollIntervalSeconds: number;
}

const locator = {
  id: mailboxes.id,
  brandId: mailboxes.brandId,
  address: mailboxes.address,
  method: mailboxes.method,
  pollIntervalSeconds: mailboxes.pollIntervalSeconds,
};

export class MailboxesRepository {
  async list(tx: DbTransaction): Promise<MailboxWithNames[]> {
    const rows = await tx
      .select({
        mailbox: mailboxes,
        departmentName: departments.name,
        passwordUpdatedByName: users.name,
      })
      .from(mailboxes)
      .innerJoin(departments, eq(departments.id, mailboxes.departmentId))
      .leftJoin(users, eq(users.id, mailboxes.imapPasswordUpdatedBy))
      .orderBy(asc(mailboxes.address));

    return rows;
  }

  async find(tx: DbTransaction, id: string): Promise<MailboxWithNames | undefined> {
    const rows = await tx
      .select({
        mailbox: mailboxes,
        departmentName: departments.name,
        passwordUpdatedByName: users.name,
      })
      .from(mailboxes)
      .innerJoin(departments, eq(departments.id, mailboxes.departmentId))
      .leftJoin(users, eq(users.id, mailboxes.imapPasswordUpdatedBy))
      .where(eq(mailboxes.id, id))
      .limit(1);

    return rows[0];
  }

  /** The bare row, for the poller and the inbound pipeline. */
  async row(tx: DbTransaction, id: string): Promise<MailboxRow | undefined> {
    const rows = await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);

    return rows[0];
  }

  /** Whether a department of this brand exists, as the transaction can see it. */
  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return rows.length > 0;
  }

  /** Null when the address is taken — by this brand or, under the unique index, by another. */
  async insert(tx: DbTransaction, values: NewMailbox): Promise<MailboxRow | undefined> {
    const rows = await tx
      .insert(mailboxes)
      .values(values)
      .onConflictDoNothing({ target: mailboxes.address })
      .returning();

    return rows[0];
  }

  async update(
    tx: DbTransaction,
    id: string,
    values: Partial<NewMailbox>,
  ): Promise<MailboxRow | undefined> {
    const rows = await tx
      .update(mailboxes)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(mailboxes.id, id))
      .returning();

    return rows[0];
  }

  async delete(tx: DbTransaction, id: string): Promise<MailboxRow | undefined> {
    const rows = await tx.delete(mailboxes).where(eq(mailboxes.id, id)).returning();

    return rows[0];
  }

  // -------------------------------------------------------------- inbound parse

  async parseSettings(
    tx: DbTransaction,
    brandId: string,
  ): Promise<InboundParseSettingsRow | undefined> {
    const rows = await tx
      .select()
      .from(inboundParseSettings)
      .where(eq(inboundParseSettings.brandId, brandId))
      .limit(1);

    return rows[0];
  }

  async upsertParseSettings(
    tx: DbTransaction,
    brandId: string,
    values: Partial<Omit<InboundParseSettingsRow, 'brandId'>>,
  ): Promise<void> {
    await tx
      .insert(inboundParseSettings)
      .values({ brandId, ...values })
      .onConflictDoUpdate({ target: inboundParseSettings.brandId, set: values });
  }

  // ------------------------------------------------------- install-scope reads

  /**
   * The mailbox the first matching recipient names, across every brand.
   *
   * `principalId` names the path in the transaction so the database's own
   * logging says who asked; the read is not written to `audit_log` because a
   * stranger posting to the endpoint would otherwise fill it (the reason
   * `DomainCheckService` gives), and the request is recorded on the brand's
   * `inbound_parse_settings` row once the brand is known.
   */
  async findByAddresses(db: Db, addresses: readonly string[]): Promise<MailboxLocator | undefined> {
    if (addresses.length === 0) {
      return undefined;
    }

    const rows = await withAllBrands(db, 'inbound-parse.route', (tx) =>
      tx
        .select(locator)
        .from(mailboxes)
        .where(inArray(mailboxes.address, [...addresses])),
    );
    const byAddress = new Map(rows.map((row) => [row.address, row]));

    return addresses.map((address) => byAddress.get(address)).find((row) => row !== undefined);
  }

  /** Every IMAP mailbox of every brand, for the worker to schedule on boot (DOMAIN-RULES §10). */
  async listPollable(db: Db): Promise<MailboxLocator[]> {
    return withAllBrands(db, 'email.poll.schedule', (tx) =>
      tx
        .select(locator)
        .from(mailboxes)
        .where(and(eq(mailboxes.method, 'imap')))
        .orderBy(asc(mailboxes.id)),
    );
  }
}
