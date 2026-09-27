import { brands, type Db } from '@helpdock/db';
import {
  type DomainVerifyPayload,
  domainVerifyJob,
  domainVerifyJobId,
  domainVerifyScheduleJob,
  type JobLogger,
  type OutboxEventHandler,
  PayloadValidationError,
  parseJobPayload,
  registerEventHandler,
} from '@helpdock/jobs';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainVerifier } from './domain-verifier.js';
import { DOMAIN_CHECK_REQUESTED_EVENT } from './domains.service.js';

/**
 * The `domains` queue (M5-07), as the worker runs it:
 *
 * ```
 * domain.check_requested (outbox)  → domain.verify {brandId, domainId}   one domain, now
 * domain.verify.schedule (15 min)  → domain.verify {brandId}             per brand: the domains that are due
 * ```
 *
 * A person's request reaches the queue only through the outbox, whose handler
 * adds the job with an id derived from the outbox row, so a redelivered event
 * adds nothing (DOMAIN-RULES §6). The tick adds one job per brand rather than
 * widening a tenant context (§1.4), with an id per brand per tick.
 */

/** What the handler and the tick need of BullMQ. The worker passes a queue; a test passes a recorder. */
export interface DomainsQueue {
  add(payload: DomainVerifyPayload, jobId: string): Promise<void>;
}

const checkRequestedSchema = z.object({ domainId: z.uuid() });

export const createCheckRequestedHandler =
  (queue: DomainsQueue): OutboxEventHandler =>
  async ({ brandId, outboxId, payload }) => {
    const { domainId } = checkRequestedSchema.parse(payload);
    const job = { brandId, domainId };
    await queue.add(job, domainVerifyJobId(job, { outboxId }));
  };

export const registerDomainEventHandlers = (queue: DomainsQueue): void => {
  registerEventHandler(DOMAIN_CHECK_REQUESTED_EVENT, createCheckRequestedHandler(queue));
};

/**
 * The tick. `brands` is a global table, so reading its ids needs no tenant
 * context and exposes no tenant data; each brand's domains are read inside that
 * brand's own job.
 */
export const scheduleDomainChecks = async (
  db: Db,
  queue: DomainsQueue,
  tick: Date,
): Promise<number> => {
  const live = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  for (const { id: brandId } of live) {
    const payload = { brandId };
    await queue.add(payload, domainVerifyJobId(payload, { tick }));
  }
  return live.length;
};

export interface DomainsProcessorOptions {
  readonly db: Db;
  readonly verifier: DomainVerifier;
  readonly queue: DomainsQueue;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

/** Minute precision, so two firings of one tick share their job ids. */
const minuteOf = (date: Date): Date => new Date(Math.floor(date.getTime() / 60_000) * 60_000);

const parseVerifyPayload = (data: unknown): DomainVerifyPayload => {
  try {
    return parseJobPayload(domainVerifyJob, data);
  } catch (error) {
    // A payload that is wrong now is wrong on every retry.
    if (error instanceof PayloadValidationError) {
      throw new UnrecoverableError(error.message);
    }
    /* c8 ignore next -- parseJobPayload throws nothing else. */
    throw error;
  }
};

/**
 * The `domains` queue's processor. BullMQ routes by queue, not by name, so one
 * processor serves both jobs and refuses any other name rather than running it
 * with the wrong code.
 */
export const createDomainsProcessor =
  ({ db, verifier, queue, log, now = () => new Date() }: DomainsProcessorOptions) =>
  async (job: Pick<Job, 'name' | 'data' | 'id'>): Promise<void> => {
    switch (job.name) {
      case domainVerifyScheduleJob.name: {
        const brandsScheduled = await scheduleDomainChecks(db, queue, minuteOf(now()));
        log.info({ job: job.name, brands: brandsScheduled }, 'domain checks scheduled');
        return;
      }
      case domainVerifyJob.name: {
        const payload = parseVerifyPayload(job.data);
        const jobId = job.id ?? domainVerifyJob.name;
        if (payload.domainId === undefined) {
          await verifier.checkDue(payload.brandId, jobId);
        } else {
          await verifier.checkOne(payload.brandId, payload.domainId, jobId);
        }
        return;
      }
      default:
        throw new UnrecoverableError(
          `The domains queue received job ${job.name}, which no processor here handles.`,
        );
    }
  };
