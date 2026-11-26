import { accounts, contacts, type DbTransaction } from '@helpdock/db';
import type { TicketPortalView } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';

/**
 * The details panel's "Customer portal" card (`Admin/Account-PortalVisibility`
 * board, M21-06): the private mark, the requester's name and, when the ticket
 * is not private and the requester's account shares tickets, the account's name
 * and who in it can see this one. It mirrors the policy of ADR 0060 in words
 * and never decides access: the row-level policy does.
 *
 * Contacts and accounts are brand-scoped, so the reads need no department
 * context. A merged-away requester is shown by its own name, as the ticket
 * header does.
 */
export const readTicketPortalView = async (
  tx: DbTransaction,
  ticket: { readonly portalPrivate: boolean; readonly contactId: string | null },
): Promise<TicketPortalView> => {
  if (ticket.contactId === null) {
    return { private: ticket.portalPrivate, requester: null, company: null };
  }

  const rows = await tx
    .select({
      name: contacts.name,
      accountName: accounts.name,
      visibility: accounts.portalVisibility,
    })
    .from(contacts)
    .leftJoin(accounts, eq(accounts.id, contacts.accountId))
    .where(eq(contacts.id, ticket.contactId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { private: ticket.portalPrivate, requester: null, company: null };
  }

  const shares = row.accountName !== null && row.visibility !== null && row.visibility !== 'own';

  return {
    private: ticket.portalPrivate,
    requester: row.name,
    company:
      !ticket.portalPrivate && shares
        ? { name: row.accountName ?? '', audience: row.visibility === 'all' ? 'all' : 'managers' }
        : null,
  };
};
