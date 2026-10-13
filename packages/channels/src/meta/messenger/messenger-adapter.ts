import {
  type MetaInboundInput,
  type MetaInboundMessage,
  toMetaInboundMessage,
} from '../inbound-message.js';

/**
 * The Messenger channel's inbound message (M10-01). A Messenger customer
 * is a page-scoped id, meaningful only beside the Page it wrote to, so the
 * identity is `<page id>:<psid>` (DOMAIN-RULES §4.7); the dedupe key is the
 * `mid`. Messenger sends no name without a reviewed feature, so `from.name` is
 * null until the inbound service fetches one.
 */

/** A classified Messenger message in the shape every channel files. */
export const toMessengerInboundMessage = (
  input: MetaInboundInput,
  receivedAt: Date,
): MetaInboundMessage => toMetaInboundMessage('messenger', input, receivedAt);
