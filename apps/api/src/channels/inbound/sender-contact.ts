import type { EmailInboundMessage } from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import {
  attachVerifiedIdentity,
  findByIdentity,
  findOrCreateByAddress,
  findOrCreateContactByIdentity,
  requireNormalised,
} from '../../contacts/identity.js';

/**
 * The contact an inbound email's `From` belongs to (DOMAIN-RULES §4.4).
 *
 * Mail the receiving server reported as not matching its From address
 * (`misaligned`) is resolved by address, as a Cc is: the contact that holds the
 * address, verified or not, or one unverified contact for it. It never
 * verifies, moves or merges anything, and it never makes a second contact for
 * an address, so a real customer whose mail soft-fails SPF keeps their own
 * contact and a reply to the ticket still has an address to go to.
 *
 * Anything else is a verified claim, as before. The one addition: an address
 * that only unreported or misaligned mail has used so far is held by an
 * unverified contact, which the first sound message verifies in place instead
 * of opening a second contact beside it.
 */
export const resolveSenderContact = async (
  tx: DbTransaction,
  brandId: string,
  message: EmailInboundMessage,
): Promise<string> => {
  if (message.email.senderCheck === 'misaligned') {
    const { contact } = await findOrCreateByAddress(
      tx,
      brandId,
      message.from.value,
      'email.unauthenticated',
    );
    return contact.id;
  }

  const held = await findByIdentity(
    tx,
    brandId,
    'email',
    requireNormalised('email', message.from.value),
  );
  if (held !== undefined && !held.verified && held.source === 'email.unauthenticated') {
    await attachVerifiedIdentity(tx, brandId, held.contactId, {
      kind: 'email',
      value: held.value,
      source: 'email.inbound',
    });
    return held.contactId;
  }

  const { contact } = await findOrCreateContactByIdentity(
    tx,
    brandId,
    { kind: 'email', value: message.from.value, source: 'email.inbound' },
    message.from.name === null ? {} : { name: message.from.name },
  );
  return contact.id;
};
