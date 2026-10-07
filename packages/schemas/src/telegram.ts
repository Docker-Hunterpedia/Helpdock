import { z } from 'zod';
import { brandIdParamSchema, localeSchema } from './brand.js';

/**
 * M6: Telegram bots (M6-01, M6-05), their health, and the deliveries of
 * agents' replies to a chat (M6-02).
 */

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------

/**
 * | State | Meaning |
 * |---|---|
 * | healthy | the last update arrived and was filed |
 * | failing | the last thing Telegram or the pipeline said was an error |
 * | waiting | no update has arrived yet: no webhook set, or nobody has written |
 */
export const telegramBotHealthStateSchema = z.enum(['healthy', 'failing', 'waiting']);
export type TelegramBotHealthState = z.infer<typeof telegramBotHealthStateSchema>;

export interface TelegramBotHealthFacts {
  readonly lastUpdateAt: Date | null;
  readonly lastErrorAt: Date | null;
}

/** The legend above as a function, so the Channels list and the System page agree. */
export const telegramBotHealth = (facts: TelegramBotHealthFacts): TelegramBotHealthState => {
  const { lastUpdateAt, lastErrorAt } = facts;
  if (lastErrorAt !== null && (lastUpdateAt === null || lastErrorAt > lastUpdateAt)) {
    return 'failing';
  }

  return lastUpdateAt === null ? 'waiting' : 'healthy';
};

// --------------------------------------------------------------------------
// Bots
// --------------------------------------------------------------------------

/** What BotFather hands out: the bot's numeric id, a colon, and a secret. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{3,20}:[A-Za-z0-9_-]{30,100}$/;
const TOKEN = z.string().trim().regex(TELEGRAM_TOKEN_PATTERN, 'must be a BotFather token');

/** How much of a stored token the bot form shows. */
export const TELEGRAM_TOKEN_HINT_LENGTH = 4;

/** Longer than any welcome needs and well inside Telegram's 4096 characters. */
export const TELEGRAM_WELCOME_MAX_LENGTH = 2_000;
const WELCOME = z.string().trim().max(TELEGRAM_WELCOME_MAX_LENGTH);

/** How much of Telegram's refusal is kept and shown. */
export const TELEGRAM_ERROR_MAX_LENGTH = 300;

export const telegramBotHealthSchema = z.object({
  state: telegramBotHealthStateSchema,
  lastUpdateAt: z.iso.datetime().nullable(),
  /** Telegram's or the pipeline's last words. Never contains the token. */
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
});
export type TelegramBotHealth = z.infer<typeof telegramBotHealthSchema>;

export const telegramBotSchema = z.object({
  id: z.uuid(),
  /** Without the `@`. */
  username: z.string(),
  displayName: z.string(),
  departmentId: z.uuid(),
  departmentName: z.string(),
  /** Whether a token is stored. The token itself never leaves the server. */
  tokenSet: z.boolean(),
  /**
   * The token's last four characters, so two tokens can be told apart on the
   * screen (`•••• 4f2a`). Nothing else of it leaves the server.
   */
  tokenHint: z.string().max(TELEGRAM_TOKEN_HINT_LENGTH),
  tokenUpdatedAt: z.iso.datetime(),
  tokenUpdatedByName: z.string().nullable(),
  /** M6-04. Null is the default text in the contact's language. */
  welcome: z.object({ en: z.string().nullable(), ar: z.string().nullable() }),
  languagePick: z.boolean(),
  webhook: z.object({
    /** The URL the last "Set webhook" registered, or null. */
    url: z.string().nullable(),
    setAt: z.iso.datetime().nullable(),
    /** Where Telegram should post: the install's public route for this bot. */
    expectedUrl: z.string(),
  }),
  /** `webhook` in production; `polling` when the install runs `TELEGRAM_POLLING=true`. */
  mode: z.enum(['webhook', 'polling']),
  health: telegramBotHealthSchema,
  createdAt: z.iso.datetime(),
});
export type TelegramBot = z.infer<typeof telegramBotSchema>;

export const telegramBotListSchema = z.object({ bots: z.array(telegramBotSchema) });
export type TelegramBotList = z.infer<typeof telegramBotListSchema>;

const botBase = z.object({
  displayName: z.string().trim().min(1).max(120),
  departmentId: z.uuid(),
  welcomeEn: WELCOME.nullable().default(null),
  welcomeAr: WELCOME.nullable().default(null),
  languagePick: z.boolean().default(true),
});

/** "Add bot": the token is checked with `getMe` before anything is stored. */
export const telegramBotCreateRequestSchema = botBase.extend({ token: TOKEN });
export type TelegramBotCreateRequest = z.infer<typeof telegramBotCreateRequestSchema>;

/**
 * "Save bot". `token` only when the person pressed Replace and typed one;
 * absent keeps the stored one. A new token must belong to the same bot.
 */
export const telegramBotUpdateRequestSchema = botBase.extend({ token: TOKEN.optional() });
export type TelegramBotUpdateRequest = z.infer<typeof telegramBotUpdateRequestSchema>;

/** Why a bot action was refused, as a code the Channels screen turns into a sentence. */
export const telegramRefusalSchema = z.enum([
  /** Telegram does not recognise the token. */
  'token-invalid',
  /** Telegram could not be reached to check it. */
  'telegram-unreachable',
  /** That bot is already connected, to this brand or another. */
  'bot-taken',
  /** A replacement token belongs to a different bot. */
  'token-other-bot',
  /** The department the bot would file into is not this brand's. */
  'department-not-found',
]);
export type TelegramRefusal = z.infer<typeof telegramRefusalSchema>;

/**
 * "Test" in the Add bot dialog: `getMe` with a token that is not stored yet,
 * so Add stays off until Telegram has recognised it.
 */
export const telegramTokenTestRequestSchema = z.object({ token: TOKEN });
export type TelegramTokenTestRequest = z.infer<typeof telegramTokenTestRequestSchema>;

/** "Test connection": `getMe` with the stored token, or with a typed one. */
export const telegramTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    username: z.string(),
    /** The bot's name in Telegram, which a new bot is listed under. */
    name: z.string(),
    telegramId: z.int(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(['token', 'connect']),
    /** Telegram's own answer, when it gave one. */
    detail: z.string().nullable(),
  }),
]);
export type TelegramTestResult = z.infer<typeof telegramTestResultSchema>;

/** "Set webhook": what Telegram answered to `setWebhook`. */
export const telegramWebhookResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), url: z.string(), setAt: z.iso.datetime() }),
  z.object({ ok: z.literal(false), detail: z.string().nullable() }),
]);
export type TelegramWebhookResult = z.infer<typeof telegramWebhookResultSchema>;

/**
 * The health panel: the row's facts and, when Telegram can be asked,
 * `getWebhookInfo`'s answer.
 */
export const telegramBotStatusSchema = z.object({
  health: telegramBotHealthSchema,
  mode: z.enum(['webhook', 'polling']),
  webhook: z
    .object({
      url: z.string(),
      pendingUpdateCount: z.int().nonnegative(),
      lastErrorAt: z.iso.datetime().nullable(),
      lastErrorMessage: z.string().nullable(),
    })
    .nullable(),
  /** Why `webhook` is null: Telegram could not be asked. */
  webhookError: z.string().nullable(),
  /** The Activity card beside the bot form. */
  activity: z.object({
    lastReplyAt: z.iso.datetime().nullable(),
    /** Replies that ended `failed` in the last 24 hours. */
    failedSends24h: z.int().nonnegative(),
    /** Open tickets of the chats this bot talks in. */
    openTickets: z.int().nonnegative(),
  }),
});
export type TelegramBotStatus = z.infer<typeof telegramBotStatusSchema>;

export const telegramBotParamSchema = brandIdParamSchema.extend({ botId: z.uuid() });
export type TelegramBotParam = z.infer<typeof telegramBotParamSchema>;

/** The public webhook route's parameter. */
export const telegramWebhookParamSchema = z.object({ botId: z.uuid() });
export type TelegramWebhookParam = z.infer<typeof telegramWebhookParamSchema>;

/** The header Telegram echoes `setWebhook`'s `secret_token` in. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Where Telegram posts updates for one bot, under the install's `APP_URL`. */
export const telegramWebhookPath = (botId: string): string => `/api/telegram/${botId}/webhook`;

// --------------------------------------------------------------------------
// Deliveries
// --------------------------------------------------------------------------

export const telegramDeliveryStatusSchema = z.enum(['queued', 'sent', 'failed']);
export type TelegramDeliveryStatus = z.infer<typeof telegramDeliveryStatusSchema>;

/** Attempts before a reply is `failed`. Also the `telegram.send` job's. */
export const TELEGRAM_SEND_ATTEMPTS = 5;

/** What the thread draws under an agent's reply to a Telegram chat. */
export const telegramDeliverySchema = z.object({
  id: z.uuid(),
  messageId: z.uuid(),
  status: telegramDeliveryStatusSchema,
  attempts: z.int().nonnegative(),
  maxAttempts: z.int().positive(),
  lastError: z.string().max(TELEGRAM_ERROR_MAX_LENGTH).nullable(),
  sentAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
});
export type TelegramDelivery = z.infer<typeof telegramDeliverySchema>;

export const telegramDeliveryListSchema = z.object({ items: z.array(telegramDeliverySchema) });
export type TelegramDeliveryList = z.infer<typeof telegramDeliveryListSchema>;

export const telegramTicketParamSchema = brandIdParamSchema.extend({ ticketId: z.uuid() });
export const telegramDeliveryParamSchema = telegramTicketParamSchema.extend({
  deliveryId: z.uuid(),
});
export type TelegramDeliveryParam = z.infer<typeof telegramDeliveryParamSchema>;

/**
 * The ticket view's Telegram half (M6-02): who the chat is with and through
 * which bot, for the channel chip, the "via @bot" line and the
 * ChannelIdentityCard. Null when no chat belongs to the ticket.
 */
export const telegramTicketContextSchema = z.object({
  bot: z.object({ id: z.uuid(), username: z.string() }),
  chatId: z.string(),
  /** The contact's Telegram username, without the `@`; it can change. */
  username: z.string().nullable(),
  name: z.string().nullable(),
  locale: localeSchema.nullable(),
  /** When the contact pressed a language button; null when it was inferred. */
  languageChosenAt: z.iso.datetime().nullable(),
});
export type TelegramTicketContext = z.infer<typeof telegramTicketContextSchema>;

export const telegramTicketContextResponseSchema = z.object({
  context: telegramTicketContextSchema.nullable(),
  deliveries: z.array(telegramDeliverySchema),
});
export type TelegramTicketContextResponse = z.infer<typeof telegramTicketContextResponseSchema>;

// --------------------------------------------------------------------------
// The language pick (M6-04)
// --------------------------------------------------------------------------

/** `callback_data` of the two buttons under the welcome. */
export const telegramLanguageCallback = (locale: z.infer<typeof localeSchema>): string =>
  `lang:${locale}`;

export const parseTelegramLanguageCallback = (
  data: string,
): z.infer<typeof localeSchema> | undefined => {
  const match = /^lang:(en|ar)$/.exec(data);
  return match === null ? undefined : localeSchema.parse(match[1]);
};
