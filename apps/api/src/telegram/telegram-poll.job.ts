import type { Keyring } from '@helpdock/config';
import { type Db, telegramBots } from '@helpdock/db';
import {
  type JobLogger,
  type OutboxEventHandler,
  parseJobPayload,
  TELEGRAM_POLL_INTERVAL_MS,
  telegramPollJob,
  telegramPollSchedulerId,
} from '@helpdock/jobs';
import { TELEGRAM_ERROR_MAX_LENGTH } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { withSystemJob } from '../tenant/system-job.js';
import { apiForBot, type TelegramApiFactory } from './bot-api-factory.js';
import type { TelegramRepository } from './telegram.repository.js';
import { telegramBotChangedEventSchema } from './telegram-events.js';
import type { TelegramInboundService } from './telegram-inbound.service.js';

/**
 * M6-01's long polling, for development (`TELEGRAM_POLLING=true`): one
 * `getUpdates` per bot per tick, each update through the same
 * {@link TelegramInboundService} the webhook uses, and the bot's offset moved
 * past it. In production nothing here runs; Telegram posts to the webhook.
 *
 * Telegram refuses `getUpdates` while a webhook is set, and the refusal is
 * recorded on the bot as its last error, where the Channels screen shows it.
 */

export interface TelegramPollDependencies {
  readonly db: Db;
  readonly log: JobLogger;
  readonly keyring: Keyring;
  readonly repository: TelegramRepository;
  readonly inbound: TelegramInboundService;
  readonly api: TelegramApiFactory;
  readonly now?: () => Date;
}

export const createTelegramPollProcessor =
  (deps: TelegramPollDependencies) =>
  async (job: { readonly data: unknown }): Promise<void> => {
    const { brandId, botId } = parseJobPayload(telegramPollJob, job.data);
    const jobId = `telegram.poll:${botId}`;
    const bot = await withSystemJob(deps.db, brandId, jobId, (tx) =>
      deps.repository.bot(tx, botId),
    );
    if (bot === undefined) {
      return;
    }

    let updates: unknown[];
    try {
      updates = await apiForBot(bot, deps.keyring, deps.api).getUpdates(bot.pollOffset);
    } catch (error) {
      const now = (deps.now ?? (() => new Date()))();
      const detail = error instanceof Error ? error.message : String(error);
      deps.log.warn({ botId, detail }, 'telegram getUpdates failed');
      await withSystemJob(deps.db, brandId, jobId, async (tx) => {
        await tx
          .update(telegramBots)
          .set({ lastError: detail.slice(0, TELEGRAM_ERROR_MAX_LENGTH), lastErrorAt: now })
          .where(eq(telegramBots.id, botId));
      });
      return;
    }

    for (const update of updates) {
      const updateId = (update as { update_id?: unknown }).update_id;
      try {
        await deps.inbound.receive({ id: botId, brandId }, update);
      } catch (error) {
        if (!(error instanceof ZodError)) {
          // The offset stays before this update, so the next tick tries it again.
          throw error;
        }
        deps.log.warn({ botId }, 'telegram update is not an update; skipped');
      }
      if (typeof updateId === 'number') {
        await withSystemJob(deps.db, brandId, jobId, async (tx) => {
          await tx
            .update(telegramBots)
            .set({ pollOffset: updateId + 1 })
            .where(eq(telegramBots.id, botId));
        });
      }
    }
  };

// --------------------------------------------------------------------------
// Scheduling
// --------------------------------------------------------------------------

/** What scheduling needs of BullMQ. The worker passes a queue; a test passes a double. */
export interface TelegramPollScheduler {
  upsert(bot: { readonly id: string; readonly brandId: string }): Promise<void>;
  remove(botId: string): Promise<void>;
}

export const queueTelegramPollScheduler = (queue: {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: unknown; opts: object },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<unknown>;
}): TelegramPollScheduler => ({
  upsert: async (bot) => {
    await queue.upsertJobScheduler(
      telegramPollSchedulerId(bot.id),
      { every: TELEGRAM_POLL_INTERVAL_MS },
      {
        name: telegramPollJob.name,
        data: { brandId: bot.brandId, botId: bot.id },
        opts: telegramPollJob.options,
      },
    );
  },
  remove: async (botId) => {
    await queue.removeJobScheduler(telegramPollSchedulerId(botId));
  },
});

/**
 * `telegram_bot.changed`: a bot added polls from now on, a bot removed stops.
 * With polling off it only removes, so switching the flag off and restarting
 * leaves no scheduler behind once each bot is next saved.
 */
export const createTelegramBotChangedHandler =
  (
    repository: TelegramRepository,
    scheduler: TelegramPollScheduler,
    polling: boolean,
  ): OutboxEventHandler =>
  async ({ tx, payload }) => {
    const { botId } = telegramBotChangedEventSchema.parse(payload);
    const bot = await repository.bot(tx, botId);
    if (polling && bot !== undefined) {
      await scheduler.upsert(bot);
    } else {
      await scheduler.remove(botId);
    }
  };

/** Every bot's poller, again, on worker boot (DOMAIN-RULES §10). Only with polling on. */
export const scheduleAllTelegramPollers = async (
  db: Db,
  repository: TelegramRepository,
  scheduler: TelegramPollScheduler,
): Promise<number> => {
  const bots = await repository.listAll(db, 'telegram.poll.schedule');
  for (const bot of bots) {
    await scheduler.upsert(bot);
  }
  return bots.length;
};
