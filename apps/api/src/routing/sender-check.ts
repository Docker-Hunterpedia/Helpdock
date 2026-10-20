import { automatedReason, type InboundEmail } from '@helpdock/channels';
import type { DbTransaction } from '@helpdock/db';
import { type MetaPlatform, normaliseIdentity, type RoutingEntryKind } from '@helpdock/schemas';
import { metaBlockEntry } from '../meta/meta-inbound-gate.js';
import { findBlockingEntry, type InboundSender } from '../ticketing/sender-gate.js';
import type { ResolvedEntry } from './entry-points.js';
import type { RoutingRepository } from './routing.repository.js';

/**
 * Who the sample message is from, as the entry point's inbound path would know
 * them, and whether that path would stop it before a ticket exists. Reads only:
 * the gate that counts a drop is not called (M14-09).
 */

/** The identifier kind each door knows a sender by. */
const IDENTITY_KIND: Readonly<Record<RoutingEntryKind, InboundSender['kind']>> = {
  mailbox: 'email',
  widget: 'email',
  web_form: 'email',
  api_key: 'email',
  telegram_bot: 'telegram',
  meta_account: 'whatsapp',
};

/** Which doors consult the block list: the widget and the API never do. */
const GATED: ReadonlySet<RoutingEntryKind> = new Set([
  'mailbox',
  'web_form',
  'telegram_bot',
  'meta_account',
]);

export interface SenderIdentity {
  readonly kind: InboundSender['kind'];
  /** Normalised, as `contact_identities` stores it; null when the sample gave none usable. */
  readonly value: string | null;
}

export const senderIdentity = (entry: ResolvedEntry, from: string): SenderIdentity => {
  const kind =
    entry.platform === null ? IDENTITY_KIND[entry.entry] : (entry.platform satisfies MetaPlatform);
  const raw =
    entry.platform === null
      ? from
      : metaBlockEntry({ platform: entry.platform, externalId: entry.externalId ?? '' }, from)
          .value;
  const normalised = normaliseIdentity(kind, raw);

  return { kind, value: normalised.ok ? normalised.value : null };
};

/** Whether a block-list entry holds this sender. Counts nothing. */
export const isBlocked = async (
  tx: DbTransaction,
  brandId: string,
  entry: ResolvedEntry,
  identity: SenderIdentity,
): Promise<boolean> => {
  if (!GATED.has(entry.entry) || identity.value === null) {
    return false;
  }
  const sender: InboundSender = { kind: identity.kind, value: identity.value };

  return (await findBlockingEntry(tx, brandId, sender)) !== undefined;
};

/**
 * DOMAIN-RULES §4.3: a `noreply@` sender never opens a ticket unless the
 * mailbox allow-lists it. Only the address can be judged from a sample; the
 * headers a real message carries (`Auto-Submitted`, `Precedence`) are not asked
 * for, so a real message can be stopped where this one is not.
 */
export const isAutomated = (entry: ResolvedEntry, identity: SenderIdentity): boolean => {
  if (entry.entry !== 'mailbox' || identity.value === null) {
    return false;
  }
  if (entry.automatedAllowlist.includes(identity.value)) {
    return false;
  }
  const email: InboundEmail = {
    messageId: 'dry-run',
    inReplyTo: null,
    references: [],
    from: { address: identity.value, name: null },
    to: [],
    cc: [],
    subject: '',
    date: null,
    html: null,
    text: null,
    headers: new Map(),
    attachments: [],
  };

  return automatedReason(email) !== null;
};

export const contactOf = async (
  repository: RoutingRepository,
  tx: DbTransaction,
  brandId: string,
  identity: SenderIdentity,
) =>
  identity.value === null
    ? undefined
    : repository.contactByIdentity(tx, brandId, identity.kind, identity.value);
