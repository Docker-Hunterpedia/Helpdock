import { brands, type Db, type DbTransaction, ticketMessages } from '@helpdock/db';
import {
  createJobProcessor,
  type JobLogger,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
  type RulesEvaluatePayload,
  type RulesTimeBasedPayload,
  rulesEvaluateJob,
  rulesTimeBasedJob,
  rulesTimeBasedJobId,
  rulesTimeBasedScheduleJob,
} from '@helpdock/jobs';
import { RULE_MAX_DEPTH, RULE_NOTIFY_EVENT, ruleNotifyPayloadSchema } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ticketChangeSchema } from '../tickets/ticket-events.js';
import { evaluateEventRules, type RulesEngineDeps, runScheduledRules } from './engine.js';
import { type RepliedMessage, RULE_SOURCE_EVENTS, triggersFor } from './triggers.js';

/**
 * How M3-03 and M3-04 are wired into the worker.
 *
 * ```
 * ticket change  →  outbox row (ticket.*, sla.*, csat.*)       (the change's transaction)
 * relay          →  outbox.event job                             (after commit)
 * this handler   →  rules.evaluate job, jobId from the outbox id  (worker)
 * rules worker   →  engine: conditions, depth guard, actions, log (brand's system transaction)
 * actions        →  outbox rows carrying the rule chain           (same transaction)
 * ```
 *
 * The extra hop onto the `rules` queue is ARCHITECTURE §13's: rules have a
 * queue of their own, so a rule that fails is retried on its own and never
 * holds up the socket frame, the clock or the notification the same event
 * carries. Nothing here is started by a request handler.
 */

/** What the rules module reads of any event it listens to. Other fields are the event's own. */
const sourcePayloadSchema = z.object({
  ticketId: z.uuid(),
  changes: z.array(ticketChangeSchema).optional(),
  messageId: z.uuid().optional(),
  ruleChain: z.array(z.uuid()).max(RULE_MAX_DEPTH).optional(),
});

/** Adds the evaluation job. Its id comes from the outbox row, so a redelivery adds nothing. */
export interface RulesEvaluateQueue {
  add(payload: RulesEvaluatePayload): Promise<void>;
}

const repliedMessage = async (
  tx: DbTransaction,
  messageId: string | undefined,
): Promise<RepliedMessage | undefined> => {
  if (messageId === undefined) {
    return undefined;
  }
  const [row] = await tx
    .select({ kind: ticketMessages.kind, authorType: ticketMessages.authorType })
    .from(ticketMessages)
    .where(eq(ticketMessages.id, messageId))
    .limit(1);
  return row;
};

export const createRulesSourceHandler =
  (queue: RulesEvaluateQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, event, payload, tx }) => {
    const parsed = sourcePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      // An event with no ticket in it — a payload shape some later milestone
      // chose — is nothing a ticket rule can act on.
      return;
    }

    const { ticketId, changes, messageId, ruleChain } = parsed.data;
    const triggers = triggersFor(event, {
      changes,
      message:
        event === RULE_SOURCE_EVENTS.replied ? await repliedMessage(tx, messageId) : undefined,
    });
    if (triggers.length === 0) {
      return;
    }

    await queue.add({
      brandId,
      ticketId,
      triggers,
      sourceOutboxId: outboxId,
      chain: ruleChain ?? [],
    });
  };

/**
 * `rule.notify` is M3-07's to deliver. Until its handler is registered beside
 * this one, the event is logged and dropped rather than failing as unknown and
 * filling the dead-letter set: a notification that never arrives is the gap
 * M3-07 closes, a failed job per rule run would be noise on top of it.
 */
export const logRuleNotify: OutboxEventHandler = ({ brandId, outboxId, payload, log }) => {
  const parsed = ruleNotifyPayloadSchema.safeParse(payload);
  log.info(
    {
      event: RULE_NOTIFY_EVENT,
      brandId,
      outboxId,
      ticketId: parsed.success ? parsed.data.ticketId : undefined,
      recipients: parsed.success ? parsed.data.recipients.length : undefined,
    },
    'rule notification written',
  );
  return Promise.resolve();
};

/**
 * Called by the worker's start-up, before any consumer exists, and before
 * M3-02's handlers: those log `sla.warning` and `sla.breached` only where
 * nothing has claimed them, and these claim them.
 */
export const registerRulesEventHandlers = (
  queue: RulesEvaluateQueue,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  const handler = createRulesSourceHandler(queue);
  for (const event of Object.values(RULE_SOURCE_EVENTS)) {
    dispatcher.register(event, handler);
  }
  dispatcher.register(RULE_NOTIFY_EVENT, logRuleNotify);
};

export interface RulesTimeBasedQueue {
  add(payload: RulesTimeBasedPayload, jobId: string): Promise<void>;
}

/** The five-minute tick this run belongs to, so two firings in one tick add one job per brand. */
export const tickOf = (now: Date): string => {
  const tick = new Date(now);
  tick.setUTCSeconds(0, 0);
  tick.setUTCMinutes(tick.getUTCMinutes() - (tick.getUTCMinutes() % 5));
  return tick.toISOString();
};

/**
 * The cron tick: one `rules.time_based` job per active brand. `brands` is a
 * global table, so this read needs no tenant context, and it reads nothing
 * but ids.
 */
export const scheduleTimeBasedRules = async ({
  db,
  queue,
  now,
}: {
  readonly db: Db;
  readonly queue: RulesTimeBasedQueue;
  readonly now: Date;
}): Promise<number> => {
  const active = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  const tick = tickOf(now);

  for (const { id: brandId } of active) {
    const payload = { brandId, tick };
    await queue.add(payload, rulesTimeBasedJobId(payload));
  }
  return active.length;
};

export interface RulesProcessorOptions {
  readonly db: Db;
  readonly log: JobLogger;
  readonly queue: RulesTimeBasedQueue;
  readonly engine: RulesEngineDeps;
  readonly now?: () => Date;
}

/**
 * The `rules` queue's one processor. BullMQ routes by queue, so it dispatches on
 * the job name; the two brand jobs go through `createJobProcessor`, which
 * validates the payload, opens the brand's system transaction and claims the
 * receipt before the engine runs.
 */
export const createRulesProcessor = ({
  db,
  log,
  queue,
  engine,
  now = () => new Date(),
}: RulesProcessorOptions): ((job: Job) => Promise<void>) => {
  const evaluate = createJobProcessor(
    rulesEvaluateJob,
    async ({ payload, tx }) => {
      const verdicts = await evaluateEventRules(engine, tx, payload);
      log.info(
        { job: rulesEvaluateJob.name, ticketId: payload.ticketId, runs: verdicts.length },
        'rules evaluated',
      );
    },
    { db, log },
  );
  const timeBased = createJobProcessor(
    rulesTimeBasedJob,
    async ({ payload, tx }) => {
      const result = await runScheduledRules(engine, tx, payload);
      log.info(
        { job: rulesTimeBasedJob.name, brandId: payload.brandId, ...result },
        'time-based rules ran',
      );
    },
    { db, log },
  );

  return async (job) => {
    switch (job.name) {
      case rulesEvaluateJob.name:
        return evaluate(job);
      case rulesTimeBasedJob.name:
        return timeBased(job);
      case rulesTimeBasedScheduleJob.name: {
        const brandsScheduled = await scheduleTimeBasedRules({ db, queue, now: now() });
        log.info({ job: job.name, brands: brandsScheduled }, 'time-based rules scheduled');
        return;
      }
      default:
        throw new UnrecoverableError(
          `The rules queue received job ${job.name}, which no processor here handles.`,
        );
    }
  };
};
