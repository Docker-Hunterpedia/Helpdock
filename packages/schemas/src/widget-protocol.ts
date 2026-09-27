import { z } from 'zod';
import { customFieldTypeSchema } from './custom-fields.js';
import {
  ATTACHMENT_NAME_MAX,
  attachmentKindSchema,
  attachmentStatusSchema,
  contentPolicySchema,
} from './media.js';
import { WIDGET_NAMESPACE } from './realtime.js';
import {
  captchaProviderSchema,
  widgetAppearanceSchema,
  widgetColorSchemeSchema,
  widgetLauncherSchema,
  widgetModeSchema,
  widgetPositionSchema,
  widgetWhenUnavailableSchema,
} from './widget-settings.js';

/**
 * The widget protocol (M4-02, M4-03, M4-04): what the chat widget — and a
 * native app speaking the same protocol (`docs/guides/widget-protocol.md`) —
 * sends and receives.
 *
 * It is DOMAIN-RULES §4.1–4.2 and §7 as schemas:
 *
 * - **REST is the truth.** Every message is sent over `POST` with a
 *   client-chosen `clientId` and is "sent" only once it holds a server `seq`.
 *   A retry with the same `clientId` answers the same message.
 * - **Sockets and SSE are notifications.** A client tracks the last `seq` it
 *   holds per conversation and catches up with `GET …/messages?after=<seq>`
 *   after a gap or a reconnect.
 * - **Typing, presence and queue position are ephemeral**: unacknowledged,
 *   never replayed, `seq: null` in their envelope.
 *
 * The api parses every inbound body through these and every outbound payload
 * too; the widget imports the types only, so zod stays out of its bundle.
 */

/** All routes hang off `/api/widget/:brandId`. */
export const WIDGET_API_PREFIX = '/api/widget';

/** `Authorization: Visitor <secret>` (DOMAIN-RULES §4.1). */
export const VISITOR_AUTH_SCHEME = 'Visitor';

/** 256 bits, base64url: 43 characters. */
export const visitorSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'not a visitor secret');

// ------------------------------------------------------------------ errors

/**
 * Why the widget api refused something, as a code the widget translates. The
 * HTTP status says how bad it is; the code says which of these it was.
 */
export const widgetErrorCodeSchema = z.enum([
  /** The page's `Origin` is not in the brand's allowed origins (M4-03). */
  'origin_not_allowed',
  /** No visitor credential, or one this brand never issued. */
  'unauthenticated',
  /** Too many requests from this visitor or this address (M4-03). */
  'rate_limited',
  /** The brand wants a CAPTCHA before the first message and the token is missing or failed. */
  'captcha_required',
  /** No such conversation *for this visitor*: never "exists but is not yours". */
  'not_found',
  /** A conversation the visitor may read but not write: another channel's ticket. */
  'read_only',
  /** The brand's content policy refuses this message or upload. */
  'content_policy',
  /** The widget is switched off for this brand, or the brand is being deleted. */
  'unavailable',
  /** The body did not parse. */
  'invalid_payload',
  /** Anything the server did not expect. Carries no detail on purpose. */
  'internal',
]);
export type WidgetErrorCode = z.infer<typeof widgetErrorCodeSchema>;

export const widgetErrorSchema = z.object({
  code: widgetErrorCodeSchema,
  message: z.string(),
});
export type WidgetError = z.infer<typeof widgetErrorSchema>;

// ---------------------------------------------------------------- params

export const widgetBrandParamSchema = z.object({ brandId: z.uuid() });
export type WidgetBrandParam = z.infer<typeof widgetBrandParamSchema>;

export const widgetConversationParamSchema = widgetBrandParamSchema.extend({
  conversationId: z.uuid(),
});
export type WidgetConversationParam = z.infer<typeof widgetConversationParamSchema>;

export const widgetAttachmentParamSchema = widgetConversationParamSchema.extend({
  attachmentId: z.uuid(),
});
export type WidgetAttachmentParam = z.infer<typeof widgetAttachmentParamSchema>;

// ---------------------------------------------------------------- config

/** A pre-chat field as the widget renders it: the admin's choice, resolved. */
export const widgetPrechatFieldViewSchema = z.object({
  /** `name`, `email`, or a ticket custom field's key. */
  key: z.string(),
  kind: z.enum(['name', 'email', 'custom']),
  required: z.boolean(),
  /**
   * In the `?locale=` asked for, the Arabic falling back to the English. Null
   * for the built-in two, which the widget labels itself.
   */
  label: z.string().nullable(),
  type: z.union([customFieldTypeSchema, z.literal('email')]),
  options: z.array(z.string()),
});
export type WidgetPrechatFieldView = z.infer<typeof widgetPrechatFieldViewSchema>;

/** "Is anybody there?" (M4-08): the brand's calendar and whether an agent is online. */
export const widgetAvailabilitySchema = z.object({
  /** Inside the brand's business hours right now. */
  open: z.boolean(),
  /** When the brand next opens, or null while open or with no hours at all. */
  nextOpenAt: z.iso.datetime().nullable(),
  timezone: z.string(),
  /** At least one agent of the brand is online (DOMAIN-RULES §12). */
  agentsOnline: z.boolean(),
});
export type WidgetAvailability = z.infer<typeof widgetAvailabilitySchema>;

export const widgetLocaleSchema = z.enum(['en', 'ar']);
export type WidgetLocale = z.infer<typeof widgetLocaleSchema>;

/** `?locale=`: the language the greeting and the field labels come back in. */
export const widgetConfigQuerySchema = z.object({
  locale: widgetLocaleSchema.optional(),
});
export type WidgetConfigQuery = z.infer<typeof widgetConfigQuerySchema>;

/** A self-hosted font file the widget registers with the FontFace API (DESIGN §8). */
export const widgetFontFileSchema = z.object({
  family: z.string(),
  weight: z.union([z.literal(400), z.literal(500), z.literal(600)]),
  /** On the Helpdock origin, under `/widget-fonts/`. */
  url: z.string(),
  unicodeRange: z.string().nullable(),
});
export type WidgetFontFile = z.infer<typeof widgetFontFileSchema>;

/**
 * The brand's theme, resolved on the server with `@helpdock/ui` so the widget
 * ships no colour maths: DESIGN §2.2 semantic tokens for each scheme, keyed by
 * token name (`bg.canvas`, `action.primary`, …).
 */
export const widgetThemeSchema = z.object({
  colorScheme: widgetColorSchemeSchema,
  tokens: z.object({
    light: z.record(z.string(), z.string()),
    dark: z.record(z.string(), z.string()),
  }),
  /** DESIGN §4: a brand moves `md` and `lg` only. */
  radius: z.object({ md: z.int().nonnegative(), lg: z.int().nonnegative() }),
  fontFamily: z.object({ sans: z.string(), arabic: z.string(), mono: z.string() }),
  fonts: z.array(widgetFontFileSchema),
  launcher: z.object({
    style: widgetLauncherSchema,
    /** Null: the widget's own "Chat with us" in the visitor's language. */
    label: z.string().nullable(),
    position: widgetPositionSchema,
  }),
});
export type WidgetTheme = z.infer<typeof widgetThemeSchema>;

/**
 * A public help center article the widget lists (M5-10): a popular one in the
 * config, a hit of `GET …/articles?q=`. Public audience only (DOMAIN-RULES §5).
 */
export const widgetArticleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Plain text: the article's description, or the words around the match. */
  excerpt: z.string(),
  section: z.string().nullable(),
  /** The article on the brand's help center domain, or null while it has none. */
  url: z.string().nullable(),
});
export type WidgetArticleSummary = z.infer<typeof widgetArticleSummarySchema>;

/** The most hits one widget search answers. */
export const WIDGET_ARTICLE_SEARCH_MAX = 20;

/**
 * `GET …/articles?q=&locale=`. `purpose: 'suggest'` is the chat composer's
 * "Articles that might help" strip: searched like any other query but not
 * written to the search log, because it is a message being typed, not a
 * search.
 */
export const widgetArticleSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  locale: widgetLocaleSchema,
  limit: z.coerce.number().int().min(1).max(WIDGET_ARTICLE_SEARCH_MAX).default(10),
  purpose: z.enum(['search', 'suggest']).default('search'),
});
export type WidgetArticleSearchQuery = z.infer<typeof widgetArticleSearchQuerySchema>;

export const widgetArticleSearchSchema = z.object({
  articles: z.array(widgetArticleSummarySchema),
  /**
   * The search log row, which the widget sends back when the visitor opens a
   * hit, for the Insights tab's "Opened a result". Null for a suggestion.
   */
  searchId: z.uuid().nullable(),
});
export type WidgetArticleSearch = z.infer<typeof widgetArticleSearchSchema>;

export const widgetArticleParamSchema = z.object({
  brandId: z.uuid(),
  articleId: z.uuid(),
});
export type WidgetArticleParam = z.infer<typeof widgetArticleParamSchema>;

/** `GET …/articles/:articleId?locale=&searchId=`. */
export const widgetArticleQuerySchema = z.object({
  locale: widgetLocaleSchema,
  /** The search the visitor opened this from, if any. */
  searchId: z.uuid().optional(),
});
export type WidgetArticleQuery = z.infer<typeof widgetArticleQuerySchema>;

/** One published public article, read inside the widget. */
export const widgetArticleSchema = widgetArticleSummarySchema.extend({
  /** The language it is in: the one asked for, or the brand's default on a fallback. */
  locale: widgetLocaleSchema,
  updatedAt: z.iso.datetime(),
  readingMinutes: z.int().positive(),
  /** Sanitised when saved (ADR 0007); the widget sanitises it again before use. */
  bodyHtml: z.string(),
});
export type WidgetArticle = z.infer<typeof widgetArticleSchema>;

/**
 * `GET /api/widget/:brandId/config?locale=`. Everything the widget needs for
 * its first paint, and nothing secret: served to any page on an allowed
 * origin, cached with an `ETag`.
 */
export const widgetConfigSchema = z.object({
  brandId: z.uuid(),
  brandName: z.string(),
  defaultLocale: widgetLocaleSchema,
  /** The language the strings below are in: `?locale=`, or the brand's default. */
  locale: widgetLocaleSchema,
  mode: widgetModeSchema,
  /** The admin's stored choices, as the Widget tab saved them. */
  appearance: widgetAppearanceSchema,
  theme: widgetThemeSchema,
  /** The welcome bubble in `locale`; null when the brand left it empty. */
  greeting: z.string().nullable(),
  prechat: z.object({
    enabled: z.boolean(),
    fields: z.array(widgetPrechatFieldViewSchema),
  }),
  /** The contact form's fields beyond name, email and message: the pre-chat's custom fields. */
  contactForm: z.object({ fields: z.array(widgetPrechatFieldViewSchema) }),
  showAgentIdentity: z.boolean(),
  whenUnavailable: widgetWhenUnavailableSchema,
  transcriptEnabled: z.boolean(),
  /** What the composer offers; the api enforces the same policy on upload. */
  contentPolicy: contentPolicySchema,
  /** Present when the brand wants a challenge before the first message (ADR 0003). */
  captcha: z.object({ provider: captchaProviderSchema, siteKey: z.string() }).nullable(),
  /** Whether the brand accepts a signed identity from its site (§4.2). */
  signedIdentity: z.boolean(),
  availability: widgetAvailabilitySchema,
  /** The brand's most viewed public articles over 30 days, in `locale` (M5-10). */
  popularArticles: z.array(widgetArticleSummarySchema),
  /** The brand's help center on its primary verified domain, or null. */
  helpCenterUrl: z.string().nullable(),
  /** "Powered by Helpdock" under the window (DESIGN §6.6). */
  showPoweredBy: z.boolean(),
});
export type WidgetConfig = z.infer<typeof widgetConfigSchema>;

// --------------------------------------------------------------- session

/**
 * What the host site signs (§4.2). The widget passes it through untouched; the
 * signature is over {@link canonicalIdentityJson} of `payload`.
 */
export const signedIdentityPayloadSchema = z.object({
  user_id: z.string().trim().min(1).max(255),
  email: z.string().trim().max(320).optional(),
  name: z.string().trim().max(200).optional(),
  /** Seconds since the epoch. Valid within five minutes either way. */
  ts: z.int().nonnegative(),
});
export type SignedIdentityPayload = z.infer<typeof signedIdentityPayloadSchema>;

export const signedIdentitySchema = z.object({
  payload: signedIdentityPayloadSchema,
  /** Lower-case hex HMAC-SHA256 under the brand's signing secret. */
  signature: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters'),
});
export type SignedIdentity = z.infer<typeof signedIdentitySchema>;

/** How far `ts` may be from the server's clock (§4.2). */
export const SIGNED_IDENTITY_WINDOW_SECONDS = 5 * 60;

/**
 * The bytes a host site signs: the payload's keys in a fixed order
 * (`user_id`, `email`, `name`, `ts`), absent keys left out, no whitespace.
 * Written out rather than `JSON.stringify(payload)`, whose key order is the
 * order the object was built in — which is the signer's, not ours.
 */
export const canonicalIdentityJson = (payload: SignedIdentityPayload): string => {
  const ordered: Record<string, string | number> = { user_id: payload.user_id };
  if (payload.email !== undefined) {
    ordered.email = payload.email;
  }
  if (payload.name !== undefined) {
    ordered.name = payload.name;
  }
  ordered.ts = payload.ts;

  return JSON.stringify(ordered);
};

/** `POST /api/widget/:brandId/session`. `Authorization: Visitor <secret>` when the widget holds one. */
export const widgetSessionRequestSchema = z.object({
  identity: signedIdentitySchema.optional(),
  /** The page's language, remembered on the visitor's contact for replies. */
  locale: widgetLocaleSchema.optional(),
});
export type WidgetSessionRequest = z.infer<typeof widgetSessionRequestSchema>;

export const widgetSessionSchema = z.object({
  visitorId: z.uuid(),
  /**
   * The credential, present only when this call issued it: a first load, or a
   * secret the server no longer recognises. Store it for the brand and send it
   * on every later call; it is never shown again.
   */
  visitorSecret: visitorSecretSchema.nullable(),
  /** A valid signed identity linked this visitor to a verified contact (§4.2). */
  verified: z.boolean(),
});
export type WidgetSession = z.infer<typeof widgetSessionSchema>;

// ---------------------------------------------------------- conversations

export const widgetConversationStateSchema = z.enum(['open', 'closed']);
export type WidgetConversationState = z.infer<typeof widgetConversationStateSchema>;

export const widgetConversationSchema = z.object({
  id: z.uuid(),
  /** `HD-1042`: what the visitor quotes if they write in by email. */
  reference: z.string(),
  subject: z.string(),
  state: widgetConversationStateSchema,
  /**
   * `chat` for widget conversations; another channel only for a verified
   * visitor of a brand that shows them every channel (§4.2), and then the
   * conversation is read-only in the widget.
   */
  channel: z.enum(['chat', 'email', 'telegram', 'form', 'api', 'manual']),
  /** The highest `seq` of the conversation; the catch-up cursor to start from. */
  lastSeq: z.int().nonnegative(),
  /** The conversation a reply after closing continued on (§2.3), if any. */
  continuedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WidgetConversation = z.infer<typeof widgetConversationSchema>;

export const widgetConversationListSchema = z.object({
  conversations: z.array(widgetConversationSchema),
});
export type WidgetConversationList = z.infer<typeof widgetConversationListSchema>;

// -------------------------------------------------------------- messages

/** What a visitor may see of an attachment: never the object key (§4.5). */
export const widgetAttachmentSchema = z.object({
  id: z.uuid(),
  kind: attachmentKindSchema,
  name: z.string().max(ATTACHMENT_NAME_MAX),
  mime: z.string(),
  size: z.int().nonnegative(),
  status: attachmentStatusSchema,
});
export type WidgetAttachment = z.infer<typeof widgetAttachmentSchema>;

/**
 * One message as a visitor sees it. There is no note field and no internal
 * author id: a visitor DTO cannot leak an internal note because it has
 * nowhere to put one (DOMAIN-RULES §1.3, layer 4).
 */
export const widgetMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  seq: z.int().positive(),
  /** The visitor's own `clientId` on their messages; null on everybody else's. */
  clientId: z.uuid().nullable(),
  author: z.enum(['visitor', 'agent', 'system', 'ai']),
  /**
   * The agent's first name and avatar when the brand shows them (M4-08);
   * otherwise null and the widget shows the brand.
   */
  agent: z.object({ name: z.string(), avatarUrl: z.url().nullable() }).nullable(),
  text: z.string(),
  /** Sanitised HTML for agent replies; null for a visitor's plain text. */
  html: z.string().nullable(),
  attachments: z.array(widgetAttachmentSchema),
  createdAt: z.iso.datetime(),
});
export type WidgetMessage = z.infer<typeof widgetMessageSchema>;

export const WIDGET_MESSAGE_TEXT_MAX = 10_000;
export const WIDGET_MESSAGE_PAGE_MAX = 200;

const clientIdSchema = z.uuid();

export const widgetSendRequestSchema = z
  .object({
    /** UUIDv7 chosen by the client before the first attempt; retries repeat it (§7). */
    clientId: clientIdSchema,
    text: z.string().trim().max(WIDGET_MESSAGE_TEXT_MAX),
    attachmentIds: z.array(z.uuid()).max(20).default([]),
  })
  .refine((body) => body.text !== '' || body.attachmentIds.length > 0, {
    message: 'a message needs text or an attachment',
    path: ['text'],
  });
export type WidgetSendRequest = z.input<typeof widgetSendRequestSchema>;

export const WIDGET_PRECHAT_VALUE_MAX = 2000;

/** The pre-chat form's answers. An email typed here is never verified (§4.1). */
export const widgetPrechatAnswersSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  /** Ticket custom field answers by key; checked against the definitions. */
  custom: z
    .record(
      z.string().max(60),
      z.union([
        z.string().max(WIDGET_PRECHAT_VALUE_MAX),
        z.number(),
        z.boolean(),
        z.array(z.string().max(80)).max(50),
      ]),
    )
    .default({}),
});
export type WidgetPrechatAnswers = z.input<typeof widgetPrechatAnswersSchema>;

/**
 * `POST …/conversations`. With text, that text is the first message; without,
 * the conversation opens empty, as the widget does before the visitor's first
 * message or from the pre-chat form. `clientId` makes the call idempotent: a
 * retry with the same one answers the conversation it opened.
 */
export const widgetStartRequestSchema = z.object({
  clientId: clientIdSchema,
  text: z.string().trim().max(WIDGET_MESSAGE_TEXT_MAX).default(''),
  prechat: widgetPrechatAnswersSchema.optional(),
  /** The CAPTCHA token, when the config asks for one (ADR 0003). */
  captchaToken: z.string().max(4096).optional(),
  /**
   * M5-08: the help center article the visitor came from ("Still need
   * help?"). Recorded on the ticket for the agents when it is a published
   * public article of the brand, and ignored otherwise.
   */
  articleId: z.uuid().optional(),
});
export type WidgetStartRequest = z.input<typeof widgetStartRequestSchema>;

export const widgetSendResponseSchema = z.object({
  /** May differ from the one addressed: a reply after closing may continue on a new one (§2.3). */
  conversation: widgetConversationSchema,
  message: widgetMessageSchema,
});
export type WidgetSendResponse = z.infer<typeof widgetSendResponseSchema>;

/** The start's answer: the message is null when the conversation opened without text. */
export const widgetStartResponseSchema = z.object({
  conversation: widgetConversationSchema,
  message: widgetMessageSchema.nullable(),
});
export type WidgetStartResponse = z.infer<typeof widgetStartResponseSchema>;

export const widgetMessagesQuerySchema = z.object({
  /** The last `seq` the client holds; 0 for the whole thread. */
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(WIDGET_MESSAGE_PAGE_MAX).default(100),
});
export type WidgetMessagesQuery = z.infer<typeof widgetMessagesQuerySchema>;

/**
 * The catch-up page. `lastSeq` is the conversation's high-water mark, which
 * can be above the last message returned: internal notes take a `seq` too and
 * a visitor never sees them, so a client moves its cursor to `lastSeq` rather
 * than to its last message, and a gap made by a note is not a gap again.
 */
export const widgetMessagePageSchema = z.object({
  messages: z.array(widgetMessageSchema),
  lastSeq: z.int().nonnegative(),
  /** True when more than `limit` messages followed `after`: ask again from the last one. */
  hasMore: z.boolean(),
});
export type WidgetMessagePage = z.infer<typeof widgetMessagePageSchema>;

export const widgetReadRequestSchema = z.object({ seq: z.int().positive() });
export type WidgetReadRequest = z.infer<typeof widgetReadRequestSchema>;

export const widgetTypingRequestSchema = z.object({ typing: z.boolean() });
export type WidgetTypingRequest = z.infer<typeof widgetTypingRequestSchema>;

/** `POST …/transcript`: this conversation only, to the address typed (§4.1). */
export const widgetTranscriptRequestSchema = z.object({
  email: z.string().trim().min(3).max(320),
});
export type WidgetTranscriptRequest = z.infer<typeof widgetTranscriptRequestSchema>;

export const widgetQueueSchema = z.object({
  conversationId: z.uuid(),
  /** 1 is next. Null once an agent holds the conversation, or when it is closed. */
  position: z.int().positive().nullable(),
});
export type WidgetQueue = z.infer<typeof widgetQueueSchema>;

export const widgetStreamQuerySchema = z.object({
  conversationId: z.uuid(),
  after: z.coerce.number().int().nonnegative().default(0),
});
export type WidgetStreamQuery = z.infer<typeof widgetStreamQuerySchema>;

// ------------------------------------------------------ realtime (§7)

/** Where the `/widget` namespace lives; the path is the staff one's. */
export { WIDGET_NAMESPACE };

/**
 * The handshake's `auth`: the brand and the visitor's credential. The page's
 * `Origin` is checked against the brand's allowed origins before anything
 * else (M4-03).
 */
export const widgetHandshakeSchema = z.object({
  brandId: z.uuid(),
  visitorSecret: visitorSecretSchema,
});
export type WidgetHandshake = z.infer<typeof widgetHandshakeSchema>;

export const WIDGET_EVENTS = {
  // client → server
  join: 'conversation:join',
  leave: 'conversation:leave',
  send: 'message:send',
  typingSet: 'typing:set',
  read: 'message:read',
  // server → client
  message: 'message',
  receipt: 'receipt',
  typing: 'typing',
  presence: 'presence',
  queue: 'queue',
  conversation: 'conversation',
} as const;

export const widgetJoinSchema = z.object({ conversationId: z.uuid() });
export type WidgetJoin = z.infer<typeof widgetJoinSchema>;

export const widgetSocketSendSchema = z.object({
  conversationId: z.uuid(),
  message: widgetSendRequestSchema,
});
export type WidgetSocketSend = z.input<typeof widgetSocketSendSchema>;

export const widgetTypingSetSchema = z.object({
  conversationId: z.uuid(),
  typing: z.boolean(),
});
export type WidgetTypingSet = z.infer<typeof widgetTypingSetSchema>;

export const widgetReadSchema = z.object({
  conversationId: z.uuid(),
  seq: z.int().positive(),
});
export type WidgetRead = z.infer<typeof widgetReadSchema>;

/** Delivered and read receipts are their own events, naming the `seq` they refer to (§7). */
export const widgetReceiptSchema = z.object({
  conversationId: z.uuid(),
  kind: z.enum(['delivered', 'read']),
  seq: z.int().positive(),
});
export type WidgetReceipt = z.infer<typeof widgetReceiptSchema>;

export const widgetTypingSchema = z.object({
  conversationId: z.uuid(),
  typing: z.boolean(),
  /** The agent's first name when the brand shows agents; otherwise null. */
  agentName: z.string().nullable(),
});
export type WidgetTyping = z.infer<typeof widgetTypingSchema>;

export const widgetPresenceSchema = z.object({ agentsOnline: z.boolean() });
export type WidgetPresence = z.infer<typeof widgetPresenceSchema>;

/** The conversation moved: closed, reopened, or continued on a new one (§2.3). */
export const widgetConversationEventSchema = z.object({
  conversationId: z.uuid(),
  state: widgetConversationStateSchema,
  continuedById: z.uuid().nullable(),
});
export type WidgetConversationEvent = z.infer<typeof widgetConversationEventSchema>;

/** Every server → widget event and its payload. `message` alone carries a `seq`. */
export const WIDGET_EVENT_PAYLOADS = {
  [WIDGET_EVENTS.message]: widgetMessageSchema,
  [WIDGET_EVENTS.receipt]: widgetReceiptSchema,
  [WIDGET_EVENTS.typing]: widgetTypingSchema,
  [WIDGET_EVENTS.presence]: widgetPresenceSchema,
  [WIDGET_EVENTS.queue]: widgetQueueSchema,
  [WIDGET_EVENTS.conversation]: widgetConversationEventSchema,
} as const;

export type WidgetServerEvent = keyof typeof WIDGET_EVENT_PAYLOADS;
export type WidgetServerEventPayload<E extends WidgetServerEvent> = z.infer<
  (typeof WIDGET_EVENT_PAYLOADS)[E]
>;

/** The staff envelope's shape: `{ seq, at, data }`, `seq` null for ephemeral events. */
export interface WidgetEnvelope<T> {
  readonly seq: number | null;
  readonly at: string;
  readonly data: T;
}

export const widgetAckSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: widgetErrorSchema }),
  ]);

export type WidgetAck<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: WidgetError };

export const widgetJoinAckSchema = widgetAckSchema(
  z.object({ conversationId: z.uuid(), lastSeq: z.int().nonnegative() }),
);
export type WidgetJoinAck = z.infer<typeof widgetJoinAckSchema>;

export const widgetSendAckSchema = widgetAckSchema(widgetSendResponseSchema);
export type WidgetSendAck = z.infer<typeof widgetSendAckSchema>;

// -------------------------------------------------------------- timings

/** §7: the UI shows "not sent, retry" after this long without a `seq`. */
export const WIDGET_SEND_TIMEOUT_MS = 10_000;
/** §7: the server closes an SSE stream after five minutes; the client reconnects with its cursor. */
export const WIDGET_SSE_MAX_AGE_MS = 5 * 60 * 1000;
/** A typing indicator nobody repeats within this long has stopped. */
export const WIDGET_TYPING_TTL_MS = 6_000;
