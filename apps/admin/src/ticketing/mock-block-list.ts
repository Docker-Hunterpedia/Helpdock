import type { BlockedSender, BlockedSenderKind, SpamSenderIdentity } from '@helpdock/schemas';
import { domainCovers, domainOfAddress, normaliseBlockedSender } from '@helpdock/schemas';
import { TicketingError } from './api.js';

/**
 * The block list the two fixtures share (M1-11): `MockTicketingApi` draws it
 * on the Spam tab, and `MockTicketsApi` writes to it when "Mark as spam" is
 * ticked, so a sender blocked from a ticket shows up on the tab — as it does
 * against a real install, where both are one table.
 *
 * The rules are the api's, in miniature: values are normalised by the same
 * `@helpdock/schemas` function, the brand's own domain is refused, and a second
 * block of one sender is refused on the tab and answered idempotently from a
 * ticket.
 */

/** What the fixture brand sends from. The artboard's error names this domain. */
export const MOCK_OWN_DOMAIN = 'helpdock.com';

const at = (daysAgo: number): string =>
  new Date(Date.UTC(2026, 8, 20, 9, 0, 0) - daysAgo * 24 * 60 * 60 * 1000).toISOString();

/** The four rows of the `Admin/Ticketing › Spam` artboard. */
const seedRows = (): BlockedSender[] => [
  row('01', 'email', 'spam@promo-deals.biz', 'Lina', at(2), 41),
  row('02', 'domain', 'promo-deals.biz', 'Omar', at(8), 112),
  row('03', 'phone', '+15550100', 'Lina', at(18), 3),
  // The artboard prints `@crypto_bot_9`; a chat is stored as the id the Bot
  // API gives, so the fixture holds one.
  row('04', 'telegram', '728431906', 'Sara', at(23), 9),
];

function row(
  suffix: string,
  kind: BlockedSenderKind,
  value: string,
  createdByName: string,
  createdAt: string,
  droppedCount: number,
): BlockedSender {
  return {
    id: `0192c3f0-1a2b-7c3d-8e4f-0000000bb0${suffix}`,
    kind,
    value,
    createdByName,
    sourceTicketId: null,
    droppedCount,
    lastDroppedAt: droppedCount > 0 ? createdAt : null,
    createdAt,
  };
}

export class MockBlockList {
  #rows = seedRows();
  #sequence = 0;
  /** The brand setting "Offer 'Block sender' when marking as spam". */
  offerBlockSender = true;

  list(): BlockedSender[] {
    return [...this.#rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Adds a row. `idempotent` is the ticket path: a sender already listed is
   * answered with its row rather than refused.
   */
  block(
    sender: SpamSenderIdentity,
    { idempotent, sourceTicketId = null }: { idempotent: boolean; sourceTicketId?: string | null },
  ): BlockedSender {
    const normalised = normaliseBlockedSender(sender.kind, sender.value);
    if (!normalised.ok) {
      throw new TicketingError('sender-invalid');
    }

    const key = { kind: sender.kind, value: normalised.value };
    if (this.isOwn(key)) {
      throw new TicketingError('sender-is-own');
    }

    const existing = this.#find(key);
    if (existing !== undefined) {
      if (idempotent) {
        return existing;
      }
      throw new TicketingError('sender-already-blocked');
    }

    this.#sequence += 1;
    const created: BlockedSender = {
      id: `0192c3f0-1a2b-7c3d-8e4f-0000000bb1${String(this.#sequence).padStart(2, '0')}`,
      kind: key.kind,
      value: key.value,
      createdByName: 'Lina Haddad',
      sourceTicketId,
      droppedCount: 0,
      lastDroppedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.#rows = [created, ...this.#rows];

    return created;
  }

  unblock(id: string): void {
    if (!this.#rows.some((candidate) => candidate.id === id)) {
      throw new Error(`no such blocked sender: ${id}`);
    }
    this.#rows = this.#rows.filter((candidate) => candidate.id !== id);
  }

  isOwn({ kind, value }: SpamSenderIdentity): boolean {
    if (kind === 'email') {
      return domainCovers(MOCK_OWN_DOMAIN, domainOfAddress(value));
    }
    if (kind === 'domain') {
      return domainCovers(value, MOCK_OWN_DOMAIN) || domainCovers(MOCK_OWN_DOMAIN, value);
    }

    return false;
  }

  isListed(sender: SpamSenderIdentity): boolean {
    return this.#find(sender) !== undefined;
  }

  #find({ kind, value }: SpamSenderIdentity): BlockedSender | undefined {
    return this.#rows.find((candidate) => candidate.kind === kind && candidate.value === value);
  }
}
