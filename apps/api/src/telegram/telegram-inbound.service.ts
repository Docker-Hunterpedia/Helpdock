import {
  classifyUpdate,
  type InboundFile,
  TELEGRAM_DOWNLOAD_MAX_BYTES,
  TelegramApiFailure,
  type TelegramEvent,
  type TelegramMessageEvent,
  type TelegramSender,
  telegramExternalId,
  toTelegramInboundMessage,
} from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import {
  contactIdentities,
  contacts,
  type Db,
  type DbTransaction,
  type TelegramBot as TelegramBotRow,
  telegramBots,
  ticketMessages,
} from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import { TELEGRAM_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import type { StorageAttachmentSink } from '../channels/inbound/attachment-sink.js';
import type { InboundLog } from '../channels/inbound/inbound-email.service.js';
import { isUniqueViolation } from '../channels/pg-errors.js';
import type { CsatTelegramTaps } from '../csat/telegram-csat.js';
import { withSystemJob } from '../tenant/system-job.js';
import { isSenderBlocked } from '../ticketing/sender-gate.js';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { apiForBot, type TelegramApiFactory } from './bot-api-factory.js';
import type { BotLocator, TelegramRepository } from './telegram.repository.js';
import { enqueueTelegramNotice } from './telegram-events.js';
import type { TelegramConversationRouter, TelegramRouteOutcome } from './telegram-router.js';
import { telegramText } from './telegram-text.js';

/**
 * One Telegram update into one brand (M6-01 to M6-04): the part the webhook
 * and the development poller share, after each has found the bot.
 *
 * | The update is | What happens |
 * |---|---|
 * | a message | its files are fetched with `getFile` (outside any transaction), then in one system transaction: dedupe, the sender gate, the router |
 * | `/start` | the contact and chat are recorded and the language prompt (the welcome, if the bot does not ask) is asked for through the outbox (M6-04) |
 * | a language button | the contact's locale is set and the welcome in that language is asked for |
 * | a survey button | the score is recorded and the thanks, or "closed", is asked for (M8-06) |
 * | anything else | counted as received and dropped |
 *
 * Every reply to the customer — the prompt, the welcome, an agent's
 * answer — is an outbox row, never a call made here (DOMAIN-RULES §6). A
 * dropped or duplicate update still counts as delivered: Telegram's retry would
 * only be dropped again.
 */

export type TelegramInboundResult =
  | { readonly outcome: 'accepted'; readonly route: TelegramRouteOutcome }
  | { readonly outcome: 'welcomed' | 'language-set' | 'csat-rated' | 'csat-closed' }
  | { readonly outcome: 'duplicate' | 'ignored'; readonly reason: string };

export interface TelegramInboundServiceOptions {
  readonly db: Db;
  readonly repository: TelegramRepository;
  readonly router: TelegramConversationRouter;
  readonly lifecycleReads: TicketLifecycleRepository;
  readonly csatTaps: Pick<CsatTelegramTaps, 'tap'>;
  readonly keyring: Keyring;
  readonly api: TelegramApiFactory;
  /** A fresh sink per message, so a rolled-back message's uploads are its own to remove. */
  readonly sink: () => StorageAttachmentSink;
  readonly removeObject: (key: string) => Promise<void>;
  readonly log: InboundLog;
  readonly now?: () => Date;
}

export class TelegramInboundService {
  readonly #options: TelegramInboundServiceOptions;
  readonly #now: () => Date;

  constructor(options: TelegramInboundServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Throws a `ZodError` for a body that is not an update at all. */
  async receive(locator: BotLocator, raw: unknown): Promise<TelegramInboundResult> {
    const event = classifyUpdate(raw);
    const now = this.#now();
    const bot = await this.#system(locator, (tx) => this.#options.repository.bot(tx, locator.id));
    if (bot === undefined) {
      return { outcome: 'ignored', reason: 'bot-gone' };
    }

    try {
      const result = await this.#handle(bot, event, now);
      await this.#touch(bot, now, null);
      return result;
    } catch (error) {
      await this.#touch(bot, now, error);
      throw error;
    }
  }

  async #handle(
    bot: TelegramBotRow,
    event: TelegramEvent,
    now: Date,
  ): Promise<TelegramInboundResult> {
    switch (event.kind) {
      case 'ignored':
        return { outcome: 'ignored', reason: event.reason };
      case 'start':
        return this.#greet(bot, event, now);
      case 'language':
        return this.#setLanguage(bot, event, now);
      case 'csat':
        return this.#rate(bot, event, now);
      case 'message':
        return this.#file(bot, event, now);
    }
  }

  // ------------------------------------------------------------- messages

  async #file(
    bot: TelegramBotRow,
    event: TelegramMessageEvent,
    now: Date,
  ): Promise<TelegramInboundResult> {
    const externalId = telegramExternalId(bot.telegramId, event.sender.chatId, event.messageId);
    // Before any download: a redelivered photo is not fetched again, and a
    // blocked sender's never is.
    const early = await this.#system(bot, async (tx): Promise<TelegramInboundResult | null> => {
      if (await this.#seen(tx, bot.brandId, externalId)) {
        return { outcome: 'duplicate', reason: 'message-id' };
      }
      if (await this.#blocked(tx, bot, event.sender.chatId, now)) {
        return { outcome: 'ignored', reason: 'blocked-sender' };
      }
      return null;
    });
    if (early !== null) {
      return early;
    }

    const files = await this.#download(bot, event);
    const sink = this.#options.sink();
    try {
      return await this.#system(bot, async (tx): Promise<TelegramInboundResult> => {
        if (await this.#seen(tx, bot.brandId, externalId)) {
          return { outcome: 'duplicate', reason: 'message-id' };
        }

        const locale = await this.#localeOf(tx, bot.brandId, event.sender.chatId);
        const message = toTelegramInboundMessage(
          {
            event,
            botTelegramId: bot.telegramId,
            files,
            locationLabel: telegramText(locale)('thread.location'),
          },
          now,
        );
        const route = await this.#options.router.route(
          { tx, brandId: bot.brandId, bot: { id: bot.id, departmentId: bot.departmentId }, now },
          message,
          sink,
        );
        return { outcome: 'accepted', route };
      });
    } catch (error) {
      await this.#discard(sink.uploaded);
      if (isUniqueViolation(error)) {
        // Two deliveries of one update raced past the read above.
        return { outcome: 'duplicate', reason: 'message-id' };
      }
      throw error;
    }
  }

  /**
   * The message's files through `getFile`. One that cannot be fetched — over
   * the Bot API's 20 MB, or gone — is logged and left out rather than failing
   * the message, because Telegram would redeliver it forever.
   */
  async #download(bot: TelegramBotRow, event: TelegramMessageEvent): Promise<InboundFile[]> {
    if (event.files.length === 0) {
      return [];
    }
    const api = apiForBot(bot, this.#options.keyring, this.#options.api);
    const files: InboundFile[] = [];
    for (const ref of event.files) {
      if (ref.size !== null && ref.size > TELEGRAM_DOWNLOAD_MAX_BYTES) {
        this.#options.log.warn(
          { botId: bot.id, size: ref.size },
          'telegram file too large; skipped',
        );
        continue;
      }
      try {
        files.push({
          filename: ref.filename,
          contentType: ref.contentType,
          content: await api.downloadFile(ref.fileId),
          contentId: null,
          inline: false,
        });
      } catch (error) {
        if (!(error instanceof TelegramApiFailure) || error.kind === 'connect') {
          // Telegram unreachable: the update is worth retrying whole.
          throw error;
        }
        this.#options.log.warn(
          { botId: bot.id, detail: error.detail },
          'telegram file could not be fetched; skipped',
        );
      }
    }
    return files;
  }

  // ------------------------------------------------- /start and the language

  /**
   * M6-04: the language prompt with its two buttons when the bot asks for a
   * language, the welcome waiting for the press; otherwise the welcome at once,
   * in the contact's language.
   */
  async #greet(
    bot: TelegramBotRow,
    event: Extract<TelegramEvent, { kind: 'start' }>,
    now: Date,
  ): Promise<TelegramInboundResult> {
    return this.#system(bot, async (tx): Promise<TelegramInboundResult> => {
      if (await this.#blocked(tx, bot, event.sender.chatId, now)) {
        return { outcome: 'ignored', reason: 'blocked-sender' };
      }
      const { contact } = await this.#chatContact(tx, bot, event.sender, now);
      await enqueueTelegramNotice(tx, bot.brandId, {
        botId: bot.id,
        chatId: event.sender.chatId,
        notice: bot.languagePick ? 'language_prompt' : 'welcome',
        locale:
          contact.locale ??
          guessLocale(event.sender.languageCode) ??
          (await this.#options.lifecycleReads.localeForContact(tx, bot.brandId, null)),
      });
      return { outcome: 'welcomed' };
    });
  }

  async #setLanguage(
    bot: TelegramBotRow,
    event: Extract<TelegramEvent, { kind: 'language' }>,
    now: Date,
  ): Promise<TelegramInboundResult> {
    return this.#system(bot, async (tx): Promise<TelegramInboundResult> => {
      if (await this.#blocked(tx, bot, event.sender.chatId, now)) {
        return { outcome: 'ignored', reason: 'blocked-sender' };
      }
      const { contact, chat } = await this.#chatContact(tx, bot, event.sender, now);
      await this.#options.repository.markLanguageChosen(tx, chat.id, now);
      await tx
        .update(contacts)
        .set({ locale: event.locale, updatedAt: now })
        .where(eq(contacts.id, contact.id));
      await enqueueTelegramNotice(tx, bot.brandId, {
        botId: bot.id,
        chatId: event.sender.chatId,
        notice: 'language_set',
        locale: event.locale,
        callbackQueryId: event.callbackQueryId,
        promptMessageId: event.messageId,
      });
      return { outcome: 'language-set' };
    });
  }

  /** M8-06: a score under the survey, recorded in one tap; a late or second tap is told so. */
  async #rate(
    bot: TelegramBotRow,
    event: Extract<TelegramEvent, { kind: 'csat' }>,
    now: Date,
  ): Promise<TelegramInboundResult> {
    return this.#system(bot, async (tx): Promise<TelegramInboundResult> => {
      const outcome = await this.#options.csatTaps.tap(tx, {
        brandId: bot.brandId,
        chatId: event.sender.chatId,
        surveyId: event.surveyId,
        rating: event.rating,
        at: now,
      });
      await enqueueTelegramNotice(tx, bot.brandId, {
        botId: bot.id,
        chatId: event.sender.chatId,
        notice: outcome === 'rated' ? 'csat_rated' : 'csat_closed',
        locale: await this.#localeOf(tx, bot.brandId, event.sender.chatId),
        callbackQueryId: event.callbackQueryId,
        csat: {
          surveyId: event.surveyId,
          messageId: event.messageId,
          ...(outcome === 'rated' ? { rating: event.rating } : {}),
        },
      });
      return { outcome: outcome === 'rated' ? 'csat-rated' : 'csat-closed' };
    });
  }

  async #chatContact(tx: DbTransaction, bot: TelegramBotRow, sender: TelegramSender, now: Date) {
    const contact = await this.#options.router.contactFor(tx, bot.brandId, sender);
    const chat = await this.#options.repository.upsertChat(tx, {
      brandId: bot.brandId,
      botId: bot.id,
      chatId: sender.chatId,
      contactId: contact.id,
      at: now,
      username: sender.username,
    });
    return { contact, chat };
  }

  // --------------------------------------------------------------------

  #system<T>(bot: BotLocator, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withSystemJob(this.#options.db, bot.brandId, `telegram:${bot.id}`, fn);
  }

  /** M1-11's gate, before any contact or ticket is written. */
  async #blocked(tx: DbTransaction, bot: TelegramBotRow, chatId: string, now: Date) {
    const gate = await isSenderBlocked(
      tx,
      bot.brandId,
      { kind: 'telegram', value: chatId },
      { now },
    );
    return gate.blocked;
  }

  async #seen(tx: DbTransaction, brandId: string, externalId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.brandId, brandId),
          eq(ticketMessages.channel, 'telegram'),
          eq(ticketMessages.externalMessageId, externalId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The contact's language for the words a message is filed with ("Location"). */
  async #localeOf(tx: DbTransaction, brandId: string, chatId: string): Promise<Locale> {
    const rows = await tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.brandId, brandId),
          eq(contactIdentities.kind, 'telegram'),
          eq(contactIdentities.value, chatId),
        ),
      )
      .limit(1);
    return this.#options.lifecycleReads.localeForContact(tx, brandId, rows[0]?.contactId ?? null);
  }

  /** The bot's health: when it last heard from Telegram, and what last went wrong. */
  async #touch(bot: TelegramBotRow, now: Date, error: unknown): Promise<void> {
    const values =
      error === null
        ? { lastUpdateAt: now }
        : {
            lastError: (error instanceof TelegramApiFailure ? error.detail : describe(error)).slice(
              0,
              TELEGRAM_ERROR_MAX_LENGTH,
            ),
            lastErrorAt: now,
          };
    await this.#system(bot, async (tx) => {
      await tx.update(telegramBots).set(values).where(eq(telegramBots.id, bot.id));
    }).catch((recordError: unknown) => {
      this.#options.log.warn(
        { botId: bot.id, err: recordError },
        'could not record telegram health',
      );
    });
  }

  async #discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.#options.removeObject(key);
      } catch (error) {
        this.#options.log.warn({ key, err: error }, 'could not remove an orphaned telegram file');
      }
    }
  }
}

/** Telegram's `language_code` for a contact who has not chosen yet. */
const guessLocale = (languageCode: string | null): Locale | undefined => {
  if (languageCode === null) {
    return undefined;
  }
  const primary = languageCode.toLowerCase().split('-')[0];
  return primary === 'ar' || primary === 'en' ? primary : undefined;
};

/** A pipeline failure's class and message, for the bot's health line. Never a body. */
const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
