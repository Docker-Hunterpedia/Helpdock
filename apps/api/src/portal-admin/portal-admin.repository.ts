import {
  accounts,
  auditLog,
  brands,
  contactIdentities,
  contacts,
  customerSessions,
  type DbTransaction,
  departments,
  tickets,
} from '@helpdock/db';
import {
  type AccountRole,
  type BrandSettings,
  type PortalVisibility,
  parseBrandSettings,
} from '@helpdock/schemas';
import { and, asc, desc, eq, gt, inArray, isNull, max, notInArray } from 'drizzle-orm';

/**
 * The reads and writes behind the staff side of the customer portal (M21-06),
 * through the request's own transaction. Nothing here selects `token_hash`:
 * the session reads name their columns, so a later column cannot reach a
 * response by accident.
 */

export interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: PortalVisibility;
}

export interface MemberRow {
  readonly contactId: string;
  readonly name: string;
  readonly role: AccountRole;
  readonly email: string | null;
  readonly lastSeenAt: Date | null;
}

export interface ContactPortalRow {
  readonly id: string;
  readonly role: AccountRole;
  readonly hasAccount: boolean;
  readonly visibility: PortalVisibility;
}

export interface SessionRow {
  readonly id: string;
  readonly userAgentFamily: string | null;
  readonly lastSeenAt: Date;
  readonly host: string;
  readonly email: string | null;
}

export interface PortalTicketRow {
  readonly id: string;
  readonly departmentId: string;
  readonly contactId: string | null;
  readonly portalPrivate: boolean;
}

export class PortalAdminRepository {
  async brandSettings(tx: DbTransaction, brandId: string): Promise<BrandSettings | undefined> {
    const rows = await tx
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    return rows[0] === undefined ? undefined : parseBrandSettings(rows[0].settings);
  }

  async writeBrandSettings(
    tx: DbTransaction,
    brandId: string,
    settings: BrandSettings,
  ): Promise<void> {
    await tx.update(brands).set({ settings }).where(eq(brands.id, brandId));
  }

  /** How many of these ids are departments of the brand this transaction is bound to. */
  async countDepartments(tx: DbTransaction, ids: readonly string[]): Promise<number> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(inArray(departments.id, [...ids]));

    return rows.length;
  }

  async account(tx: DbTransaction, accountId: string): Promise<AccountRow | undefined> {
    const rows = await tx
      .select({ id: accounts.id, name: accounts.name, visibility: accounts.portalVisibility })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    return rows[0];
  }

  /** The people filed under an account who can still sign in: not merged away, not erased. */
  async members(tx: DbTransaction, accountId: string): Promise<MemberRow[]> {
    const people = await tx
      .select({ contactId: contacts.id, name: contacts.name, role: contacts.accountRole })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          isNull(contacts.mergedIntoId),
          isNull(contacts.anonymisedAt),
        ),
      )
      .orderBy(asc(contacts.name))
      .limit(500);
    if (people.length === 0) {
      return [];
    }

    const ids = people.map((person) => person.contactId);
    const emails = await tx
      .select({ contactId: contactIdentities.contactId, value: contactIdentities.value })
      .from(contactIdentities)
      .where(
        and(
          inArray(contactIdentities.contactId, ids),
          eq(contactIdentities.kind, 'email'),
          eq(contactIdentities.verified, true),
        ),
      )
      .orderBy(asc(contactIdentities.createdAt));
    const seen = await tx
      .select({
        contactId: customerSessions.contactId,
        lastSeenAt: max(customerSessions.lastSeenAt),
      })
      .from(customerSessions)
      .where(inArray(customerSessions.contactId, ids))
      .groupBy(customerSessions.contactId);

    const emailOf = new Map<string, string>();
    for (const row of emails) {
      if (!emailOf.has(row.contactId)) {
        emailOf.set(row.contactId, row.value);
      }
    }
    const seenAt = new Map(seen.map((row) => [row.contactId, row.lastSeenAt]));

    return people.map((person) => ({
      ...person,
      email: emailOf.get(person.contactId) ?? null,
      lastSeenAt: seenAt.get(person.contactId) ?? null,
    }));
  }

  async setVisibility(
    tx: DbTransaction,
    accountId: string,
    visibility: PortalVisibility,
  ): Promise<void> {
    await tx
      .update(accounts)
      .set({ portalVisibility: visibility })
      .where(eq(accounts.id, accountId));
  }

  /** Sets the role of every listed contact of the account to manager, and every other member to member. */
  async setRoles(
    tx: DbTransaction,
    accountId: string,
    managerIds: readonly string[],
  ): Promise<void> {
    await tx
      .update(contacts)
      .set({ accountRole: 'member' })
      .where(
        and(
          eq(contacts.accountId, accountId),
          managerIds.length === 0 ? undefined : notInArray(contacts.id, [...managerIds]),
        ),
      );
    if (managerIds.length > 0) {
      await tx
        .update(contacts)
        .set({ accountRole: 'manager' })
        .where(and(eq(contacts.accountId, accountId), inArray(contacts.id, [...managerIds])));
    }
  }

  async contact(tx: DbTransaction, contactId: string): Promise<ContactPortalRow | undefined> {
    const rows = await tx
      .select({
        id: contacts.id,
        role: contacts.accountRole,
        accountId: contacts.accountId,
        visibility: accounts.portalVisibility,
      })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(and(eq(contacts.id, contactId), isNull(contacts.mergedIntoId)))
      .limit(1);
    const row = rows[0];

    return row === undefined
      ? undefined
      : {
          id: row.id,
          role: row.role,
          hasAccount: row.accountId !== null,
          visibility: row.visibility ?? 'own',
        };
  }

  /** The live sessions of a contact, newest use first. */
  async sessions(tx: DbTransaction, contactId: string, now: Date): Promise<SessionRow[]> {
    return tx
      .select({
        id: customerSessions.id,
        userAgentFamily: customerSessions.userAgentFamily,
        lastSeenAt: customerSessions.lastSeenAt,
        host: customerSessions.host,
        email: contactIdentities.value,
      })
      .from(customerSessions)
      .leftJoin(contactIdentities, eq(contactIdentities.id, customerSessions.contactIdentityId))
      .where(and(eq(customerSessions.contactId, contactId), gt(customerSessions.expiresAt, now)))
      .orderBy(desc(customerSessions.lastSeenAt))
      .limit(100);
  }

  /** The system path only: the session policies let nobody else delete. */
  async deleteSessions(tx: DbTransaction, brandId: string, contactId: string): Promise<number> {
    const gone = await tx
      .delete(customerSessions)
      .where(and(eq(customerSessions.brandId, brandId), eq(customerSessions.contactId, contactId)))
      .returning({ id: customerSessions.id });

    return gone.length;
  }

  async ticket(tx: DbTransaction, ticketId: string): Promise<PortalTicketRow | undefined> {
    const rows = await tx
      .select({
        id: tickets.id,
        departmentId: tickets.departmentId,
        contactId: tickets.contactId,
        portalPrivate: tickets.portalPrivate,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    return rows[0];
  }

  async setPortalPrivate(tx: DbTransaction, ticketId: string, value: boolean): Promise<void> {
    await tx
      .update(tickets)
      .set({ portalPrivate: value, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
  }

  async audit(
    tx: DbTransaction,
    entry: {
      readonly brandId: string;
      readonly actorId: string;
      readonly action: string;
      readonly targetType: 'brand' | 'account' | 'contact' | 'ticket';
      readonly targetId: string;
      readonly meta: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLog).values({ ...entry, actorType: 'staff' });
  }
}
