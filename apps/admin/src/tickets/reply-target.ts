import type { TicketMessage } from '@helpdock/schemas';

/**
 * M14-31. Which customer email the composer's reply answers, if any. The draft
 * text is not part of it: pointing, moving and clearing the target never
 * touch what the agent has typed.
 */
export interface ReplyTargetState {
  /** The message the strip names; null when the reply answers none. */
  readonly messageId: string | null;
  /** The api said that message is gone: the strip says so and Send waits for the agent. */
  readonly unavailable: boolean;
}

export const NO_REPLY_TARGET: ReplyTargetState = { messageId: null, unavailable: false };

export type ReplyTargetAction =
  /** Reply pressed on a message; pressing it on another moves the strip. */
  | { readonly type: 'point'; readonly messageId: string }
  /** The × button, the Internal note tab, or a send that went out. */
  | { readonly type: 'clear' }
  /** A send the api refused for its target: the strip stays, naming the problem. */
  | { readonly type: 'gone'; readonly messageId: string };

export const replyTargetReducer = (
  state: ReplyTargetState,
  action: ReplyTargetAction,
): ReplyTargetState => {
  switch (action.type) {
    case 'point':
      return state.messageId === action.messageId && !state.unavailable
        ? state
        : { messageId: action.messageId, unavailable: false };
    case 'clear':
      return state.messageId === null ? state : NO_REPLY_TARGET;
    case 'gone':
      return { messageId: action.messageId, unavailable: true };
  }
};

/** Only a public message a customer sent by email can be answered on its own. */
export const canReplyToMessage = (message: TicketMessage): boolean =>
  message.kind === 'public' && message.authorType === 'contact' && message.channel === 'email';
