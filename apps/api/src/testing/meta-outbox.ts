import { type Db, outbox, withSystem } from '@helpdock/db';
import {
  createJobProcessor,
  type MetaMediaFetchPayload,
  mediaProcessJob,
  type OutboxEventHandler,
  silentLogger,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { asc, eq } from 'drizzle-orm';
import { createAttachmentUploadedHandler } from '../media/attachment-events.js';
import type { MediaTools } from '../media/ffmpeg.js';
import { createMediaProcessor } from '../media/process.job.js';
import type { ObjectStorage } from '../media/storage.js';
import { createMetaMediaEventHandler, META_EVENTS } from '../meta/meta-events.js';

/**
 * The worker, played by hand: the relay reads an outbox row, the event's handler
 * turns it into a job, and a consumer runs the job. The Meta suites do it one row
 * at a time so a test says exactly when each step happens, and so a change to how
 * the worker drains the outbox is made here once, not four times.
 */

/** What a handler adds to a queue. */
export interface QueuedJob<TPayload> {
  readonly jobId: string;
  readonly payload: TPayload;
}

export interface DrainedRow<TPayload> {
  readonly id: string;
  readonly brandId: string;
  readonly payload: Record<string, unknown>;
  /** What the event's handler queued for it. */
  readonly jobs: readonly QueuedJob<TPayload>[];
}

/** A queue the handler of an event adds to, which the suite reads back. */
export interface RecordingQueue<TPayload> {
  add(job: QueuedJob<TPayload>): Promise<void>;
}

export interface MediaPipelineOptions {
  readonly storage: ObjectStorage;
  /** The tools `media.process` runs: a suite may count what it calls. */
  readonly tools: () => MediaTools;
}

export const createOutboxDrain = ({
  db,
  owner,
  handled = new Set<string>(),
}: {
  /** The runtime's connection, which the handlers run in as the system principal. */
  readonly db: Db;
  /** The owner's, which reads every brand's outbox. */
  readonly owner: Db;
  /** The rows already handled, when a suite handles some itself. */
  readonly handled?: Set<string>;
}) => {
  /**
   * The rows of `event` nobody has handled yet, oldest first, each run through
   * the event's handler. `accept` leaves out the rows of other tests.
   */
  const drain = async <TPayload>(
    event: string,
    handlerFor: (queue: RecordingQueue<TPayload>) => OutboxEventHandler,
    accept: (payload: Record<string, unknown>) => boolean = () => true,
  ): Promise<DrainedRow<TPayload>[]> => {
    const rows = await owner
      .select()
      .from(outbox)
      .where(eq(outbox.event, event))
      .orderBy(asc(outbox.id));
    const drained: DrainedRow<TPayload>[] = [];
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      if (handled.has(row.id) || !accept(payload)) {
        continue;
      }
      handled.add(row.id);
      const jobs: QueuedJob<TPayload>[] = [];
      await withSystem(db, row.brandId, (tx) =>
        handlerFor({ add: async (job) => void jobs.push(job) })({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload,
          tx,
          log: silentLogger,
        }),
      );
      drained.push({ id: row.id, brandId: row.brandId, payload, jobs });
    }

    return drained;
  };

  /** The `meta.media_fetch` jobs asked for the attachments `ids`, as the worker would add them. */
  const fetchJobsFor = async (
    ids: ReadonlySet<string>,
  ): Promise<QueuedJob<MetaMediaFetchPayload>[]> =>
    (
      await drain<MetaMediaFetchPayload>(
        META_EVENTS.media,
        createMetaMediaEventHandler,
        (payload) => ids.has(String(payload.attachmentId)),
      )
    ).flatMap((row) => [...row.jobs]);

  /** `attachment.uploaded` rows of the attachments `ids`, each run through `media.process`. */
  const processUploads = async (
    ids: ReadonlySet<string>,
    { storage, tools }: MediaPipelineOptions,
  ): Promise<void> => {
    const process = createJobProcessor(
      mediaProcessJob,
      createMediaProcessor({ storage, tools: tools(), scanner: undefined }),
      { db, log: silentLogger },
    );
    const uploaded = await drain<{ brandId: string; attachmentId: string }>(
      'attachment.uploaded',
      createAttachmentUploadedHandler,
      (payload) => ids.has(String(payload.attachmentId)),
    );
    for (const job of uploaded.flatMap((row) => row.jobs)) {
      await process({
        name: 'media.process',
        id: job.jobId,
        data: job.payload,
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as unknown as Job);
    }
  };

  /**
   * Every file of the attachments `ids` fetched (by `runFetch`, which answers
   * what the job threw: BullMQ would retry it) and processed, as the worker does
   * after the relay. Answers what the fetches threw.
   */
  const mediaPipeline = async (
    ids: ReadonlySet<string>,
    runFetch: (job: QueuedJob<MetaMediaFetchPayload>) => Promise<unknown>,
    options: MediaPipelineOptions,
  ): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const job of await fetchJobsFor(ids)) {
      const error = await runFetch(job);
      if (error !== undefined) {
        errors.push(error);
      }
    }
    await processUploads(ids, options);

    return errors;
  };

  return { handled, drain, fetchJobsFor, processUploads, mediaPipeline };
};

export type OutboxDrain = ReturnType<typeof createOutboxDrain>;
