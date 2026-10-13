import {
  META_HUMAN_AGENT_WINDOW_MS,
  META_REPLY_WINDOW_MS,
  type MetaPlatform,
  type ReplyWindowView,
} from '@helpdock/schemas';

/**
 * The three Meta tickets of the fixture (`Admin/Ticket-Meta`, M10-08), one per
 * platform, and the reply window each is in. A leaf module on purpose: the
 * ticket fixture (`tickets/mock-api.ts`) refuses a reply the window would
 * refuse, and the Meta fixture (`meta/mock-api.ts`) answers the window to the
 * strip, and both must read the same anchors without importing each other.
 *
 * | Ticket | Platform | The customer last wrote | The window now |
 * |---|---|---|---|
 * | HD-1040 | WhatsApp | 66 minutes ago | open, 22 h 54 m left |
 * | HD-1038 | Messenger | 30 hours ago | Human Agent, 5 d 18 h left |
 * | HD-1036 | Instagram | 8 days ago | closed |
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MOCK_TICKET_WHATSAPP = '0192c3f0-1a2b-7c3d-8e4f-000000001040';
export const MOCK_TICKET_MESSENGER = '0192c3f0-1a2b-7c3d-8e4f-000000001038';
export const MOCK_TICKET_INSTAGRAM = '0192c3f0-1a2b-7c3d-8e4f-000000001036';

/** The contacts of those tickets, which `MockContactsApi` also holds. */
export const MOCK_CONTACT_DANIEL = '0192c3f0-1a2b-7c3d-8e4f-0000000000c6';
export const MOCK_CONTACT_MESSENGER_USER = '0192c3f0-1a2b-7c3d-8e4f-0000000000c7';
export const MOCK_CONTACT_SARA = '0192c3f0-1a2b-7c3d-8e4f-0000000000c8';

/** `0192c3f0-…-<prefix><n in hex>`: the fixture's ids, kept apart by prefix. */
const idOf = (prefix: string, n: number): string =>
  `0192c3f0-1a2b-7c3d-8e4f-${prefix}${n.toString(16).padStart(12 - prefix.length, '0')}`;

/** A message of the three threads, by its number in `tickets/mock-meta-seed.ts`. */
export const metaMessageId = (n: number): string => idOf('00000009', n);
/** A delivery of the three threads. */
export const metaDeliveryId = (n: number): string => idOf('0000000a', n);
/** A file of the three threads. */
export const metaAttachmentId = (n: number): string => idOf('0000000b', n);

/** The replies whose deliveries the tests look at. */
export const MOCK_META_REPLY_FAILED = metaMessageId(0x23);
export const MOCK_META_REPLY_REFUSED = metaMessageId(0x15);
export const MOCK_META_REPLY_SENDING = metaMessageId(0x18);

export interface MockMetaConversation {
  readonly platform: MetaPlatform;
  /** How long before the fixture was built the customer last wrote. */
  readonly lastInboundAgo: number;
  /** Whether the account's Human Agent switch is on (Messenger and Instagram only). */
  readonly humanAgent: boolean;
}

export const MOCK_META_CONVERSATIONS: Readonly<Record<string, MockMetaConversation>> = {
  [MOCK_TICKET_WHATSAPP]: { platform: 'whatsapp', lastInboundAgo: 66 * MINUTE, humanAgent: false },
  [MOCK_TICKET_MESSENGER]: {
    platform: 'messenger',
    lastInboundAgo: 30 * HOUR,
    humanAgent: true,
  },
  [MOCK_TICKET_INSTAGRAM]: {
    platform: 'instagram',
    lastInboundAgo: 8 * DAY + 55 * MINUTE,
    humanAgent: false,
  },
};

/**
 * The window for a person writing at `now`, by the rules of DOMAIN-RULES §2.6:
 * 24 hours from the customer's last message, then 7 days on Messenger and
 * Instagram when the account's switch is on. The api's own function is in
 * `@helpdock/channels`, which the admin does not depend on; the fixture only
 * needs the shape the strip reads.
 */
export const mockReplyWindow = (
  conversation: MockMetaConversation,
  epoch: number,
  now: number,
): ReplyWindowView => {
  const anchor = epoch - conversation.lastInboundAgo;
  const openUntil = anchor + META_REPLY_WINDOW_MS;
  if (now < openUntil) {
    return { state: 'open', closesAt: new Date(openUntil).toISOString() };
  }
  const extendedUntil = anchor + META_HUMAN_AGENT_WINDOW_MS;
  if (conversation.platform !== 'whatsapp' && conversation.humanAgent) {
    return now < extendedUntil
      ? { state: 'human_agent', closesAt: new Date(extendedUntil).toISOString() }
      : { state: 'closed', closedAt: new Date(extendedUntil).toISOString() };
  }

  return { state: 'closed', closedAt: new Date(openUntil).toISOString() };
};

/** When the customer last wrote, for a refusal's `anchorAt`. */
export const mockAnchorAt = (conversation: MockMetaConversation, epoch: number): string =>
  new Date(epoch - conversation.lastInboundAgo).toISOString();
