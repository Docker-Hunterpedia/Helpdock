import { TelegramBotApi } from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { TelegramBot as TelegramBotRow } from '@helpdock/db';

/**
 * A Bot API client for one token. The api and the worker build it from
 * `TELEGRAM_API_ROOT`; a test points it at a local stand-in for Telegram.
 */
export type TelegramApiFactory = (token: string) => TelegramBotApi;

/** `apiRoot` unset is Telegram's own server. */
export const telegramApiFactory =
  (apiRoot: string | undefined): TelegramApiFactory =>
  (token) =>
    new TelegramBotApi(apiRoot === undefined ? { token } : { token, apiRoot });

/** The client for a stored bot: its token is decrypted here and nowhere it could be logged. */
export const apiForBot = (
  bot: Pick<TelegramBotRow, 'token'>,
  keyring: Keyring,
  factory: TelegramApiFactory,
): TelegramBotApi => factory(decryptSecret(bot.token, keyring));
