import { setTimeout as waitForWork } from 'node:timers/promises';
import { type Db, outbox, withSystem } from '@helpdock/db';
import {
  createJobProcessor,
  createOutboxDispatcher,
  helpCenterMediaProcessJob,
  importFilePrepareJob,
  JOB_DEFINITIONS,
  mediaProcessJob,
  silentLogger,
} from '@helpdock/jobs';
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createMediaUploadedHandler } from '../help-center/events.js';
import { createHcMediaProcessor } from '../help-center/media-process.job.js';
import { registerImportFileEvents } from '../imports/file-events.js';
import { registerImportEventHandlers } from '../imports/import-events.js';
import { createAttachmentUploadedHandler } from '../media/attachment-events.js';
import { createObjectPurgeHandler } from '../media/object-purge.js';
import { createMediaProcessor } from '../media/process.job.js';
import { FakeStorage, fakeTools } from './media.js';
import type { NativeReferenceWorkerConfig } from './native-reference-config.js';
import { nativeReferenceProcess } from './native-reference-process.js';

export async function nativeReferenceQueues(
  config: NativeReferenceWorkerConfig,
  db: Db,
  brandId: string,
) {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(config.queueName, { connection: redis });
  const media = new Queue(config.mediaQueueName, { connection: redis });
  const storage = new FakeStorage(config.directory);
  const failures: string[] = [];
  const attachmentProcessor = createJobProcessor(
    mediaProcessJob,
    createMediaProcessor({ storage, tools: fakeTools(), scanner: undefined }),
    { db },
  );
  const articleProcessor = createJobProcessor(
    helpCenterMediaProcessJob,
    createHcMediaProcessor(storage),
    { db },
  );
  const mediaWorker = new Worker(
    config.mediaQueueName,
    async (job) => {
      if (job.name === mediaProcessJob.name) return attachmentProcessor(job);
      if (job.name === helpCenterMediaProcessJob.name) return articleProcessor(job);
      throw new Error('Unexpected reference media job');
    },
    { connection: redis, concurrency: 1 },
  );
  mediaWorker.on('failed', (_job, error) => failures.push(error.message));
  mediaWorker.on('error', (error) => failures.push(error.message));
  const dispatcher = createOutboxDispatcher();
  registerImportEventHandlers(
    {
      add: async (step, payload, jobId, delay) => {
        const definition = JOB_DEFINITIONS[`import.${step}`];
        await queue.add(definition.name, payload, { ...definition.options, jobId, delay });
      },
    },
    dispatcher,
  );
  registerImportFileEvents(
    {
      add: async (payload, jobId) => {
        await queue.add(importFilePrepareJob.name, payload, {
          ...importFilePrepareJob.options,
          jobId,
        });
      },
    },
    dispatcher,
  );
  dispatcher.register(
    'attachment.uploaded',
    createAttachmentUploadedHandler({
      add: async ({ payload, jobId }) => {
        await media.add(mediaProcessJob.name, payload, { ...mediaProcessJob.options, jobId });
      },
    }),
  );
  dispatcher.register('media.objects.purge', createObjectPurgeHandler(storage));
  dispatcher.register(
    'help_center.media_uploaded',
    createMediaUploadedHandler({
      addMediaProcess: async (payload) => {
        await media.add(helpCenterMediaProcessJob.name, payload, {
          ...helpCenterMediaProcessJob.options,
          jobId: `${helpCenterMediaProcessJob.name}.${payload.mediaId}`,
        });
      },
      addPublishDue: async () => {
        throw new Error('An import must not schedule a publication');
      },
    }),
  );
  let worker: Awaited<ReturnType<typeof nativeReferenceProcess>> | undefined;

  return {
    storage,
    async start() {
      if (worker) throw new Error('Reference worker is already running');
      worker = await nativeReferenceProcess(config);
    },
    async kill() {
      if (!worker) throw new Error('Missing reference worker');
      await worker.kill();
      failures.push(...worker.failures);
      worker = undefined;
    },
    async pumpUntil(done: () => Promise<boolean>, label: string) {
      const deadline = Date.now() + 1200000;
      while (Date.now() < deadline) {
        const failure = failures[0] ?? worker?.failures[0];
        if (failure) throw new Error(`Reference queue failed: ${failure}`);
        const events = await withSystem(db, brandId, (tx) =>
          tx
            .select()
            .from(outbox)
            .where(
              and(
                eq(outbox.brandId, brandId),
                isNull(outbox.publishedAt),
                inArray(outbox.event, [
                  'import.work_requested',
                  'import.file_uploaded',
                  'attachment.uploaded',
                  'media.objects.purge',
                  'help_center.media_uploaded',
                ]),
              ),
            )
            .orderBy(outbox.id)
            .limit(100),
        );
        for (const event of events)
          await withSystem(db, brandId, async (tx) => {
            await dispatcher.dispatch({
              tx,
              brandId,
              event: event.event,
              payload: event.payload,
              outboxId: event.id,
              log: silentLogger,
            });
            await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, event.id));
          });
        if (await done()) return;
        await waitForWork(50);
      }
      throw new Error(`Reference worker exceeded deadline: ${label}`);
    },
    async close() {
      // An assertion must not leak the child worker or its test containers.
      try {
        await worker?.close();
      } finally {
        await mediaWorker.close();
        await media.obliterate({ force: true });
        await media.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await redis.quit();
      }
    },
  };
}
