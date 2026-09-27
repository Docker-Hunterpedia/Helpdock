import type {
  AttachmentKind,
  SignedIdentity,
  WidgetAttachment,
  WidgetConfig,
  WidgetConversation,
  WidgetConversationEvent,
  WidgetMessage,
  WidgetMessagePage,
  WidgetPrechatAnswers,
  WidgetQueue,
  WidgetReceipt,
  WidgetSendResponse,
  WidgetSession,
  WidgetTyping,
} from '@helpdock/schemas';

/**
 * The seam between the widget's UI and the network (M4-04; DOMAIN-RULES §7),
 * as the server side implements it. The widget UI codes against its own
 * `WidgetTransport` in `types.ts`; this is the same contract from the
 * protocol's side, and `createSocketTransport` satisfies it.
 *
 * What the UI never has to do: generate ids, retry, detect gaps, catch up
 * after a reconnect, or choose between the socket and SSE. A message handed
 * to `onMessage` is always the next one in `seq` order, exactly once.
 */

export type Unsubscribe = () => void;

export interface ConversationHandlers {
  /** The next message, in `seq` order, once. The visitor's own included. */
  readonly onMessage?: (message: WidgetMessage) => void;
  readonly onTyping?: (typing: WidgetTyping) => void;
  readonly onQueue?: (queue: WidgetQueue) => void;
  readonly onReceipt?: (receipt: WidgetReceipt) => void;
  readonly onConversation?: (event: WidgetConversationEvent) => void;
}

export interface StartConversationInput {
  readonly text: string;
  readonly prechat?: WidgetPrechatAnswers;
  readonly captchaToken?: string;
  /** Chosen by the transport when absent; pass it to retry the same start. */
  readonly clientId?: string;
}

export interface SendInput {
  readonly text: string;
  readonly attachmentIds?: readonly string[];
  /** Chosen by the transport when absent; pass it to retry the same message. */
  readonly clientId?: string;
}

/** Which live channel the transport is on: the socket, or the SSE fallback. */
export type LiveChannel = 'socket' | 'sse' | 'offline';

export interface WidgetTransport {
  config(): Promise<WidgetConfig>;
  /** The visitor credential: issued on first load, stored for the brand, re-sent after. */
  startSession(options?: {
    readonly identity?: SignedIdentity;
    readonly locale?: 'en' | 'ar';
  }): Promise<WidgetSession>;
  conversations(): Promise<readonly WidgetConversation[]>;
  startConversation(input: StartConversationInput): Promise<WidgetSendResponse>;
  /**
   * Resolves once the message holds a `seq` — which is what "sent" means.
   * Retries with the same `clientId` for up to ten seconds, then rejects with
   * a {@link WidgetTransportError} of code `send_timeout`: "not sent, retry".
   */
  send(conversationId: string, input: SendInput): Promise<WidgetSendResponse>;
  /** `GET …/messages?after=<seq>`, for a UI that wants a page itself. */
  catchUp(conversationId: string, after: number): Promise<WidgetMessagePage>;
  /** Live events for one conversation, from `after` onwards; gaps are filled from REST. */
  subscribe(conversationId: string, after: number, handlers: ConversationHandlers): Unsubscribe;
  onPresence(listener: (agentsOnline: boolean) => void): Unsubscribe;
  onChannel(listener: (channel: LiveChannel) => void): Unsubscribe;
  typing(conversationId: string, typing: boolean): void;
  markRead(conversationId: string, seq: number): void;
  upload(
    conversationId: string,
    file: Blob & { readonly name: string },
    kind: AttachmentKind,
  ): Promise<WidgetAttachment>;
  requestTranscript(conversationId: string, email: string): Promise<void>;
  close(): void;
}

/** A refusal the UI can put words to: the api's `widget.reason`, or a transport failure. */
export type WidgetTransportErrorCode =
  | 'send_timeout'
  | 'network'
  | 'origin_not_allowed'
  | 'unauthenticated'
  | 'rate_limited'
  | 'captcha_required'
  | 'not_found'
  | 'read_only'
  | 'content_policy'
  | 'unavailable'
  | 'invalid_payload'
  | 'internal';

export class WidgetTransportError extends Error {
  readonly code: WidgetTransportErrorCode;
  readonly status: number | null;

  constructor(code: WidgetTransportErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'WidgetTransportError';
    this.code = code;
    this.status = status;
  }
}
