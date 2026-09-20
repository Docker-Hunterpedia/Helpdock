import type { TicketMessage, TicketMessageKind } from '@helpdock/schemas';

/**
 * The composer's half of the delivery contract (DOMAIN-RULES §7).
 *
 * > Every message has a client-generated `client_id` (UUIDv7) and a
 * > server-assigned `seq`… A message is "sent" when the client holds a `seq`.
 *
 * So a send has three states and no fourth: **sending** while the request is
 * out, **sent** the moment a `seq` comes back, and **not sent** when it does
 * not. The third is reached two ways — the request failed, or it has simply
 * been too long — and they are one state on screen because they are one thing
 * to the person: it is not sent, and the button says retry.
 *
 * Nothing here talks to the network or to a clock. The screen owns both; this
 * owns what the list of unacknowledged sends looks like after each thing that
 * can happen to it, which is the part worth testing without a browser.
 */

/** §7: how long a "sending" may stay silent before it is called not sent. */
export const MESSAGE_RETRY_AFTER_MS = 10_000;

export type PendingState = 'sending' | 'failed';

export interface PendingMessage {
  /** The UUIDv7 the composer generated. `(ticket, clientId)` is unique. */
  readonly clientId: string;
  readonly kind: Exclude<TicketMessageKind, 'system' | 'ai'>;
  readonly bodyHtml: string;
  readonly bodyText: string;
  /**
   * What was uploaded and is going with it (M1-10). Held on the send rather
   * than beside it, because a retry has to carry the same files: the api links
   * them in the message's own transaction and refuses the whole send if one of
   * them cannot be linked.
   */
  readonly attachmentIds: readonly string[];
  /** When the composer sent it, which is where it sits in the thread. */
  readonly createdAt: string;
  /** Epoch milliseconds of the attempt, for the ten-second rule. */
  readonly sentAt: number;
  readonly state: PendingState;
}

export type PendingAction =
  /** The composer posted it. It goes to the end of the thread at once. */
  | { readonly type: 'queued'; readonly message: PendingMessage }
  /** The request answered with a `seq`: it is sent, and the thread holds it. */
  | { readonly type: 'acknowledged'; readonly clientId: string }
  /** The request failed outright. */
  | { readonly type: 'failed'; readonly clientId: string }
  /** The clock ticked: anything still silent past the deadline is not sent. */
  | { readonly type: 'expired'; readonly now: number }
  /** Sent again, by hand. */
  | { readonly type: 'retried'; readonly clientId: string; readonly now: number }
  | { readonly type: 'discarded'; readonly clientId: string };

export const pendingReducer = (
  pending: readonly PendingMessage[],
  action: PendingAction,
): readonly PendingMessage[] => {
  switch (action.type) {
    case 'queued':
      // A `clientId` is unique per ticket, so a second queue of the same one is
      // the same send and replaces it rather than drawing two bubbles.
      return [
        ...pending.filter((message) => message.clientId !== action.message.clientId),
        action.message,
      ];

    case 'acknowledged':
    case 'discarded':
      return pending.filter((message) => message.clientId !== action.clientId);

    case 'failed':
      return pending.map((message) =>
        message.clientId === action.clientId ? { ...message, state: 'failed' as const } : message,
      );

    case 'expired':
      return pending.map((message) =>
        message.state === 'sending' && action.now - message.sentAt >= MESSAGE_RETRY_AFTER_MS
          ? { ...message, state: 'failed' as const }
          : message,
      );

    case 'retried':
      return pending.map((message) =>
        message.clientId === action.clientId
          ? { ...message, state: 'sending' as const, sentAt: action.now }
          : message,
      );
  }
};

/**
 * The sends the thread no longer has to draw itself, because the server's own
 * copy has arrived — either as the response to the post or as the catch-up a
 * socket frame triggered. Matching on `clientId` is what makes those two the
 * same message rather than two.
 */
export const acknowledgedBy = (
  pending: readonly PendingMessage[],
  messages: readonly TicketMessage[],
): readonly string[] => {
  const delivered = new Set(
    messages.map((message) => message.clientId).filter((id): id is string => id !== null),
  );

  return pending.filter((message) => delivered.has(message.clientId)).map((m) => m.clientId);
};
