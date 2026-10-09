import type { DbTransaction } from '@helpdock/db';
import {
  enqueueOutbox,
  type OutboxEventHandler,
  registerEventHandler,
  type TelegramSendPayload,
  telegramCsatNoticeSchema,
  telegramNoticeKindSchema,
} from '@helpdock/jobs';
import { z } from 'zod';

/**
 * M6's outbox events (DOMAIN-RULES §6).
 *
 * ```
 * agent reply  → telegram_deliveries + outbox(telegram.reply)    (one transaction)
 * /start, lang → outbox(telegram.notice)                         (the update's transaction)
 * relay        → BullMQ outbox.event                              (after commit)
 * worker       → this handler → BullMQ telegram.send              (jobId from the outbox id)
 * bot saved    → outbox(telegram_bot.changed) → the poller follows (development)
 * ```
 *
 * A message to a customer is a side effect like an email, so it goes through
 * the outbox like one: a reply that rolls back must not reach the chat, and a
 * webhook request never talks to Telegram itself.
 */

export const TELEGRAM_EVENTS = {
  reply: 'telegram.reply',
  notice: 'telegram.notice',
  botChanged: 'telegram_bot.changed',
} as const;

export const telegramReplyEventSchema = z.object({ deliveryId: z.uuid() });

export const telegramNoticeEventSchema = z.object({
  botId: z.uuid(),
  chatId: z.string().min(1).max(32),
  notice: telegramNoticeKindSchema,
  locale: z.enum(['en', 'ar']),
  callbackQueryId: z.string().min(1).max(128).optional(),
  /** The language prompt a `language_set` press was under, so the job can take its buttons away. */
  promptMessageId: z.string().min(1).max(32).optional(),
  csat: telegramCsatNoticeSchema.optional(),
});
export type TelegramNoticeEvent = z.infer<typeof telegramNoticeEventSchema>;

export const telegramBotChangedEventSchema = z.object({ botId: z.uuid() });

export const enqueueTelegramReply = (
  tx: DbTransaction,
  brandId: string,
  deliveryId: string,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: TELEGRAM_EVENTS.reply,
    payload: telegramReplyEventSchema.parse({ deliveryId }),
  });

export const enqueueTelegramNotice = (
  tx: DbTransaction,
  brandId: string,
  notice: TelegramNoticeEvent,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: TELEGRAM_EVENTS.notice,
    payload: telegramNoticeEventSchema.parse(notice),
  });

export const enqueueTelegramBotChanged = (
  tx: DbTransaction,
  brandId: string,
  botId: string,
): Promise<string> =>
  enqueueOutbox(tx, {
    brandId,
    event: TELEGRAM_EVENTS.botChanged,
    payload: telegramBotChangedEventSchema.parse({ botId }),
  });

/** The producer half of `telegram.send`; the worker hands it a BullMQ queue. */
export interface TelegramSendQueue {
  add(input: { readonly jobId: string; readonly payload: TelegramSendPayload }): Promise<void>;
}

/** BullMQ refuses a custom job id with a colon; the outbox id has none. */
export const telegramSendJobId = (outboxId: string): string => `telegram.send.${outboxId}`;

export const createTelegramReplyEventHandler =
  (queue: TelegramSendQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const { deliveryId } = telegramReplyEventSchema.parse(payload);
    await queue.add({
      jobId: telegramSendJobId(outboxId),
      payload: { kind: 'reply', brandId, deliveryId },
    });
  };

export const createTelegramNoticeEventHandler =
  (queue: TelegramSendQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const notice = telegramNoticeEventSchema.parse(payload);
    await queue.add({
      jobId: telegramSendJobId(outboxId),
      payload: { kind: 'notice', brandId, sourceOutboxId: outboxId, ...notice },
    });
  };

/** Called by the worker's start-up, before the consumer exists (`worker/start-worker.ts`). */
export const registerTelegramEventHandlers = ({
  queue,
  botChanged,
}: {
  readonly queue: TelegramSendQueue;
  readonly botChanged: OutboxEventHandler;
}): void => {
  registerEventHandler(TELEGRAM_EVENTS.reply, createTelegramReplyEventHandler(queue));
  registerEventHandler(TELEGRAM_EVENTS.notice, createTelegramNoticeEventHandler(queue));
  registerEventHandler(TELEGRAM_EVENTS.botChanged, botChanged);
};
