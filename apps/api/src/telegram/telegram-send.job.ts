import {
  languageKeyboard,
  splitTelegramText,
  TelegramApiFailure,
  type TelegramBotApi,
  toTelegramFailure,
} from '@helpdock/channels';
import type { Keyring } from '@helpdock/config';
import {
  type Db,
  type DbTransaction,
  type TelegramBot as TelegramBotRow,
  ticketMessages,
  withSystem,
} from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import {
  createJobProcessor,
  type JobHandler,
  type JobLogger,
  type TelegramSendPayload,
  telegramSendJob,
  telegramSendPayloadSchema,
} from '@helpdock/jobs';
import { TELEGRAM_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { CsatTelegramNotices } from '../csat/telegram-csat.js';
import type { ObjectStorage } from '../media/storage.js';
import { apiForBot, type TelegramApiFactory } from './bot-api-factory.js';
import type { TelegramRepository } from './telegram.repository.js';
import { planOutgoingFile, readOutgoingFile, replyAttachments } from './telegram-attachments.js';

/**
 * The `telegram.send` consumer (M6-02, M6-04): an agent's reply to its chat,
 * or the `/start` welcome and the language confirmation.
 *
 * **Idempotent** (DOMAIN-RULES §6). The receipt — `telegram.send:<delivery>`
 * or `telegram.notice:<outbox row>` — is claimed in the job's transaction, so
 * a second delivery of the job sends nothing; a reply already `sent` is
 * skipped, which holds after receipts are purged. A reply is several parts —
 * the text, cut at 4096 characters, then each attachment as a photo or a
 * document — and each one Telegram accepts is recorded at once, in a
 * transaction of its own, so a retry starts after the last part that landed
 * and the customer never reads a part twice. An attachment the media
 * pipeline is still working on fails the attempt, which BullMQ retries.
 *
 * **Failure** is recorded outside the job's transaction, which rolls back on a
 * throw, as `email.send` records it: every attempt counts, and the last one —
 * or the first, when Telegram's refusal is permanent (the bot was blocked, the
 * chat is gone) — moves the delivery to `failed`, which the thread shows.
 */

export interface TelegramSendDependencies {
  readonly db: Db;
  readonly repository: TelegramRepository;
  readonly keyring: Keyring;
  readonly api: TelegramApiFactory;
  /** Where an agent's attachments are read from. */
  readonly storage: ObjectStorage;

  /** M8-06: the survey, the thanks after a tap, and "This survey has closed." */
  readonly csat: Pick<CsatTelegramNotices, 'send'>;
  readonly now?: () => Date;
}

/** An attachment of the reply is not ready yet; retrying later is the answer. */
export class AttachmentNotReadyError extends Error {
  constructor() {
    super('An attachment of the reply is still being processed');
    this.name = 'AttachmentNotReadyError';
  }
}

const t = (locale: Locale) => createI18n({ lng: locale }).getFixedT(locale, 'telegram');

export const createTelegramSendHandler =
  (deps: TelegramSendDependencies): JobHandler<TelegramSendPayload> =>
  async ({ payload, brandId, tx, log }) => {
    if (payload.kind === 'reply') {
      await sendReply(deps, tx, payload, log);
      return;
    }

    const bot = await deps.repository.bot(tx, payload.botId);
    if (bot === undefined) {
      log.info({ brandId, botId: payload.botId }, 'telegram notice skipped: the bot is gone');
      return;
    }
    const api = apiForBot(bot, deps.keyring, deps.api);
    await withPermanentAsFinal(async () => {
      if (payload.notice.startsWith('csat_')) {
        await deps.csat.send(api, tx, payload, log);
        return;
      }
      if (payload.notice === 'welcome') {
        await sendWelcome(api, bot, payload.chatId, payload.locale);
        return;
      }
      if (payload.callbackQueryId !== undefined) {
        // A press answered late has stopped spinning anyway; the confirmation still matters.
        await api.answerCallbackQuery(payload.callbackQueryId).catch(() => undefined);
      }
      await api.sendMessage(payload.chatId, t(payload.locale)('bot.languageSet'));
    });
    log.info({ brandId, botId: bot.id, notice: payload.notice }, 'telegram notice sent');
  };

/** M6-04: the bot's own welcome in that language, or the catalog's, with the buttons if it offers them. */
const sendWelcome = async (
  api: TelegramBotApi,
  bot: TelegramBotRow,
  chatId: string,
  locale: Locale,
): Promise<void> => {
  const own = locale === 'ar' ? bot.welcomeAr : bot.welcomeEn;
  const welcome = own === null || own.trim() === '' ? t(locale)('bot.welcome') : own;
  if (!bot.languagePick) {
    await api.sendMessage(chatId, welcome);
    return;
  }
  await api.sendMessage(
    chatId,
    `${welcome}\n\n${t(locale)('bot.languagePrompt')}`,
    languageKeyboard(),
  );
};

const sendReply = async (
  deps: TelegramSendDependencies,
  tx: DbTransaction,
  payload: Extract<TelegramSendPayload, { kind: 'reply' }>,
  log: JobLogger,
): Promise<void> => {
  const delivery = await deps.repository.delivery(tx, payload.deliveryId);
  // Only a queued reply is sent; `failed` is put back by Retry, which sets `queued` first.
  if (delivery === undefined || delivery.status !== 'queued') {
    log.info(
      {
        brandId: payload.brandId,
        deliveryId: payload.deliveryId,
        status: delivery?.status ?? null,
      },
      'telegram.send skipped: nothing queued to send',
    );
    return;
  }
  const bot = await deps.repository.bot(tx, delivery.botId);
  const rows = await tx
    .select({ bodyText: ticketMessages.bodyText })
    .from(ticketMessages)
    .where(eq(ticketMessages.id, delivery.ticketMessageId))
    .limit(1);
  const message = rows[0];
  /* c8 ignore next 3 -- both cascade-delete the delivery with them. */
  if (bot === undefined || message === undefined) {
    return;
  }

  const api = apiForBot(bot, deps.keyring, deps.api);
  const texts = splitTelegramText(message.bodyText);
  const files = await replyAttachments(tx, delivery.ticketMessageId);
  // Every attachment is a part, sent or skipped, so a part's index never moves
  // between attempts.
  const parts: (() => Promise<string | null>)[] = [
    ...texts.map((text) => () => api.sendMessage(delivery.chatId, text)),
    ...files.map((file) => async () => {
      const plan = planOutgoingFile(file);
      if (plan.kind === 'wait') {
        throw new AttachmentNotReadyError();
      }
      if (plan.kind === 'skip') {
        log.info(
          { brandId: payload.brandId, deliveryId: delivery.id, attachmentId: file.id },
          'telegram reply: an attachment cannot be sent and is left out',
        );
        return null;
      }
      const outgoing = await readOutgoingFile(deps.storage, file, plan.variant);
      return plan.method === 'photo'
        ? api.sendPhoto(delivery.chatId, outgoing)
        : api.sendDocument(delivery.chatId, outgoing);
    }),
  ];
  await withPermanentAsFinal(async () => {
    for (const send of parts.slice(delivery.partsSent)) {
      const sentId = await send();
      await withSystem(deps.db, payload.brandId, (partTx) =>
        deps.repository.recordPart(partTx, delivery.id, sentId),
      );
    }
  });
  await deps.repository.markSent(tx, delivery.id, (deps.now ?? (() => new Date()))());
  log.info(
    { brandId: payload.brandId, deliveryId: delivery.id, parts: parts.length },
    'telegram reply sent',
  );
};

/** A refusal retrying cannot change ends the job now rather than five attempts later. */
const withPermanentAsFinal = async (send: () => Promise<void>): Promise<void> => {
  try {
    await send();
  } catch (error) {
    if (error instanceof AttachmentNotReadyError) {
      throw error;
    }
    const failure = toTelegramFailure(error);
    if (failure.permanent) {
      throw new UnrecoverableError(failure.detail);
    }
    throw failure;
  }
};

/** Whether this attempt is the job's last: BullMQ counts the ones before it. */
const isLastAttempt = (job: Job, error: unknown): boolean =>
  error instanceof UnrecoverableError ||
  job.attemptsMade + 1 >= (job.opts.attempts ?? telegramSendJob.options.attempts ?? 1);

const errorText = (error: unknown): string =>
  (error instanceof TelegramApiFailure ||
  error instanceof UnrecoverableError ||
  error instanceof AttachmentNotReadyError
    ? error.message
    : 'The reply could not be sent'
  ).slice(0, TELEGRAM_ERROR_MAX_LENGTH);

export const createTelegramSendProcessor = ({
  db,
  log,
  repository,
  handler,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly log: JobLogger;
  readonly repository: TelegramRepository;
  readonly handler: JobHandler<TelegramSendPayload>;
  readonly now?: () => Date;
}) => {
  const process = createJobProcessor(telegramSendJob, handler, { db, log });

  return async (job: Job): Promise<void> => {
    try {
      await process(job);
    } catch (error) {
      const parsed = telegramSendPayloadSchema.safeParse(job.data);
      if (parsed.success && parsed.data.kind === 'reply') {
        const { brandId, deliveryId } = parsed.data;
        await withSystem(db, brandId, (tx) =>
          repository.recordFailure(tx, deliveryId, {
            attempts: job.attemptsMade + 1,
            error: errorText(error),
            dead: isLastAttempt(job, error),
            at: now(),
          }),
        ).catch((recordError: unknown) => {
          log.error(
            { err: recordError, jobId: job.id },
            'could not record a telegram.send failure',
          );
        });
      }
      throw error;
    }
  };
};
