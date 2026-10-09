import type { TelegramDelivery as TelegramDeliveryRow } from '@helpdock/db';
import {
  TELEGRAM_SEND_ATTEMPTS,
  TELEGRAM_TOKEN_HINT_LENGTH,
  type TelegramBot,
  type TelegramDelivery,
  telegramBotHealth,
  telegramWebhookPath,
} from '@helpdock/schemas';
import type { BotWithNames } from './telegram.repository.js';

/**
 * A row as the Channels screen reads it. The token and the webhook secret are
 * reduced to "is there one", which is all REQUIREMENTS §5.1 lets leave the
 * server.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export interface TelegramViewContext {
  /** The install's public URL, which the webhook route hangs off. */
  readonly appUrl: string;
  readonly polling: boolean;
}

export const webhookUrlFor = (appUrl: string, botId: string): string =>
  new URL(telegramWebhookPath(botId), appUrl).toString();

/** The last characters of a token, which is all of it the screen shows. */
export const tokenHint = (token: string): string => token.slice(-TELEGRAM_TOKEN_HINT_LENGTH);

/** `plainToken` is the decrypted token, of which only {@link tokenHint} is kept. */
export const toTelegramBot = (
  { bot, departmentName, tokenUpdatedByName }: BotWithNames,
  context: TelegramViewContext,
  plainToken: string,
): TelegramBot => ({
  id: bot.id,
  username: bot.username,
  displayName: bot.displayName,
  departmentId: bot.departmentId,
  departmentName,
  tokenSet: bot.token !== '',
  tokenHint: tokenHint(plainToken),
  tokenUpdatedAt: bot.tokenUpdatedAt.toISOString(),
  tokenUpdatedByName,
  welcome: { en: bot.welcomeEn, ar: bot.welcomeAr },
  languagePrompt: bot.languagePrompt,
  languagePick: bot.languagePick,
  webhook: {
    url: bot.webhookUrl,
    setAt: iso(bot.webhookSetAt),
    expectedUrl: webhookUrlFor(context.appUrl, bot.id),
  },
  mode: context.polling ? 'polling' : 'webhook',
  health: {
    state: telegramBotHealth(bot),
    lastUpdateAt: iso(bot.lastUpdateAt),
    lastError: bot.lastError,
    lastErrorAt: iso(bot.lastErrorAt),
  },
  createdAt: bot.createdAt.toISOString(),
});

export const toTelegramDelivery = (row: TelegramDeliveryRow): TelegramDelivery => ({
  id: row.id,
  messageId: row.ticketMessageId,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: TELEGRAM_SEND_ATTEMPTS,
  lastError: row.lastError,
  sentAt: iso(row.sentAt),
  failedAt: iso(row.failedAt),
});
