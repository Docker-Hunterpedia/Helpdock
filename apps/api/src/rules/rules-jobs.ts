import { brands, type Db, type DbTransaction, ticketActivity, ticketMessages } from '@helpdock/db';
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
import { RULE_MAX_DEPTH } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ticketChangeSchema, type WakeCause, wakeCauseSchema } from '../tickets/ticket-events.js';
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
  wokeBy: wakeCauseSchema.optional(),
});

/** Adds the evaluation job. Its id comes from the outbox row, so a redelivery adds nothing. */
export interface RulesEvaluateQueue {
  add(payload: RulesEvaluatePayload): Promise<void>;
}

interface ReadMessage extends RepliedMessage {
  readonly id: string;
  readonly ticketId: string;
}

const repliedMessage = async (
  tx: DbTransaction,
  messageId: string | undefined,
): Promise<ReadMessage | undefined> => {
  if (messageId === undefined) {
    return undefined;
  }
  const [row] = await tx
    .select({
      id: ticketMessages.id,
      kind: ticketMessages.kind,
      authorType: ticketMessages.authorType,
      ticketId: ticketMessages.ticketId,
    })
    .from(ticketMessages)
    .where(eq(ticketMessages.id, messageId))
    .limit(1);
  return row;
};

/**
 * #368. Whether a customer's reply is what woke the ticket. Every channel
 * writes `ticket.woke` in the reply's own transaction, before the message, so
 * the two rows share a `created_at`; reading it here marks the event for all
 * of them at once rather than each channel's router.
 */
const wokeByReply = async (tx: DbTransaction, message: ReadMessage): Promise<boolean> => {
  if (message.authorType !== 'contact') {
    return false;
  }
  const [woke] = await tx
    .select({ id: ticketActivity.id })
    .from(ticketActivity)
    .where(
      and(
        eq(ticketActivity.ticketId, message.ticketId),
        eq(ticketActivity.action, 'ticket.woke'),
        // Compared in SQL: a JavaScript date would cut the microseconds both rows carry.
        eq(
          ticketActivity.createdAt,
          sql`(select ${ticketMessages.createdAt} from ${ticketMessages} where ${ticketMessages.id} = ${message.id})`,
        ),
        sql`${ticketActivity.to} ->> 'reason' = 'customer_reply'`,
      ),
    )
    .limit(1);

  return woke !== undefined;
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
    const message =
      event === RULE_SOURCE_EVENTS.replied ? await repliedMessage(tx, messageId) : undefined;
    const triggers = triggersFor(event, { changes, message });
    if (triggers.length === 0) {
      return;
    }

    const wokeBy: WakeCause | undefined =
      parsed.data.wokeBy ??
      (message !== undefined && (await wokeByReply(tx, message)) ? 'customer_reply' : undefined);

    await queue.add({
      brandId,
      ticketId,
      triggers,
      sourceOutboxId: outboxId,
      chain: ruleChain ?? [],
      ...(wokeBy === undefined ? {} : { wokeBy }),
    });
  };

/** What the rules module subscribes as, beside each event's own handler. */
export const RULES_SUBSCRIBER = 'rules';

/**
 * Called by the worker's start-up, before any consumer exists. The rules are a
 * named subscriber on every event they listen to: the module that writes an
 * event keeps its default slot. `rule.notify`, which the actions write, is
 * delivered by M3-07's notifications.
 */
export const registerRulesEventHandlers = (
  queue: RulesEvaluateQueue,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  const handler = createRulesSourceHandler(queue);
  for (const event of Object.values(RULE_SOURCE_EVENTS)) {
    dispatcher.register(event, handler, RULES_SUBSCRIBER);
  }
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
