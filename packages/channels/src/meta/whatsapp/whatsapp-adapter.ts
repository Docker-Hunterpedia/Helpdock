import {
  MetaChannelAdapter,
  type MetaInboundInput,
  type MetaInboundMessage,
  toMetaInboundMessage,
} from '../inbound-message.js';

/**
 * The WhatsApp channel's {@link ChannelAdapter} (M10-01). A WhatsApp message
 * arrives with a business-scoped user id, which is the contact's identity
 * (`from.value`), and usually the customer's number (`meta.waId`), which the
 * router records as a verified phone (DOMAIN-RULES §4.7). The dedupe key is the
 * `wamid`.
 */

/** A classified WhatsApp message in the shape every channel files. */
export const toWhatsAppInboundMessage = (
  input: MetaInboundInput,
  receivedAt: Date,
): MetaInboundMessage => toMetaInboundMessage('whatsapp', input, receivedAt);

export class WhatsAppChannelAdapter extends MetaChannelAdapter {
  constructor(options: { readonly now?: () => Date } = {}) {
    super('whatsapp', options);
  }
}
