import {
  contactIdentities,
  contacts,
  type DbTransaction,
  ticketParticipants,
  uuidv7,
} from '@helpdock/db';
import { normaliseEmail } from '@helpdock/schemas';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';
import { validatedImportedCustom } from './custom-values.js';

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
  const custom = await validatedImportedCustom(tx, {
    brandId: scope.brandId,
    target: 'contact',
    custom: {},
    operation: 'create',
  });
  await tx.insert(contacts).values({ id, brandId: scope.brandId, name: scope.email, custom });
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
  const desired = new Set<string>();
  for (const address of addresses) {
    const contactId = await importedCcContact(tx, { brandId: input.brandId, email: address });
    if (contactId === input.resolved.contactId) continue;
    desired.add(contactId);
    await tx
      .insert(ticketParticipants)
      .values({
        brandId: input.brandId,
        departmentId: input.resolved.departmentId,
        ticketId,
        contactId,
        address,
        source: 'import',
      })
      .onConflictDoUpdate({
        target: [ticketParticipants.ticketId, ticketParticipants.contactId],
        set: { address },
        setWhere: sql`${ticketParticipants.source} = 'import' AND ${ticketParticipants.address} IS NULL`,
      });
  }
  // Email relationships take precedence over identity-only CCs for the same contact.
  for (const contactId of await loadMappedCcContacts(tx, input, ticketId)) desired.add(contactId);
  await tx
    .delete(ticketParticipants)
    .where(
      and(
        eq(ticketParticipants.brandId, input.brandId),
        eq(ticketParticipants.ticketId, ticketId),
        eq(ticketParticipants.source, 'import'),
        desired.size ? notInArray(ticketParticipants.contactId, [...desired]) : undefined,
      ),
    );
}

async function loadMappedCcContacts(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<string[]> {
  const desired: string[] = [];
  const requested = new Set(input.record.ccExternalIds ?? []);
  for (const mapping of input.resolved.ccContacts) {
    if (!requested.has(mapping.externalId)) throw new ImportLoadError('mapping-invalid');
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.brandId, input.brandId),
          eq(contacts.id, mapping.contactId),
          isNull(contacts.anonymisedAt),
          isNull(contacts.mergedIntoId),
        ),
      );
    if (!contact) throw new ImportLoadError('target-unavailable');
    if (contact.id === input.resolved.contactId) continue;
    desired.push(contact.id);
    await tx
      .insert(ticketParticipants)
      .values({
        brandId: input.brandId,
        departmentId: input.resolved.departmentId,
        ticketId,
        contactId: contact.id,
        address: null,
        source: 'import',
      })
      .onConflictDoNothing();
  }
  return desired;
}
