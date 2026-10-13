import {
  contactIdentities,
  contacts,
  type DbTransaction,
  ticketParticipants,
  uuidv7,
} from '@helpdock/db';
import { normaliseEmail } from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';

async function importedCcContact(
  tx: DbTransaction,
  scope: { brandId: string; email: string },
): Promise<string> {
  const [identity] = await tx
    .select()
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.brandId, scope.brandId),
        eq(contactIdentities.kind, 'email'),
        eq(contactIdentities.value, scope.email),
      ),
    );
  if (identity) {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, identity.contactId), eq(contacts.brandId, scope.brandId)));
    if (!contact || contact.anonymisedAt || contact.mergedIntoId)
      throw new ImportLoadError('target-unavailable');
    return contact.id;
  }
  const id = uuidv7();
  await tx.insert(contacts).values({ id, brandId: scope.brandId, name: scope.email });
  const inserted = await tx
    .insert(contactIdentities)
    .values({
      brandId: scope.brandId,
      contactId: id,
      kind: 'email',
      value: scope.email,
      source: 'import',
      verified: false,
    })
    .onConflictDoNothing()
    .returning({ id: contactIdentities.id });
  if (!inserted.length) throw new ImportLoadError('identity-ambiguous');
  return id;
}

/** Email-owner locks use the profile loader's namespace and one sorted order. */
export async function loadImportedParticipants(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<void> {
  const addresses = [
    ...new Set(
      input.record.ccEmails.map((email) => {
        const normalized = normaliseEmail(email);
        if (!normalized.ok) throw new ImportLoadError('mapping-invalid');
        return normalized.value;
      }),
    ),
  ].sort();
  for (const email of addresses)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.brandId}:email:${email}`}, 20))`,
    );
  for (const address of addresses) {
    const contactId = await importedCcContact(tx, { brandId: input.brandId, email: address });
    if (contactId === input.resolved.contactId) continue;
    await tx
      .insert(ticketParticipants)
      .values({
        brandId: input.brandId,
        departmentId: input.resolved.departmentId,
        ticketId,
        contactId,
        address,
        source: 'email',
      })
      .onConflictDoNothing();
  }
}
