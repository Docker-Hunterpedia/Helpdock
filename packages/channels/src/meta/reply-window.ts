import {
  META_HUMAN_AGENT_WINDOW_MS,
  META_REPLY_WINDOW_MS,
  type MetaPlatform,
} from '@helpdock/schemas';

/**
 * Whether a reply may be written to a Meta customer now (DOMAIN-RULES §2.6).
 * One pure function, so the compose-time check, the `meta.send` job, the ticket
 * view and the strip under the thread all ask the same question and cannot
 * disagree by a minute.
 *
 * - **24 hours** from the customer's last message, on every platform. The
 *   window is open while `now` is before the anchor plus 24 hours and closed
 *   from that instant on: a reply at 23 h 59 m goes out, one at 24 h 00 m 00 s
 *   does not.
 * - **7 days** on Messenger and Instagram, when the account's Human Agent
 *   switch is on and the reply is a person's. WhatsApp has no such extension.
 * - Otherwise **closed**.
 */
export interface ReplyWindowInput {
  readonly platform: MetaPlatform;
  /** `meta_conversations.last_inbound_at`; null when the customer never wrote. */
  readonly lastInboundAt: Date | null;
  readonly humanAgentEnabled: boolean;
  /** A staff member. False for AI, rules, auto-responders, surveys. */
  readonly personAuthored: boolean;
  readonly now: Date;
}

export type ReplyWindow =
  | { readonly state: 'open'; readonly closesAt: Date }
  | { readonly state: 'human_agent'; readonly closesAt: Date }
  /** `closedAt` is null when the customer never wrote, so there was never a window. */
  | { readonly state: 'closed'; readonly closedAt: Date | null };

/** Whether Messenger or Instagram may extend the window for this reply. */
const mayExtend = (input: ReplyWindowInput): boolean =>
  input.platform !== 'whatsapp' && input.humanAgentEnabled && input.personAuthored;

export const replyWindow = (input: ReplyWindowInput): ReplyWindow => {
  const { lastInboundAt, now } = input;
  if (lastInboundAt === null) {
    return { state: 'closed', closedAt: null };
  }

  const anchor = lastInboundAt.getTime();
  const openUntil = new Date(anchor + META_REPLY_WINDOW_MS);
  if (now.getTime() < openUntil.getTime()) {
    return { state: 'open', closesAt: openUntil };
  }

  if (mayExtend(input)) {
    const extendedUntil = new Date(anchor + META_HUMAN_AGENT_WINDOW_MS);
    return now.getTime() < extendedUntil.getTime()
      ? { state: 'human_agent', closesAt: extendedUntil }
      : { state: 'closed', closedAt: extendedUntil };
  }

  return { state: 'closed', closedAt: openUntil };
};

/** The view the ticket route and the strip read: the same window with ISO dates. */
export const replyWindowView = (
  window: ReplyWindow,
):
  | { readonly state: 'open' | 'human_agent'; readonly closesAt: string }
  | { readonly state: 'closed'; readonly closedAt: string | null } => {
  switch (window.state) {
    case 'open':
    case 'human_agent':
      return { state: window.state, closesAt: window.closesAt.toISOString() };
    case 'closed':
      return {
        state: 'closed',
        closedAt: window.closedAt === null ? null : window.closedAt.toISOString(),
      };
  }
};
