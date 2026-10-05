import type { DbTransaction, TelegramBot } from '@helpdock/db';
import { silentLogger, TELEGRAM_POLL_INTERVAL_MS } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import type { TelegramRepository } from './telegram.repository.js';
import {
  createTelegramBotChangedHandler,
  queueTelegramPollScheduler,
  type TelegramPollScheduler,
} from './telegram-poll.job.js';

const brandId = '01924f00-0000-7000-8000-0000000000aa';
const botId = '01924f00-0000-7000-8000-0000000000dd';

const recorder = () => {
  const calls: string[] = [];
  const scheduler: TelegramPollScheduler = {
    upsert: async (bot) => void calls.push(`upsert:${bot.id}`),
    remove: async (id) => void calls.push(`remove:${id}`),
  };
  return { calls, scheduler };
};

const repositoryWith = (bot: Partial<TelegramBot> | undefined) =>
  ({ bot: async () => bot }) as unknown as TelegramRepository;

const run = (handler: ReturnType<typeof createTelegramBotChangedHandler>) =>
  handler({
    outboxId: 'o',
    brandId,
    event: 'telegram_bot.changed',
    payload: { botId },
    tx: {} as DbTransaction,
    log: silentLogger,
  });

describe('telegram_bot.changed', () => {
  it('starts polling a bot that exists when polling is on', async () => {
    const { calls, scheduler } = recorder();
    await run(
      createTelegramBotChangedHandler(repositoryWith({ id: botId, brandId }), scheduler, true),
    );
    expect(calls).toEqual([`upsert:${botId}`]);
  });

  it('stops polling a bot that was removed, or when polling is off', async () => {
    const { calls, scheduler } = recorder();
    await run(createTelegramBotChangedHandler(repositoryWith(undefined), scheduler, true));
    await run(
      createTelegramBotChangedHandler(repositoryWith({ id: botId, brandId }), scheduler, false),
    );
    expect(calls).toEqual([`remove:${botId}`, `remove:${botId}`]);
  });
});

it('schedules one poller per bot, every few seconds', async () => {
  const upserted: unknown[] = [];
  const removed: string[] = [];
  const scheduler = queueTelegramPollScheduler({
    upsertJobScheduler: async (...args) => void upserted.push(args),
    removeJobScheduler: async (id) => void removed.push(id),
  });

  await scheduler.upsert({ id: botId, brandId });
  await scheduler.remove(botId);

  expect(upserted).toEqual([
    [
      `telegram.poll.${botId}`,
      { every: TELEGRAM_POLL_INTERVAL_MS },
      expect.objectContaining({ name: 'telegram.poll', data: { brandId, botId } }),
    ],
  ]);
  expect(removed).toEqual([`telegram.poll.${botId}`]);
});
