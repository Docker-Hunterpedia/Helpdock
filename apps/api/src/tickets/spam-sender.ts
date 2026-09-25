import type { ContactIdentityKind, SpamSenderIdentity, TicketChannel } from '@helpdock/schemas';

/**
 * Who "Block sender" blocks (M1-11): one of the ticket's contact identifiers,
 * chosen by the channel the ticket came in on.
 *
 * A contact may hold an address, a phone number and a Telegram chat at once,
 * and blocking all three because one channel sent spam would silence a person
 * everywhere for one bad thread. So the identifier that matches the channel
 * wins — a Telegram ticket blocks the chat, an email ticket the address — and a
 * channel with no identifier of its own (chat, form, api, manual) falls back to
 * the address, then the phone, then the chat. A visitor id or an external id is
 * never blocked: neither says who a person is to anybody outside this brand.
 */

const PREFERENCE: Readonly<Record<TicketChannel, readonly ContactIdentityKind[]>> = {
  email: ['email', 'phone', 'telegram'],
  telegram: ['telegram', 'email', 'phone'],
  chat: ['email', 'phone', 'telegram'],
  form: ['email', 'phone', 'telegram'],
  api: ['email', 'phone', 'telegram'],
  manual: ['email', 'phone', 'telegram'],
};

export interface IdentityRow {
  readonly kind: ContactIdentityKind;
  /** Already normalised: `contact_identities` stores nothing else. */
  readonly value: string;
  readonly createdAt: Date;
}

export const senderOf = (
  channel: TicketChannel,
  identities: readonly IdentityRow[],
): SpamSenderIdentity | null => {
  // Oldest first, so the identifier the contact was created with wins over one
  // an agent added later.
  const ordered = [...identities].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const kind of PREFERENCE[channel]) {
    const found = ordered.find((identity) => identity.kind === kind);
    if (found !== undefined && (kind === 'email' || kind === 'phone' || kind === 'telegram')) {
      return { kind, value: found.value };
    }
  }

  return null;
};
