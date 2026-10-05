import type { DbTransaction } from '@helpdock/db';
import { silentLogger, type TelegramSendPayload } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  createTelegramNoticeEventHandler,
  createTelegramReplyEventHandler,
  TELEGRAM_EVENTS,
  telegramSendJobId,
} from './telegram-events.js';

const brandId = '01924f00-0000-7000-8000-0000000000aa';
const outboxId = '01924f00-0000-7000-8000-0000000000bb';
const deliveryId = '01924f00-0000-7000-8000-0000000000cc';
const botId = '01924f00-0000-7000-8000-0000000000dd';

const capture = () => {
  const added: { jobId: string; payload: TelegramSendPayload }[] = [];
  return { added, queue: { add: async (input: (typeof added)[number]) => void added.push(input) } };
};

const context = (event: string, payload: Record<string, unknown>) => ({
  outboxId,
  brandId,
  event,
  payload,
  tx: {} as DbTransaction,
  log: silentLogger,
});

describe('the Telegram outbox handlers', () => {
  it('turns a reply into one telegram.send job under the outbox row’s id', async () => {
    const { added, queue } = capture();
    await createTelegramReplyEventHandler(queue)(context(TELEGRAM_EVENTS.reply, { deliveryId }));

    expect(added).toEqual([
      { jobId: `telegram.send.${outboxId}`, payload: { kind: 'reply', brandId, deliveryId } },
    ]);
    expect(telegramSendJobId(outboxId)).not.toContain(':');
  });

  it('turns a notice into a job that remembers the row that asked for it', async () => {
    const { added, queue } = capture();
    await createTelegramNoticeEventHandler(queue)(
      context(TELEGRAM_EVENTS.notice, {
        botId,
        chatId: '42',
        notice: 'language_set',
        locale: 'ar',
        callbackQueryId: 'cq',
      }),
    );

    expect(added[0]?.payload).toEqual({
      kind: 'notice',
      brandId,
      sourceOutboxId: outboxId,
      botId,
      chatId: '42',
      notice: 'language_set',
      locale: 'ar',
      callbackQueryId: 'cq',
    });
  });

  it('refuses a payload it cannot trust, so the event lands in the failed set', async () => {
    const { queue } = capture();
    await expect(
      createTelegramReplyEventHandler(queue)(context(TELEGRAM_EVENTS.reply, { deliveryId: 'x' })),
    ).rejects.toThrow();
  });
});
