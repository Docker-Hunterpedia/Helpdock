import { type SlaTimerPayload, slaTimerJob, slaTimerJobId } from '@helpdock/jobs';
import { SLA_BREACH_PERCENT, type SlaClockKind } from '@helpdock/schemas';
import type { Queue } from 'bullmq';
import { type Clock, hasFired, isCounting, timeOfPercent } from './clock.js';
import type { CalendarFor } from './ticket-clocks.js';

/**
 * The BullMQ half of DOMAIN-RULES §3.4: "Timers are BullMQ delayed jobs keyed
 * `sla:<ticket_id>:<clock>:<step>`. Any status, priority, department, or
 * policy change removes and re-adds them."
 *
 * {@link planTimers} is pure: which timers a ticket's clocks want, and when.
 * {@link applyTimers} makes the queue agree, through the narrow
 * {@link SlaTimerQueue} so the rule can be proved without Redis.
 */

export interface SlaTimer {
  readonly jobId: string;
  readonly fireAt: Date;
  readonly payload: SlaTimerPayload;
}

export interface TimerPlan {
  /** Timers that should exist, at these times. */
  readonly wanted: readonly SlaTimer[];
  /** Job ids that must not exist: steps already fired, or clocks not counting. */
  readonly unwanted: readonly string[];
}

const KINDS: readonly SlaClockKind[] = ['first_response', 'next_response', 'resolution'];

/**
 * Every counting clock wants one timer per step it has not fired, plus the
 * breach at 100 % until it breaches. A paused, met or stopped clock wants
 * none; its step ids are all unwanted, so a pause removes them.
 */
export const planTimers = (input: {
  readonly brandId: string;
  readonly ticketId: string;
  readonly departmentId: string;
  readonly clocks: readonly Clock[];
  /** The `atPercent` of every step of the policy the clocks run under. */
  readonly stepPercents: readonly number[];
  readonly calendarFor: CalendarFor;
}): TimerPlan => {
  const percents = [...new Set([...input.stepPercents, SLA_BREACH_PERCENT])].sort((a, b) => a - b);
  const wanted: SlaTimer[] = [];

  for (const clock of input.clocks) {
    if (!isCounting(clock)) {
      continue;
    }
    const calendar = input.calendarFor(clock.timeMode, input.departmentId);
    for (const percent of percents) {
      const done =
        hasFired(clock, percent) || (percent === SLA_BREACH_PERCENT && clock.breachedAt !== null);
      const fireAt = done ? null : timeOfPercent(clock, calendar, percent);
      if (fireAt !== null) {
        const payload = {
          brandId: input.brandId,
          ticketId: input.ticketId,
          clock: clock.kind,
          stepPercent: percent,
        };
        wanted.push({ jobId: slaTimerJobId(payload), fireAt, payload });
      }
    }
  }

  const keep = new Set(wanted.map((timer) => timer.jobId));
  const unwanted = KINDS.flatMap((clock) =>
    percents.map((stepPercent) => slaTimerJobId({ ticketId: input.ticketId, clock, stepPercent })),
  ).filter((jobId) => !keep.has(jobId));

  return { wanted, unwanted };
};

/** What {@link applyTimers} needs of a queue. */
export interface SlaTimerQueue {
  /** Adds the timer, or moves an existing one to `fireAt`. */
  upsert(timer: SlaTimer, now: Date): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export const applyTimers = async (
  queue: SlaTimerQueue,
  plan: TimerPlan,
  now: Date,
): Promise<void> => {
  for (const jobId of plan.unwanted) {
    await queue.remove(jobId);
  }
  for (const timer of plan.wanted) {
    await queue.upsert(timer, now);
  }
};

/**
 * The BullMQ adapter. A delayed job with the id already is moved with
 * `changeDelay`; one that is running is left alone — its processor checks the
 * clock and moves itself if it is early; anything else under that id (waiting,
 * failed) is replaced.
 */
export const bullTimerQueue = (queue: Queue): SlaTimerQueue => ({
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

    await queue.add(slaTimerJob.name, timer.payload, {
      ...slaTimerJob.options,
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
