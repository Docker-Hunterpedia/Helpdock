/**
 * The seam between the widget UI and the server (DOMAIN-RULES §7,
 * ARCHITECTURE §8 and §12). The UI codes against this interface only; the real
 * implementation (REST + the `/widget` Socket.IO namespace, SSE fallback) and
 * the mock in `./mock.ts` both satisfy it.
 *
 * Rules every implementation keeps:
 * - REST is the source of truth, sockets are notifications. `sendMessage`
 *   resolves only once the server has assigned a `seq`.
 * - A retried send reuses the same `client_id`; the server dedupes on
 *   `(conversation_id, client_id)` and answers with the original message.
 * - The visitor credential (`visitor_secret`, D §4.1) is the transport's
 *   business: it stores it, sends it, and never hands it to the UI.
 * - Nothing here may pull a schema library into the initial chunk; the size
 *   budget in D §14 counts every byte of the entry.
 *
 * Field names are snake_case. The api speaks camelCase (`docs/guides/widget-protocol.md`);
 * the real transport translates in `map.ts`, so the UI never sees a wire shape.
 */

export type WidgetLocale = 'en' | 'ar';

/** R §4.6: the four modes an admin picks per brand (M4-05). */
export type WidgetMode = 'chat' | 'chat_articles' | 'helpcenter' | 'form';

export type ColorScheme = 'light' | 'dark';

/**
 * The brand theme, resolved on the server with `@helpdock/ui`
 * (`resolveSemanticTokens` for each scheme), so the widget ships no colour
 * maths. Keys are DESIGN §2.2 semantic token names (`bg.canvas`,
 * `action.primary`, …); the widget turns them into `--hd-*` properties.
 */
export interface WidgetTheme {
  readonly mode: 'light' | 'dark' | 'auto';
  readonly tokens: Readonly<Record<ColorScheme, Readonly<Record<string, string>>>>;
  /** DESIGN §4: the brand moves `md` and `lg` only. */
  readonly radius: { readonly md: number; readonly lg: number };
  readonly font_family: { readonly sans: string; readonly arabic: string; readonly mono: string };
  /** Self-hosted font files on the Helpdock origin, registered with the FontFace API. */
  readonly fonts: readonly WidgetFontFile[];
  readonly launcher: {
    readonly style: 'icon' | 'icon_text' | 'text';
    /** Already in the requested locale; `null` means the default label. */
    readonly label: string | null;
    readonly position: 'inline-end' | 'inline-start';
  };
}

export interface WidgetFontFile {
  readonly family: string;
  readonly weight: 400 | 500 | 600;
  readonly url: string;
  readonly unicode_range?: string;
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly avatar_url: string | null;
}

/**
 * Business hours (M3-01) as the widget needs them. `open_offline` is "open,
 * nobody online": the visitor may still write and is answered by email.
 */
export interface Availability {
  readonly state: 'online' | 'open_offline' | 'closed';
  /** ISO 8601; set when `state` is `closed`. */
  readonly next_open_at: string | null;
  /** IANA zone of the brand's business hours, for "We open Sunday at 09:00 (…)". */
  readonly timezone: string;
  readonly agents_online: readonly AgentSummary[];
}

export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'textarea';
  readonly required: boolean;
}

export type AttachmentKind = 'image' | 'video' | 'voice' | 'file';

export interface KindPolicy {
  readonly enabled: boolean;
  readonly max_bytes: number;
  /** Exact types or `type/*` wildcards. */
  readonly allowed_mime: readonly string[];
}

/** ARCHITECTURE §9: the per-brand rich content policy (M4-07). */
export interface ContentPolicy {
  readonly image: KindPolicy;
  readonly video: KindPolicy;
  readonly voice: KindPolicy & { readonly max_seconds: number };
  readonly file: KindPolicy;
  readonly max_attachments_per_message: number;
}

export interface ArticleSummary {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly section: string | null;
  /**
   * The article on the brand's help center, for "Open in help center"; null
   * while the brand has no help center domain, and then the widget offers no
   * link out.
   */
  readonly url: string | null;
}

export interface ArticleDetail extends ArticleSummary {
  readonly updated_at: string;
  readonly reading_minutes: number;
  /**
   * Sanitised on the server (ADR 0007); the widget sanitises again against a
   * short allow-list before it touches the DOM, because it runs on the
   * customer's origin.
   */
  readonly body_html: string;
}

export interface CaptchaConfig {
  readonly provider: 'turnstile' | 'hcaptcha';
  readonly site_key: string;
}

/** `GET /widget/:brand/config?locale=` — public, cached, ETag (A §12). */
export interface WidgetConfig {
  readonly brand: { readonly id: string; readonly name: string };
  readonly mode: WidgetMode;
  readonly default_locale: WidgetLocale;
  readonly theme: WidgetTheme;
  /** Brand-written welcome shown as the first bubble; `null` hides it. */
  readonly greeting: string | null;
  readonly availability: Availability;
  readonly pre_chat: { readonly enabled: boolean; readonly fields: readonly FieldDefinition[] };
  readonly contact_form: { readonly fields: readonly FieldDefinition[] };
  readonly content_policy: ContentPolicy;
  readonly transcript_enabled: boolean;
  readonly captcha: CaptchaConfig | null;
  /** M5-10: the brand's most viewed public articles, listed before the visitor searches. */
  readonly popular_articles: readonly ArticleSummary[];
  readonly help_center_url: string | null;
  readonly show_powered_by: boolean;
}

/** M4-02: what the host page passes to `Helpdock('identify', …)`, forwarded as is. */
export interface SignedIdentity {
  readonly user_id: string;
  readonly email?: string;
  readonly name?: string;
  readonly ts: number;
  readonly signature: string;
}

export type ConversationStatus = 'queued' | 'active' | 'ended';

export interface ConversationSummary {
  readonly id: string;
  readonly status: ConversationStatus;
  readonly agent: AgentSummary | null;
  readonly department: string | null;
  /** The email the visitor typed in the pre-chat form, if any (unverified, D §4.1). */
  readonly visitor_email: string | null;
  /** Highest `seq` the agent side has read, for "Seen". */
  readonly read_seq: number;
  /**
   * M7-06: the assistant has handed this conversation to the team and will
   * not answer in it again (DOMAIN-RULES §9). Absent from a server before M7.
   */
  readonly ai_handed_off?: boolean;
}

export interface VisitorSession {
  readonly visitor_id: string;
  /** The open widget conversation this visitor may resume, if any. */
  readonly conversation: ConversationSummary | null;
}

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mime: string;
  readonly size_bytes: number;
  readonly duration_seconds: number | null;
}

export type MessageAuthor =
  | { readonly kind: 'visitor' }
  | { readonly kind: 'agent'; readonly agent: AgentSummary }
  | { readonly kind: 'ai' }
  | { readonly kind: 'system' };

export type AiFeedback = 'helpful' | 'not_helpful';

/** A source an assistant answer cites as `[marker]`: public help center articles only. */
export interface AiCitation {
  readonly marker: number;
  readonly title: string;
  readonly url: string | null;
  /** Opens in the widget when the article has no help center address. */
  readonly article_id: string | null;
}

/** M7-06: what the assistant wrote — an answer with sources, or the brand's handoff text. */
export interface AiPart {
  readonly kind: 'answer' | 'handoff';
  readonly citations: readonly AiCitation[];
  readonly feedback: AiFeedback | null;
}

/** A system line the widget words itself, in the visitor's language. */
export interface SystemEvent {
  readonly code: 'agent_joined' | 'conversation_ended';
  readonly name: string | null;
}

export interface WidgetMessage {
  readonly id: string;
  readonly conversation_id: string;
  /** Server-assigned, monotonic per conversation (D §7). */
  readonly seq: number;
  /** The visitor's UUIDv7 for their own messages; `null` for agent and system lines. */
  readonly client_id: string | null;
  readonly author: MessageAuthor;
  readonly body: string;
  readonly attachments: readonly Attachment[];
  readonly system: SystemEvent | null;
  /** On the assistant's messages only (M7-06). */
  readonly ai?: AiPart;
  readonly created_at: string;
}

export interface SendMessageInput {
  readonly client_id: string;
  readonly body: string;
  readonly attachment_ids: readonly string[];
}

export interface StartConversationInput {
  readonly name?: string;
  readonly email?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly captcha_token?: string;
  /** M5-08: the help center article "Still need help?" was pressed on. */
  readonly article_id?: string;
}

export interface ContactFormInput {
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly attachment_ids: readonly string[];
  readonly captcha_token?: string;
  readonly article_id?: string;
}

export type ConnectionState = 'connecting' | 'online' | 'reconnecting';

/**
 * Pushed by the server. `message` and `receipt` are durable (a gap in `seq`
 * or a reconnect triggers a catch-up); `typing`, `presence` and `queue` are
 * ephemeral and never replayed (D §7).
 */
export type WidgetEvent =
  | { readonly type: 'message'; readonly message: WidgetMessage }
  | { readonly type: 'receipt'; readonly kind: 'delivered' | 'read'; readonly seq: number }
  | { readonly type: 'typing'; readonly typing: boolean; readonly agent: AgentSummary | null }
  | { readonly type: 'presence'; readonly availability: Availability }
  | {
      readonly type: 'queue';
      readonly position: number;
      readonly eta_seconds: number | null;
    }
  | { readonly type: 'conversation'; readonly conversation: ConversationSummary };

export interface Subscription {
  readonly onEvent: (event: WidgetEvent) => void;
  /** `online` after a drop is the UI's cue to catch up from its cursor. */
  readonly onConnection: (state: ConnectionState) => void;
}

export type Unsubscribe = () => void;

/** Why a call failed, in terms the UI can word for the visitor. */
export type TransportErrorCode =
  | 'network'
  | 'rate_limited'
  | 'captcha_failed'
  | 'policy_rejected'
  | 'not_found'
  | 'unavailable';

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string = code) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export interface WidgetTransport {
  getConfig(locale: WidgetLocale): Promise<WidgetConfig>;
  /** Issues or resumes `{visitor_id, visitor_secret}`; the secret stays inside the transport. */
  startSession(identity: SignedIdentity | null): Promise<VisitorSession>;
  startConversation(input: StartConversationInput): Promise<ConversationSummary>;
  /** `POST /widget/conversations/:id/messages`; resolves with the stored message and its `seq`. */
  sendMessage(conversationId: string, input: SendMessageInput): Promise<WidgetMessage>;
  /** `GET …/messages?after=<seq>`, oldest first. `after: 0` loads the whole thread. */
  listMessages(conversationId: string, after: number): Promise<readonly WidgetMessage[]>;
  subscribe(conversationId: string | null, subscription: Subscription): Unsubscribe;
  /** Ephemeral; implementations may drop it when offline. */
  sendTyping(conversationId: string, typing: boolean): void;
  markRead(conversationId: string, seq: number): Promise<void>;
  /** Presign → PUT → confirm (A §9). The id is bound to this visitor until it is sent. */
  uploadAttachment(file: Blob, name: string, kind: AttachmentKind): Promise<Attachment>;
  /** A short-lived URL issued after the server authorises the visitor (D §4.5). */
  attachmentUrl(conversationId: string, attachmentId: string): Promise<string>;
  requestTranscript(conversationId: string, email: string): Promise<void>;
  /** M7-06: "Talk to a human". The assistant steps back for the rest of the conversation. */
  handOff(conversationId: string): Promise<ConversationSummary>;
  /** M7-06: "Was this helpful?" on one of the assistant's answers. */
  sendFeedback(conversationId: string, messageId: string, feedback: AiFeedback): Promise<void>;
  submitContactForm(input: ContactFormInput): Promise<{ readonly ticket_ref: string }>;
  /** M5-10: help center search, public articles only; the api logs it for Insights. */
  searchArticles(query: string, locale: WidgetLocale): Promise<readonly ArticleSummary[]>;
  /**
   * The chat composer's "Articles that might help" while a message is typed:
   * the same search, not logged, because a message is not a search.
   */
  suggestArticles(query: string, locale: WidgetLocale): Promise<readonly ArticleSummary[]>;
  /** One public article; counts a view, and marks the search it was opened from. */
  getArticle(id: string, locale: WidgetLocale): Promise<ArticleDetail>;
}
