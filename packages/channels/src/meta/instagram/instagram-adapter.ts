import {
  MetaChannelAdapter,
  type MetaInboundInput,
  type MetaInboundMessage,
  toMetaInboundMessage,
} from '../inbound-message.js';

/**
 * The Instagram channel's {@link ChannelAdapter} (M10-01). An Instagram
 * customer is an Instagram-scoped id, meaningful only beside the professional
 * account it wrote to, so the identity is `<account id>:<igsid>` (DOMAIN-RULES
 * §4.7); the dedupe key is the `mid`. Stories the customer replied to or
 * mentioned the account in arrive as a line naming the story and the story's
 * media as a file to fetch.
 */

/** A classified Instagram message in the shape every channel files. */
export const toInstagramInboundMessage = (
  input: MetaInboundInput,
  receivedAt: Date,
): MetaInboundMessage => toMetaInboundMessage('instagram', input, receivedAt);

export class InstagramChannelAdapter extends MetaChannelAdapter {
  constructor(options: { readonly now?: () => Date } = {}) {
    super('instagram', options);
  }
}
