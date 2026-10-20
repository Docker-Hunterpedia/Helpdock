import { type DbTransaction, ticketStatuses, tickets } from '@helpdock/db';
import {
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
  type TicketUnsnoozePayload,
  ticketUnsnoozeJob,
  ticketUnsnoozeJobId,
} from '@helpdock/jobs';
import type { Queue } from 'bullmq';
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { SlaRepository } from '../../sla/sla.repository.js';
import type { SlaService } from '../../sla/sla.service.js';
import { SNOOZE_EVENTS, ticketSnoozedPayloadSchema } from './snooze-events.js';
import { isSnoozedStatus, wakeTicket } from './snooze-wake.js';

/**
 * The worker's half of M14-02 (DOMAIN-RULES §3.4).
 *
 * ```
 * request  →  ticket + activity + outbox(ticket.snoozed)      one transaction
 * worker   →  ticket.snoozed handler → delayed ticket.unsnooze, id snooze.<ticket>.<version>
 * timer    →  unsnoozeTicket → ticket + activity + outbox(ticket.snooze_ended)   one transaction
 * boot     →  snooze.rebuild → every brand → wake what is due, re-add the rest
 * ```
 *
 * The timer is a nudge and the ticket row is the truth: the job does nothing
 * unless the ticket is still Snoozed at the version it was planned for and the
 * time has come, so a customer reply, a *Wake now*, a newer snooze or a lost
 * Redis can each leave a job behind without anything happening twice.
 */

export interface SnoozeTimer {
  readonly jobId: string;
  readonly fireAt: Date;
  readonly payload: TicketUnsnoozePayload;
}

/** What the handlers need of a queue, so the rules can be proved without Redis. */
export interface SnoozeTimerQueue {
  /** Adds the timer, or moves an existing one to `fireAt`. */
  upsert(timer: SnoozeTimer, now: Date): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export interface SnoozeWorkerDeps {
  readonly repository: SlaRepository;
  readonly sla: SlaService;
  readonly snoozeTimers: SnoozeTimerQueue;
  readonly now?: () => Date;
  /** Tickets one rebuild transaction reads; a test makes it small. */
  readonly batchSize?: number;
}

/** A timer may run up to this much before its moment and still fire. */
const EARLY_TOLERANCE_MS = 1_000;

/** How many snoozed tickets one rebuild step reads. */
const REBUILD_BATCH = 200;

export type UnsnoozeOutcome =
  | { readonly kind: 'woke' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'early'; readonly fireAt: Date };

/**
 * `ticket.unsnooze`: wakes the ticket if this job is still the one that
 * matters. Runs inside the brand's system transaction.
 */
export const unsnoozeTicket = async (
  tx: DbTransaction,
  deps: Pick<SnoozeWorkerDeps, 'repository' | 'sla'>,
  payload: TicketUnsnoozePayload,
  now: Date,
): Promise<UnsnoozeOutcome> => {
  await deps.repository.lockTicket(tx, payload.ticketId);
  const found = await deps.repository.findTicket(tx, payload.ticketId);
  const ticket = found?.ticket;
  if (
    found === undefined ||
    ticket === undefined ||
    ticket.brandId !== payload.brandId ||
    ticket.deletedAt !== null ||
    ticket.mergedIntoId !== null ||
    ticket.snoozedUntil === null ||
    !isSnoozedStatus(found.status) ||
    ticket.snoozeVersion !== payload.version
  ) {
    return { kind: 'noop' };
  }
  if (ticket.snoozedUntil.getTime() - now.getTime() > EARLY_TOLERANCE_MS) {
    return { kind: 'early', fireAt: ticket.snoozedUntil };
  }

  const woke = await wakeTicket(tx, { ticket, cause: 'time', now });
  if (woke === undefined) {
    return { kind: 'noop' };
  }
  // The clocks follow the status (§3.2): the resolution clock resumes.
  await deps.sla.sync(tx, { brandId: payload.brandId, ticketId: ticket.id, at: now });

  return { kind: 'woke' };
};

/** `ticket.snoozed` outbox event: plan the wake timer for the version that was written. */
export const createTicketSnoozedHandler =
  (deps: Pick<SnoozeWorkerDeps, 'snoozeTimers' | 'now'>): OutboxEventHandler =>
  async ({ brandId, payload }) => {
    const parsed = ticketSnoozedPayloadSchema.parse(payload);
    const now = deps.now?.() ?? new Date();
    // A re-snooze supersedes the version before it; its job would only no-op.
    if (parsed.version > 1) {
      await deps.snoozeTimers.remove(
        ticketUnsnoozeJobId({ ticketId: parsed.ticketId, version: parsed.version - 1 }),
      );
    }
    await deps.snoozeTimers.upsert(
      {
        jobId: ticketUnsnoozeJobId(parsed),
        fireAt: new Date(parsed.snoozedUntil),
        payload: { brandId, ticketId: parsed.ticketId, version: parsed.version },
      },
      now,
    );
  };

/** Registers `ticket.snoozed`. Before the `outbox.event` consumer exists, as `registerSlaEventHandlers`. */
export const registerSnoozeEventHandlers = (
  deps: Pick<SnoozeWorkerDeps, 'snoozeTimers' | 'now'>,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  dispatcher.register(SNOOZE_EVENTS.snoozed, createTicketSnoozedHandler(deps));
};

export interface RebuildResult {
  readonly woke: number;
  readonly scheduled: number;
  /** The last ticket id read when more may follow; pass it back for the next batch. */
  readonly next: string | undefined;
}

/**
 * `snooze.rebuild` for one batch of a brand: wakes every snooze in it that is
 * already due and re-adds the timer of every other. The caller runs one batch per
 * transaction, so a brand with thousands of overdue snoozes (a long outage) never
 * holds thousands of ticket locks at once. Idempotent, so it may run any time, and
 * it is what makes losing Redis lose no snooze (DOMAIN-RULES §10).
 */
export const rebuildSnoozes = async (
  tx: DbTransaction,
  deps: SnoozeWorkerDeps,
  brandId: string,
  after?: string,
): Promise<RebuildResult> => {
  const now = deps.now?.() ?? new Date();
  const limit = deps.batchSize ?? REBUILD_BATCH;
  let woke = 0;
  let scheduled = 0;

  const rows = await tx
    .select({
      id: tickets.id,
      version: tickets.snoozeVersion,
      until: tickets.snoozedUntil,
      status: ticketStatuses.systemKey,
    })
    .from(tickets)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
    .where(
      and(
        eq(tickets.brandId, brandId),
        isNotNull(tickets.snoozedUntil),
        isNull(tickets.deletedAt),
        after === undefined ? undefined : gt(tickets.id, after),
      ),
    )
    .orderBy(asc(tickets.id))
    .limit(limit);

  for (const row of rows) {
    if (row.until === null || row.status !== 'snoozed') {
      continue;
    }
    const payload = { brandId, ticketId: row.id, version: row.version };
    if (row.until.getTime() <= now.getTime()) {
      woke += (await unsnoozeTicket(tx, deps, payload, now)).kind === 'woke' ? 1 : 0;
    } else {
      await deps.snoozeTimers.upsert(
        { jobId: ticketUnsnoozeJobId(payload), fireAt: row.until, payload },
        now,
      );
      scheduled += 1;
    }
  }

  return { woke, scheduled, next: rows.length < limit ? undefined : rows.at(-1)?.id };
};

/**
 * The BullMQ adapter. A delayed job with the id already is moved with
 * `changeDelay`; one that is running is left alone, because its processor
 * checks the ticket; anything else under that id (waiting, failed) is replaced.
 */
export const bullSnoozeQueue = (queue: Queue): SnoozeTimerQueue => ({
  upsert: async (timer, now) => {
    const delay = Math.max(0, timer.fireAt.getTime() - now.getTime());
    const existing = await queue.getJob(timer.jobId);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (state === 'active') {
        return;
      }
      if (state === 'delayed') {
        await existing.changeDelay(delay);
        return;
      }
      await existing.remove();
    }

    await queue.add(ticketUnsnoozeJob.name, timer.payload, {
      ...ticketUnsnoozeJob.options,
      jobId: timer.jobId,
      delay,
    });
  },
  remove: async (jobId) => {
    const existing = await queue.getJob(jobId);
    if (existing !== undefined && (await existing.getState()) !== 'active') {
      await existing.remove();
    }
  },
});
