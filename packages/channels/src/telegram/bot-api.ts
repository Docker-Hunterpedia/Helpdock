import { Api, GrammyError, HttpError, InputFile } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';

/**
 * The Bot API calls Helpdock makes (M6-01), over grammY's typed `Api`.
 *
 * The host is fixed — `https://api.telegram.org` — and never comes from a
 * request, so these calls do not go through the SSRF-safe client of
 * DOMAIN-RULES §13. `apiRoot` exists for a self-hosted Bot API server and for
 * the tests, which stand a local HTTP server in for Telegram; it is the
 * operator's `TELEGRAM_API_ROOT`, not anything a customer or an Admin types.
 */

export const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';

/** The Bot API serves files up to 20 MB through `getFile`. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Telegram's limit on one message's text. */
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4_096;

const TIMEOUT_SECONDS = 30;

export interface TelegramBotIdentity {
  readonly id: number;
  readonly username: string;
  /** The bot's display name in Telegram (`first_name`). */
  readonly name: string;
}

/** A file an agent attached to a reply, as bytes, for `sendPhoto` or `sendDocument`. */
export interface TelegramOutgoingFile {
  readonly bytes: Buffer;
  readonly fileName: string;
}

export interface TelegramWebhookInfo {
  readonly url: string;
  readonly pendingUpdateCount: number;
  readonly lastErrorAt: Date | null;
  readonly lastErrorMessage: string | null;
}

/** The updates Helpdock asks Telegram for, and nothing else. */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

/** A refused or unreachable Bot API call, with words fit for an Admin to read. */
export class TelegramApiFailure extends Error {
  /** `token` when Telegram refused the token itself; `connect` when it could not be reached. */
  readonly kind: 'token' | 'refused' | 'connect';
  /** Telegram's `description`, or the transport's message. Never the token. */
  readonly detail: string;
  /**
   * Telegram said no to this request for good — the chat is gone, the bot was
   * blocked, the text was refused — so asking again will not help. A 429 or a
   * 5xx is not permanent.
   */
  readonly permanent: boolean;

  constructor(kind: TelegramApiFailure['kind'], detail: string, permanent = false) {
    super(detail);
    this.name = 'TelegramApiFailure';
    this.kind = kind;
    this.detail = detail;
    this.permanent = permanent;
  }
}

/** Any thrown value as a {@link TelegramApiFailure}, without the token in it. */
export const toTelegramFailure = (error: unknown, token?: string): TelegramApiFailure => {
  if (error instanceof TelegramApiFailure) {
    return error;
  }
  if (error instanceof GrammyError) {
    const kind = error.error_code === 401 || error.error_code === 404 ? 'token' : 'refused';
    return new TelegramApiFailure(
      kind,
      `${String(error.error_code)}: ${error.description}`,
      error.error_code === 400 || error.error_code === 403,
    );
  }
  const message =
    error instanceof HttpError || error instanceof Error ? error.message : String(error);

  return new TelegramApiFailure('connect', redact(message, token));
};

const redact = (text: string, token: string | undefined): string =>
  token === undefined || token === '' ? text : text.split(token).join('<token>');

export interface TelegramBotApiOptions {
  readonly token: string;
  readonly apiRoot?: string;
}

export class TelegramBotApi {
  readonly #api: Api;
  readonly #token: string;
  readonly #apiRoot: string;

  constructor({ token, apiRoot = DEFAULT_TELEGRAM_API_ROOT }: TelegramBotApiOptions) {
    this.#token = token;
    this.#apiRoot = apiRoot.replace(/\/+$/, '');
    this.#api = new Api(token, { apiRoot: this.#apiRoot, timeoutSeconds: TIMEOUT_SECONDS });
  }

  async getMe(): Promise<TelegramBotIdentity> {
    const me = await this.#call(() => this.#api.getMe());
    return { id: me.id, username: me.username, name: me.first_name };
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.#call(() =>
      this.#api.setWebhook(url, {
        secret_token: secretToken,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      }),
    );
  }

  /** Stops Telegram posting to this install; pending updates are dropped with it. */
  async deleteWebhook(): Promise<void> {
    await this.#call(() => this.#api.deleteWebhook({ drop_pending_updates: true }));
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const info = await this.#call(() => this.#api.getWebhookInfo());
    return {
      url: info.url ?? '',
      pendingUpdateCount: info.pending_update_count,
      lastErrorAt:
        info.last_error_date === undefined ? null : new Date(info.last_error_date * 1_000),
      lastErrorMessage: info.last_error_message ?? null,
    };
  }

  /** Long polling for development: what has arrived since `offset`, without waiting. */
  async getUpdates(offset: number | null): Promise<unknown[]> {
    return this.#call(() =>
      this.#api.getUpdates({
        ...(offset === null ? {} : { offset }),
        timeout: 0,
        allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      }),
    );
  }

  /** Telegram's id for the message it accepted. */
  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<string> {
    const sent = await this.#call(() =>
      this.#api.sendMessage(
        chatId,
        text,
        replyMarkup === undefined ? {} : { reply_markup: replyMarkup },
      ),
    );
    return String(sent.message_id);
  }

  /** Telegram's id for the photo message it accepted. */
  async sendPhoto(chatId: string, file: TelegramOutgoingFile): Promise<string> {
    const sent = await this.#call(() =>
      this.#api.sendPhoto(chatId, new InputFile(file.bytes, file.fileName)),
    );
    return String(sent.message_id);
  }

  /** Telegram's id for the document message it accepted. */
  async sendDocument(chatId: string, file: TelegramOutgoingFile): Promise<string> {
    const sent = await this.#call(() =>
      this.#api.sendDocument(chatId, new InputFile(file.bytes, file.fileName)),
    );
    return String(sent.message_id);
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.#call(() => this.#api.answerCallbackQuery(callbackQueryId));
  }

  /** `getFile`, then the file's bytes, refusing anything past `maxBytes`. */
  async downloadFile(fileId: string, maxBytes = TELEGRAM_DOWNLOAD_MAX_BYTES): Promise<Buffer> {
    const file = await this.#call(() => this.#api.getFile(fileId));
    if (file.file_path === undefined) {
      throw new TelegramApiFailure('refused', 'Telegram gave no path for the file');
    }
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new TelegramApiFailure('refused', `The file is larger than ${String(maxBytes)} bytes`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.#apiRoot}/file/bot${this.#token}/${file.file_path}`, {
        signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1_000),
      });
    } catch (error) {
      throw toTelegramFailure(error, this.#token);
    }
    if (!response.ok || response.body === null) {
      throw new TelegramApiFailure('refused', `${String(response.status)}: file download refused`);
    }

    return readCapped(response.body, maxBytes);
  }

  async #call<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toTelegramFailure(error, this.#token);
    }
  }
}

const readCapped = async (body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new TelegramApiFailure('refused', `The file is larger than ${String(maxBytes)} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};
