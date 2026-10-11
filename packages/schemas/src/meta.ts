import { z } from 'zod';
import { brandIdParamSchema } from './brand.js';

/**
 * M10: the Meta channels — WhatsApp, Messenger and Instagram — as the admin
 * screens, the ticket view and the api's routes see them (ADR 0025). The
 * shapes Graph itself speaks (webhook envelopes, send payloads) are the
 * channel package's, as Telegram's `Update` is.
 */

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------

/** The three products of the Graph API a brand connects an account of. */
export const metaPlatformSchema = z.enum(['whatsapp', 'messenger', 'instagram']);
export type MetaPlatform = z.infer<typeof metaPlatformSchema>;

export const META_PLATFORMS: readonly MetaPlatform[] = metaPlatformSchema.options;

/**
 * | State | Meaning |
 * |---|---|
 * | connected | the token works and the app is subscribed, as far as Helpdock knows |
 * | token_expired | Graph refused the token; an Admin pastes a new one |
 * | unsubscribed | Graph no longer posts webhooks for the account; `meta.health` could not restore it |
 */
export const metaAccountStatusSchema = z.enum(['connected', 'token_expired', 'unsubscribed']);
export type MetaAccountStatus = z.infer<typeof metaAccountStatusSchema>;

/**
 * What the pasted token is: a system user's (WhatsApp) and a Page's
 * (Messenger) do not expire, an Instagram user token lives 60 days and is
 * refreshed by `meta.health`.
 */
export const metaTokenKindSchema = z.enum(['system_user', 'page', 'instagram_user']);
export type MetaTokenKind = z.infer<typeof metaTokenKindSchema>;

/** The token kind each platform connects with (ADR 0025, 3 and 5). */
export const META_TOKEN_KIND: Readonly<Record<MetaPlatform, MetaTokenKind>> = Object.freeze({
  whatsapp: 'system_user',
  messenger: 'page',
  instagram: 'instagram_user',
});

/**
 * Where an agent's reply is. Past `sent` the platform's own reports move it
 * forward, never back; `refused` is a reply the reply window forbade, which no
 * retry fixes, and `failed` one the last attempt could not deliver.
 */
export const metaDeliveryStatusSchema = z.enum([
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'refused',
]);
export type MetaDeliveryStatus = z.infer<typeof metaDeliveryStatusSchema>;

// --------------------------------------------------------------------------
// Constants every branch of M10 agrees on (brief §1.1)
// --------------------------------------------------------------------------

/** The header Meta signs a webhook body in: `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

/** The one webhook route of the install, under its `APP_URL`. */
export const metaWebhookPath = (): string => '/api/meta/webhook';

/**
 * How much text one message may carry. WhatsApp and Messenger count
 * characters; Instagram counts the UTF-8 bytes, so a part of Arabic text holds
 * about 500 letters.
 */
export const META_TEXT_LIMITS: Readonly<
  Record<MetaPlatform, { readonly unit: 'characters' | 'bytes'; readonly max: number }>
> = Object.freeze({
  whatsapp: { unit: 'characters', max: 4_096 },
  messenger: { unit: 'characters', max: 2_000 },
  instagram: { unit: 'bytes', max: 1_000 },
});

const MIB = 1024 * 1024;

/**
 * The size an outgoing file may have, per platform and kind, and the types a
 * platform accepts as a file. A file over the limit or of the wrong type is
 * left out of the reply, and the agent is told.
 */
export interface MetaAttachmentLimits {
  readonly image: number;
  readonly audio: number;
  readonly video: number;
  /** A document. */
  readonly file: number;
  /** The only media type accepted as a file, or null when any is. */
  readonly fileTypes: readonly string[] | null;
}

export const META_ATTACHMENT_LIMITS: Readonly<Record<MetaPlatform, MetaAttachmentLimits>> =
  Object.freeze({
    whatsapp: {
      image: 5 * MIB,
      audio: 16 * MIB,
      video: 16 * MIB,
      file: 100 * MIB,
      fileTypes: null,
    },
    messenger: {
      image: 25 * MIB,
      audio: 25 * MIB,
      video: 25 * MIB,
      file: 25 * MIB,
      fileTypes: null,
    },
    instagram: {
      image: 8 * MIB,
      audio: 25 * MIB,
      video: 25 * MIB,
      file: 25 * MIB,
      fileTypes: ['application/pdf'],
    },
  });

/**
 * The webhook fields an account is subscribed to (`POST /{id}/subscribed_apps`),
 * which are also what a stand-in reports back. Instagram's list is what the
 * Instagram API with Instagram Login offers.
 */
export const META_SUBSCRIBED_FIELDS: Readonly<Record<MetaPlatform, readonly string[]>> =
  Object.freeze({
    whatsapp: ['messages'],
    messenger: [
      'messages',
      'message_echoes',
      'message_deliveries',
      'message_reads',
      'message_reactions',
      'message_edits',
      'messaging_postbacks',
      'messaging_referrals',
      'messaging_policy_enforcement',
    ],
    instagram: [
      'messages',
      'message_reactions',
      'messaging_seen',
      'messaging_postbacks',
      'messaging_referral',
    ],
  });

/** How much of Graph's refusal is kept and shown. */
export const META_ERROR_MAX_LENGTH = 300;

/** How much of a stored token the account form shows. */
export const META_TOKEN_HINT_LENGTH = 4;

/** Attempts before a reply is `failed`. Also the `meta.send` job's. */
export const META_SEND_ATTEMPTS = 5;

/** The reply window on every platform: 24 hours from the customer's last message. */
export const META_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the Human Agent feature extends a person's reply to on Messenger and Instagram. */
export const META_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** WhatsApp refuses a second message to one user inside this many milliseconds (`131056`). */
export const META_PACE_MS = 6_000;

// --------------------------------------------------------------------------
// Files that arrive with a message
// --------------------------------------------------------------------------

/** What a WhatsApp media message declares about its file. */
export const whatsappMediaTypeSchema = z.enum(['image', 'video', 'audio', 'document', 'sticker']);
export type WhatsAppMediaType = z.infer<typeof whatsappMediaTypeSchema>;

/**
 * A file a webhook names but does not carry (ADR 0025, 6): a WhatsApp media id,
 * fetched with the account's token, or a CDN link inside a Messenger or
 * Instagram payload. It travels in the `meta.media` outbox event to the
 * `meta.media_fetch` job, which is why it is a schema and not only a type.
 */
export const metaFileRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whatsapp_media'),
    type: whatsappMediaTypeSchema,
    mediaId: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(200),
    /** Base64 of the SHA-256 Meta computed; the fetch job checks the bytes against it. */
    sha256: z.string().max(200).nullable(),
    filename: z.string().max(500).optional(),
    /** A voice note rather than an audio file. */
    voice: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('cdn_url'),
    url: z.url({ protocol: /^https?$/ }).max(4_096),
    /** As the platform declared it: `image`, `video`, `audio`, `file`, `sticker`, `story`, `story_mention`. */
    type: z.string().min(1).max(64),
  }),
]);
export type MetaFileRef = z.infer<typeof metaFileRefSchema>;

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------

/**
 * | State | Meaning |
 * |---|---|
 * | healthy | the last webhook arrived and was filed |
 * | failing | the account is not `connected`, or the last thing Graph or the pipeline said was an error |
 * | waiting | no webhook has arrived yet: not subscribed, or nobody has written |
 */
export const metaAccountHealthStateSchema = z.enum(['healthy', 'failing', 'waiting']);
export type MetaAccountHealthState = z.infer<typeof metaAccountHealthStateSchema>;

export interface MetaAccountHealthFacts {
  readonly status: MetaAccountStatus;
  readonly lastEventAt: Date | null;
  readonly lastErrorAt: Date | null;
}

/** The legend above as a function, so the Channels list and the System page agree. */
export const metaAccountHealth = (facts: MetaAccountHealthFacts): MetaAccountHealthState => {
  const { status, lastEventAt, lastErrorAt } = facts;
  if (status !== 'connected') {
    return 'failing';
  }
  if (lastErrorAt !== null && (lastEventAt === null || lastErrorAt > lastEventAt)) {
    return 'failing';
  }

  return lastEventAt === null ? 'waiting' : 'healthy';
};

// --------------------------------------------------------------------------
// Accounts
// --------------------------------------------------------------------------

/** What the screen reads of one connected account. The token never leaves the server. */
export const metaAccountSchema = z.object({
  id: z.uuid(),
  platform: metaPlatformSchema,
  /** The phone number id, the Page id or the Instagram account id. */
  externalId: z.string(),
  /** WhatsApp: the business account the number belongs to. */
  wabaId: z.string().nullable(),
  /** WhatsApp: the number as Meta displays it. */
  displayPhone: z.string().nullable(),
  /** Instagram: the `@handle` without the `@`; Messenger: the Page's name. */
  username: z.string().nullable(),
  displayName: z.string(),
  departmentId: z.uuid(),
  departmentName: z.string(),
  /** Whether a token is stored. The token itself never leaves the server. */
  tokenSet: z.boolean(),
  /**
   * The token's last four characters, so two tokens can be told apart on the
   * screen (`•••• 4f2a`). Nothing else of it leaves the server.
   */
  tokenHint: z.string().max(META_TOKEN_HINT_LENGTH),
  tokenKind: metaTokenKindSchema,
  /** Null for a token that does not expire. */
  tokenExpiresAt: z.iso.datetime().nullable(),
  tokenUpdatedAt: z.iso.datetime(),
  tokenUpdatedByName: z.string().nullable(),
  /** Messenger and Instagram: the operator asserts Meta approved the Human Agent feature. */
  humanAgentEnabled: z.boolean(),
  subscribedFields: z.array(z.string()),
  subscribedAt: z.iso.datetime().nullable(),
  status: metaAccountStatusSchema,
  health: metaAccountHealthStateSchema,
  lastEventAt: z.iso.datetime().nullable(),
  /** Graph's or the pipeline's last words. Never contains the token. */
  lastError: z.string().max(META_ERROR_MAX_LENGTH).nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type MetaAccount = z.infer<typeof metaAccountSchema>;

export const metaAccountListSchema = z.object({ accounts: z.array(metaAccountSchema) });
export type MetaAccountList = z.infer<typeof metaAccountListSchema>;

/**
 * The ids Meta issues are numeric strings: the phone number id, the Page id and
 * the Instagram account id alike.
 */
export const META_EXTERNAL_ID_PATTERN = /^\d{5,25}$/;
const EXTERNAL_ID = z.string().trim().regex(META_EXTERNAL_ID_PATTERN, 'must be the numeric id');

/**
 * A token as the dashboard hands it out: one run of characters with no space.
 * Real ones are far longer than the minimum, which only turns away a typo.
 */
export const META_TOKEN_MIN_LENGTH = 16;
export const META_TOKEN_MAX_LENGTH = 1_024;
const TOKEN = z
  .string()
  .trim()
  .min(META_TOKEN_MIN_LENGTH)
  .max(META_TOKEN_MAX_LENGTH)
  .regex(/^\S+$/, 'must not contain spaces');

const DISPLAY_NAME = z.string().trim().min(1).max(120);

/**
 * "Connect account": the id and the token are checked with Graph before
 * anything is stored. `displayName` defaults to the name Graph gives.
 */
export const metaAccountCreateRequestSchema = z.object({
  platform: metaPlatformSchema,
  externalId: EXTERNAL_ID,
  accessToken: TOKEN,
  departmentId: z.uuid(),
  displayName: DISPLAY_NAME.optional(),
  humanAgentEnabled: z.boolean().default(false),
});
export type MetaAccountCreateRequest = z.infer<typeof metaAccountCreateRequestSchema>;

/**
 * "Save account". `accessToken` only when the person pressed Replace and typed
 * one; absent keeps the stored one. A new token must belong to the same
 * account.
 */
export const metaAccountUpdateRequestSchema = z.object({
  displayName: DISPLAY_NAME,
  departmentId: z.uuid(),
  humanAgentEnabled: z.boolean(),
  accessToken: TOKEN.optional(),
});
export type MetaAccountUpdateRequest = z.infer<typeof metaAccountUpdateRequestSchema>;

/**
 * "Test" in the Connect dialog: a read with a token that is not stored yet, so
 * Connect stays off until Graph has recognised it.
 */
export const metaTokenTestRequestSchema = z.object({
  platform: metaPlatformSchema,
  externalId: EXTERNAL_ID,
  accessToken: TOKEN,
});
export type MetaTokenTestRequest = z.infer<typeof metaTokenTestRequestSchema>;

/** Why an account action was refused, as a code the Channels screen turns into a sentence. */
export const metaRefusalSchema = z.enum([
  /** Graph does not recognise the token. */
  'token-invalid',
  /** Graph could not be reached to check it. */
  'graph-unreachable',
  /** That account is already connected, to this brand or another. */
  'account-taken',
  /** A replacement token belongs to a different account. */
  'token-other-account',
  /** The department the account would file into is not this brand's. */
  'department-not-found',
  /** The install has no Meta app secret, so no webhook could be verified. */
  'app-not-configured',
  /** The token is for another platform than the account claims. */
  'platform-mismatch',
  /** A reply was written outside the reply window. */
  'reply-window-closed',
  /** Graph refused to subscribe the app to the account. */
  'subscribe-failed',
]);
export type MetaRefusal = z.infer<typeof metaRefusalSchema>;

/**
 * What a `reply-window-closed` refusal adds to the 409 (M10-02, ADR 0025, 8):
 * the platform, the customer's last message that anchored the window, and when
 * the window closed, so the composer can say what happened and what an agent can
 * do. Both instants are null when the customer never wrote.
 */
export const metaRefusalDetailsSchema = z.object({
  platform: metaPlatformSchema,
  anchorAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type MetaRefusalDetails = z.infer<typeof metaRefusalDetailsSchema>;

/** "Test" and "Test connection": a read with the stored token, or with a typed one. */
export const metaTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    platform: metaPlatformSchema,
    externalId: z.string(),
    /** The name Graph gives: the verified business name, the Page's or the account's. */
    name: z.string(),
    username: z.string().optional(),
    tokenExpiresAt: z.iso.datetime().optional(),
  }),
  z.object({
    ok: z.literal(false),
    /** `token` when Graph refused the token itself; `connect` when it could not be reached. */
    kind: z.enum(['token', 'refused', 'connect']),
    /** Graph's own answer, when it gave one. */
    detail: z.string().nullable(),
  }),
]);
export type MetaTestResult = z.infer<typeof metaTestResultSchema>;

/** "Subscribe now": what Graph answered to `subscribed_apps`. */
export const metaSubscribeResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    subscribedFields: z.array(z.string()),
    subscribedAt: z.iso.datetime(),
  }),
  z.object({ ok: z.literal(false), detail: z.string().nullable() }),
]);
export type MetaSubscribeResult = z.infer<typeof metaSubscribeResultSchema>;

/**
 * The status panel: the row's facts and, when Graph can be asked, what it says
 * now. `tokenValid` and `subscribedApps` are null when it could not be asked,
 * with the reason in `liveError`.
 */
export const metaAccountStatusResponseSchema = z.object({
  status: metaAccountStatusSchema,
  health: metaAccountHealthStateSchema,
  lastEventAt: z.iso.datetime().nullable(),
  lastError: z.string().max(META_ERROR_MAX_LENGTH).nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  tokenExpiresAt: z.iso.datetime().nullable(),
  subscribedFields: z.array(z.string()),
  subscribedAt: z.iso.datetime().nullable(),
  subscriptionCheckedAt: z.iso.datetime().nullable(),
  tokenValid: z.boolean().nullable(),
  subscribedApps: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        subscribedFields: z.array(z.string()),
      }),
    )
    .nullable(),
  liveError: z.string().nullable(),
  /** The Activity card beside the account form. */
  activity: z.object({
    lastReplyAt: z.iso.datetime().nullable(),
    /** Replies that ended `failed` in the last 24 hours. */
    failedSends: z.int().nonnegative(),
    /** Replies the reply window `refused` in the last 24 hours. */
    refusedSends: z.int().nonnegative(),
    /** Open tickets of the conversations this account talks in. */
    openTickets: z.int().nonnegative(),
  }),
});
export type MetaAccountStatusResponse = z.infer<typeof metaAccountStatusResponseSchema>;

export const metaAccountParamSchema = brandIdParamSchema.extend({ accountId: z.uuid() });
export type MetaAccountParam = z.infer<typeof metaAccountParamSchema>;

// --------------------------------------------------------------------------
// The install's Meta app (the App card)
// --------------------------------------------------------------------------

/**
 * What Channels › Meta shows about the install's Meta developer app. The
 * secrets are set on Settings or by the environment and never travel here.
 */
export const metaAppSchema = z.object({
  appIdSet: z.boolean(),
  /** Where Meta posts webhooks: the install's public route. */
  callbackUrl: z.string(),
  /** The verify token's last four characters, or empty when none is set. */
  verifyTokenHint: z.string().max(META_TOKEN_HINT_LENGTH),
  /** The settings that an `HD_META_*` environment variable has taken over. */
  secretsLockedByEnv: z.array(z.string()),
});
export type MetaApp = z.infer<typeof metaAppSchema>;

/** Shown once, when an Admin asks for a new verify token. */
export const metaVerifyTokenRevealSchema = z.object({ verifyToken: z.string().min(1) });
export type MetaVerifyTokenReveal = z.infer<typeof metaVerifyTokenRevealSchema>;

// --------------------------------------------------------------------------
// Deliveries and the ticket view
// --------------------------------------------------------------------------

/** What the thread draws under an agent's reply to a Meta customer. */
export const metaDeliverySchema = z.object({
  id: z.uuid(),
  ticketMessageId: z.uuid(),
  status: metaDeliveryStatusSchema,
  partsSent: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  lastError: z.string().max(META_ERROR_MAX_LENGTH).nullable(),
  /** Graph's error code for a `failed` or `refused` reply. */
  errorCode: z.string().nullable(),
  /** `HUMAN_AGENT` when the reply went out in the extended window. */
  tag: z.string().nullable(),
  /** The WhatsApp template a reply after the window was sent as. */
  templateName: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
});
export type MetaDeliveryView = z.infer<typeof metaDeliverySchema>;

export const metaDeliveryListSchema = z.object({ items: z.array(metaDeliverySchema) });
export type MetaDeliveryList = z.infer<typeof metaDeliveryListSchema>;

/**
 * Whether a reply may be written now (DOMAIN-RULES §2.6): `open` for 24 hours
 * from the customer's last message, `human_agent` for a person's reply in the
 * extended seven days, `closed` otherwise (`closedAt` is null when the customer
 * never wrote).
 */
export const replyWindowSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), closesAt: z.iso.datetime() }),
  z.object({ state: z.literal('human_agent'), closesAt: z.iso.datetime() }),
  z.object({ state: z.literal('closed'), closedAt: z.iso.datetime().nullable() }),
]);
export type ReplyWindowView = z.infer<typeof replyWindowSchema>;

/**
 * The ticket view's Meta half: who the conversation is with and through which
 * account, for the channel chip, the "via" line and the ChannelIdentityCard,
 * and the reply window for the strip. Null when no conversation belongs to the
 * ticket.
 */
export const metaTicketContextSchema = z.object({
  account: z.object({
    id: z.uuid(),
    platform: metaPlatformSchema,
    externalId: z.string(),
    displayName: z.string(),
    username: z.string().optional(),
  }),
  /** The WhatsApp user id, the Messenger page-scoped id or the Instagram-scoped id. */
  customerId: z.string(),
  /** WhatsApp: the customer's number, `+` and digits, when Meta sent it. */
  phone: z.string().optional(),
  phoneVerified: z.boolean(),
  profileName: z.string().optional(),
  /** Instagram: the customer's `@username` without the `@`. */
  username: z.string().optional(),
  window: replyWindowSchema,
});
export type MetaTicketContext = z.infer<typeof metaTicketContextSchema>;

export const metaTicketContextResponseSchema = z.object({
  context: metaTicketContextSchema.nullable(),
  deliveries: z.array(metaDeliverySchema),
});
export type MetaTicketContextResponse = z.infer<typeof metaTicketContextResponseSchema>;

export const metaTicketParamSchema = brandIdParamSchema.extend({ ticketId: z.uuid() });
export type MetaTicketParam = z.infer<typeof metaTicketParamSchema>;

export const metaDeliveryParamSchema = metaTicketParamSchema.extend({ deliveryId: z.uuid() });
export type MetaDeliveryParam = z.infer<typeof metaDeliveryParamSchema>;
