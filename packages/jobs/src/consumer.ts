import { type Db, type DbTransaction, jobReceipts, withSystem } from '@helpdock/db';
import { type ConnectionOptions, type Job, UnrecoverableError, Worker } from 'bullmq';
import {
  type BrandScopedPayload,
  idempotencyKeyFor,
  type JobDefinition,
  parseJobPayload,
} from './jobs.js';
import { type JobLogger, silentLogger } from './logger.js';
import { PayloadValidationError } from './validation.js';

/**
 * Consumers are at-least-once and idempotent (DOMAIN-RULES §6). Every delivery
 * claims a `job_receipts` key in the same transaction as its effect, so the two
 * commit together: a handler that fails rolls the receipt back and the next
 * attempt runs again, and a handler that succeeds leaves a receipt that stops
 * every redelivery.
 */

/**
 * Inserts the key and reports whether this caller won it. `ON CONFLICT DO
 * NOTHING` returns no row when another delivery already holds it, which is the
 * whole test — no read, no race between the read and the write.
 */
export const claimReceipt = async (tx: DbTransaction, key: string): Promise<boolean> => {
  const rows = await tx
    .insert(jobReceipts)
    .values({ key })
    .onConflictDoNothing()
    .returning({ key: jobReceipts.key });

  return rows.length === 1;
};

export interface JobContext<TPayload> {
  readonly payload: TPayload;
  readonly brandId: string;
  /** The brand's transaction. Everything the handler writes commits with the receipt. */
  readonly tx: DbTransaction;
  readonly job: Job;
  readonly log: JobLogger;
}

/** Throwing is how a handler asks for a retry; returning marks the job done. */
export type JobHandler<TPayload> = (context: JobContext<TPayload>) => Promise<void>;

export interface CreateWorkerOptions {
  /** Connection the worker uses. An ioredis instance must have `maxRetriesPerRequest: null`. */
  readonly redis: ConnectionOptions;
  readonly db: Db;
  readonly log?: JobLogger | undefined;
  readonly concurrency?: number | undefined;
}

const rethrowAsUnrecoverable = (error: unknown): never => {
  if (error instanceof PayloadValidationError) {
    // The issues travel in the message, so `job.failedReason` says exactly which
    // field was wrong when the job is inspected in the DLQ view.
    throw new UnrecoverableError(error.message);
  }
  throw error;
};

/**
 * The processing function, without BullMQ around it: validate, open the brand's
 * transaction, claim the receipt, run the handler. Separated from
 * {@link createWorker} so that everything it refuses can be proved without Redis.
 *
 * One processor serves one job name. BullMQ routes by queue rather than by name,
 * so a queue that carries several consumed job names needs a processor that
 * dispatches on `job.name`; a job of the wrong name here fails unrecoverably
 * rather than being handled by the wrong code.
 */
export const createJobProcessor =
  <TName extends string, TPayload extends BrandScopedPayload>(
    definition: JobDefinition<TName, TPayload>,
    handler: JobHandler<TPayload>,
    { db, log = silentLogger }: { readonly db: Db; readonly log?: JobLogger | undefined },
  ) =>
  async (job: Job): Promise<void> => {
    if (job.name !== definition.name) {
      throw new UnrecoverableError(
        `Queue ${definition.queue} received job ${job.name}, but this worker only handles ${definition.name}.`,
      );
    }

    const jobId = job.id;
    if (jobId === undefined) {
      throw new UnrecoverableError(
        `Job ${definition.name} arrived without an id, so no delivery of it can be deduplicated.`,
      );
    }

    const payload = ((): TPayload => {
      try {
        return parseJobPayload(definition, job.data);
      } catch (error) {
        return rethrowAsUnrecoverable(error);
      }
    })();

    const key = idempotencyKeyFor(definition, payload, jobId);

    await withSystem(db, payload.brandId, async (tx) => {
      if (!(await claimReceipt(tx, key))) {
        log.info(
          { job: definition.name, jobId, key, brandId: payload.brandId },
          'duplicate delivery ignored; its receipt is already claimed',
        );
        return;
      }

      await handler({ payload, brandId: payload.brandId, tx, job, log });
    });
  };

/**
 * A BullMQ worker for one job definition: it validates the payload, opens the
 * brand's transaction and claims the receipt before the handler runs.
 */
export const createWorker = <TName extends string, TPayload extends BrandScopedPayload>(
  definition: JobDefinition<TName, TPayload>,
  handler: JobHandler<TPayload>,
  { redis, db, log = silentLogger, concurrency }: CreateWorkerOptions,
): Worker => {
  const worker = new Worker(
    definition.queue,
    createJobProcessor(definition, handler, { db, log }),
    {
      connection: redis,
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  );

  worker.on('failed', (job, error) => {
    log.error(
      {
        job: definition.name,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        attempts: definition.options.attempts,
        err: error,
      },
      'job failed',
    );
  });

  return worker;
};
