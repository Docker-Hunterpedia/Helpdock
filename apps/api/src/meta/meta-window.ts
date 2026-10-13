import {
  GRAPH_ERROR_CODES,
  type ReplyWindow,
  replyWindow,
  WINDOW_CLOSED_SUBCODE,
} from '@helpdock/channels';
import type { MetaAccount, MetaConversation } from '@helpdock/db';
import type { MetaPlatform, MetaRefusalDetails } from '@helpdock/schemas';

/**
 * The reply window of DOMAIN-RULES §2.6 is one pure function, `replyWindow` in
 * `@helpdock/channels` (M10-01), which the compose-time hook, the `meta.send`
 * job, the ticket view and the strip all ask. This file re-exports its type and
 * its view and adds the one adapter every caller would otherwise write for
 * itself: from a conversation row and an account row to the function's input,
 * so none of them can read a different column.
 */
export { type ReplyWindow, replyWindowView } from '@helpdock/channels';

export interface ConversationWindowInput {
  readonly conversation: Pick<MetaConversation, 'lastInboundAt'>;
  readonly account: Pick<MetaAccount, 'platform' | 'humanAgentEnabled'>;
  /** A staff member wrote the reply. False for the assistant, rules and surveys. */
  readonly personAuthored: boolean;
  readonly now: Date;
}

export const conversationWindow = ({
  conversation,
  account,
  personAuthored,
  now,
}: ConversationWindowInput): ReplyWindow =>
  replyWindow({
    platform: account.platform,
    lastInboundAt: conversation.lastInboundAt,
    humanAgentEnabled: account.humanAgentEnabled,
    personAuthored,
    now,
  });

/**
 * The code a closed window carries on each platform: WhatsApp's `131047`, and
 * code `10` with sub-code `2018278` on Messenger and Instagram (written as
 * Graph's errors are in `last_error`, `10/2018278`). A delivery Helpdock
 * refuses itself records the same code a delivery Meta refuses does, so the
 * thread reads one way (ADR 0025, 8).
 */
export const windowClosedCode = (platform: MetaPlatform): string =>
  platform === 'whatsapp'
    ? String(GRAPH_ERROR_CODES.window_closed[0])
    : `10/${String(WINDOW_CLOSED_SUBCODE)}`;

/** What a `reply-window-closed` refusal tells the composer (M10-02's `MetaRefusalDetails`). */
export const closedWindowDetails = (
  platform: MetaPlatform,
  conversation: Pick<MetaConversation, 'lastInboundAt'>,
  window: Extract<ReplyWindow, { state: 'closed' }>,
): MetaRefusalDetails => ({
  platform,
  anchorAt: conversation.lastInboundAt?.toISOString() ?? null,
  closedAt: window.closedAt?.toISOString() ?? null,
});
