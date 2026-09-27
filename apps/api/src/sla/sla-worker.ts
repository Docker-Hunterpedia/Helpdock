import { brands, type Db, type DbTransaction } from '@helpdock/db';
import {
  type JobLogger,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
  parseJobPayload,
  slaRebuildJob,
  slaTimerJob,
} from '@helpdock/jobs';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { ne } from 'drizzle-orm';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import { withSystemJob } from '../tenant/system-job.js';
import { fireSlaTimer } from './escalation.js';
import type { SlaRepository } from './sla.repository.js';
import type { SlaService } from './sla.service.js';
import { SLA_SCHEDULE_EVENT, slaSchedulePayloadSchema } from './sla-events.js';
import { applyTimers, planTimers, type SlaTimerQueue } from './sla-timers.js';

/**
 * The worker's half of M3-02.
 *
 * ```
 * request  →  clocks + outbox(sla.schedule)          one transaction
 * worker   →  sla.schedule handler → sla.timer jobs  removed and re-added (§3.4)
 * timer    →  fireSlaTimer → clock + outbox(sla.*)   one transaction
 * boot     →  sla.rebuild → every brand → every running clock's timers
 * ```
 */

export interface SlaWorkerDeps {
  readonly repository: SlaRepository;
  readonly sla: SlaService;
  readonly assignment: AssignmentRepository;
  readonly timers: SlaTimerQueue;
  readonly now?: () => Date;
}

/**
 * Brings the timers of these tickets in line with their clocks. Shared by the
 * `sla.schedule` handler and `sla.rebuild`, which is the same act for every
 * ticket that has a running clock.
 */
export const scheduleTickets = async (
  tx: DbTransaction,
  deps: SlaWorkerDeps,
  brandId: string,
  ticketIds: readonly string[],
): Promise<number> => {
  const now = deps.now?.() ?? new Date();
  const brand = await deps.sla.brandContext(tx, brandId);
  const clocks = await deps.repository.currentClocksOf(tx, ticketIds);
  let scheduled = 0;

  for (const ticketId of ticketIds) {
    const found = await deps.repository.findTicket(tx, ticketId);
    if (found === undefined) {
      continue;
    }
    const current = clocks.get(ticketId) ?? [];
    const policyId = current.find((clock) => clock.policyId !== null)?.policyId;
    const policy = brand.policies.find((candidate) => candidate.id === policyId);
    const plan = planTimers({
      brandId,
      ticketId,
      departmentId: found.ticket.departmentId,
      clocks: current,
      stepPercents: policy?.escalation.map((step) => step.atPercent) ?? [],
      calendarFor: brand.calendarFor,
    });
    await applyTimers(deps.timers, plan, now);
    scheduled += plan.wanted.length;
  }

  return scheduled;
};

/** `sla.schedule`: written whenever a ticket's clocks changed. */
export const createSlaScheduleHandler =
  (deps: SlaWorkerDeps): OutboxEventHandler =>
  async ({ brandId, payload, tx }) => {
    const { ticketIds } = slaSchedulePayloadSchema.parse(payload);
    await scheduleTickets(tx, deps, brandId, ticketIds);
  };

/**
 * Registers `sla.schedule`. The events the engine writes — `sla.warning`,
 * `sla.breached` and `ticket.escalated` — are consumed by M3-07's
 * notifications and M3-03's rules, which register their own subscribers.
 */
export const registerSlaEventHandlers = (
  deps: SlaWorkerDeps,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  dispatcher.register(SLA_SCHEDULE_EVENT, createSlaScheduleHandler(deps));
};

export interface SlaProcessorOptions {
  readonly db: Db;
  readonly deps: SlaWorkerDeps;
  readonly log: JobLogger;
  /** Adds one `sla.rebuild` per brand when the boot tick fans out. */
  readonly addRebuild: (brandId: string, jobId: string) => Promise<void>;
}

/**
 * The `sla` queue carries two job names, and BullMQ routes by queue, so the
 * processor dispatches on `job.name` (as `packages/jobs/src/consumer.ts`
 * describes).
 */
export const createSlaProcessor =
  ({ db, deps, log, addRebuild }: SlaProcessorOptions) =>
  async (job: Job, token?: string): Promise<void> => {
    const jobId = job.id ?? job.name;

    if (job.name === slaTimerJob.name) {
      const payload = parse(() => parseJobPayload(slaTimerJob, job.data));
      const now = deps.now?.() ?? new Date();
      const outcome = await withSystemJob(db, payload.brandId, jobId, (tx) =>
        fireSlaTimer(tx, deps, payload, now),
      );
      if (outcome.kind === 'early') {
        // Paused or retargeted since it was added: move it rather than act.
        await job.moveToDelayed(outcome.fireAt.getTime(), token);
        throw new DelayedError();
      }
      return;
    }

    if (job.name === slaRebuildJob.name) {
      const payload = parse(() => parseJobPayload(slaRebuildJob, job.data));
      if (payload.brandId === undefined) {
        // `brands` is global and carries no policy; each brand's own work runs
        // in its own system transaction below (DOMAIN-RULES §1.4).
        const live = await db
          .select({ id: brands.id })
          .from(brands)
          .where(ne(brands.status, 'deleted'));
        for (const { id } of live) {
          await addRebuild(id, `${slaRebuildJob.name}.${id}.${jobId.replaceAll(':', '.')}`);
        }
        return;
      }

      const brandId = payload.brandId;
      const scheduled = await withSystemJob(db, brandId, jobId, async (tx) =>
        scheduleTickets(tx, deps, brandId, await deps.repository.runningTicketIds(tx)),
      );
      log.info({ job: job.name, brandId, scheduled }, 'SLA timers rebuilt');
      return;
    }

    throw new UnrecoverableError(`The sla queue has no consumer for job ${job.name}.`);
  };

const parse = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    // A payload that is wrong now is wrong on every retry.
    throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }
};
