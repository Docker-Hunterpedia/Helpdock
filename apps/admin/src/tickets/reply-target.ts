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

/** What the server quotes at most; the strip's preview is cut where the mail is. */
export const REPLY_QUOTE_MAX_CHARS = 2000;

/** The quoted text as "Show quote" draws it: the server's cut, on code points, marked with an ellipsis. */
export const quotePreview = (text: string): string => {
  const normalised = text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim();
  const points = Array.from(normalised);

  return points.length <= REPLY_QUOTE_MAX_CHARS
    ? normalised
    : `${points.slice(0, REPLY_QUOTE_MAX_CHARS).join('').trimEnd()}…`;
};

/**
 * Who a targeted reply reaches that the quoted email's sender is not (S4): the reply goes to the
 * ticket's To and Cc as for any reply, and quotes the chosen email to all of them. Null when
 * the sender is the address the reply's To goes to, or when either address is not known.
 */
export interface RecipientsNote {
  readonly name: string;
  readonly to: string;
  readonly ccCount: number;
}

export const recipientsNote = (
  target: TicketMessage | undefined,
  name: string,
  email:
    | {
        readonly to: { readonly name: string; readonly address: string } | null;
        readonly ccs: readonly unknown[];
      }
    | undefined,
): RecipientsNote | null => {
  const sender = target?.email?.from.address.trim().toLowerCase();
  if (sender === undefined || sender === '' || email?.to == null) {
    return null;
  }
  if (sender === email.to.address.trim().toLowerCase()) {
    return null;
  }

  return { name, to: email.to.name || email.to.address, ccCount: email.ccs.length };
};
