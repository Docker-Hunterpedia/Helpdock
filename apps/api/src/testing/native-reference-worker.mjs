import './api-source-loader.mjs';

const { nativeReferenceWorkerConfigSchema, nativeReferenceWorkerCloseSchema } = await import(
  './native-reference-config.js'
);
const config = nativeReferenceWorkerConfigSchema.parse(
  await new Promise((resolve) => process.once('message', resolve)),
);
const { createDb } = await import('@helpdock/db');
const { createKeyring } = await import('@helpdock/config');
const { ImportRateLimiter } = await import('@helpdock/importers');
const { helpCenterMediaProcessJob } = await import('@helpdock/jobs');
const { Redis } = await import('ioredis');
const { Queue, Worker } = await import('bullmq');
const { ZodError } = await import('zod');
const { FakeStorage } = await import('./media.js');
const { createImportConnectorRuntime } = await import('../imports/jobs/connector-runtime.js');
const { createImportProcessor } = await import('../imports/jobs/import-processor.js');
const { createImportArticlePreparer } = await import('../imports/jobs/prepare-article.js');
const { localVendorLookup } = await import('./vendor-lookup.js');

if (new URL(config.databaseUrl).username !== 'helpdock_app')
  throw new Error('Reference worker requires the RLS runtime role');
const db = createDb({ url: config.databaseUrl, max: 2 });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const media = new Queue(config.mediaQueueName, { connection: redis });
const storage = new FakeStorage(config.directory);
const resolve = createImportConnectorRuntime(
  {
    db: db.db,
    keyring: createKeyring({ APP_MASTER_KEY: config.masterKey }),
    allowCidrs: [],
    storage,
  },
  {
    apiRoot: config.apiRoot,
    accountsRoot: config.apiRoot,
    limiter: new ImportRateLimiter({ capacity: 100000, perMinute: 10000000 }),
    policy: {
      allowedPorts: [Number(new URL(config.apiRoot).port)],
      allowCidrs: ['127.0.0.1/32'],
      lookup: localVendorLookup,
    },
  },
);
const prepareArticle = createImportArticlePreparer({
  db: db.db,
  storage,
  resolve,
  mediaJobState: async ({ brandId, mediaId }) => {
    const job = await media.getJob(`${helpCenterMediaProcessJob.name}.${mediaId}`);
    if (!job) return undefined;
    const payload = helpCenterMediaProcessJob.schema.parse(job.data);
    if (payload.brandId !== brandId || payload.mediaId !== mediaId)
      throw new Error('import.article.media-job-scope');
    return job.getState();
  },
});
const worker = new Worker(
  config.queueName,
  createImportProcessor({
    db: db.db,
    storage,
    resolve,
    prepareArticle: async (request) => {
      try {
        return await prepareArticle(request);
      } catch (error) {
        if (error instanceof ZodError)
          process.send?.({
            type: 'failed',
            job: 'article.prepare',
            error: JSON.stringify(error.issues.map(({ code, path }) => ({ code, path }))).slice(
              0,
              2000,
            ),
          });
        throw error;
      }
    },
  }),
  {
    connection: redis,
    concurrency: 1,
    lockDuration: 1500,
    stalledInterval: 500,
    maxStalledCount: 3,
  },
);

worker.on('failed', (job, error) =>
  process.send?.({ type: 'failed', job: job?.name ?? 'unknown', error: error.name }),
);
worker.on('error', (error) => process.send?.({ type: 'failed', job: 'worker', error: error.name }));
await worker.waitUntilReady();
process.send?.({ type: 'ready' });
process.on('message', async (request) => {
  if (!nativeReferenceWorkerCloseSchema.safeParse(request).success) return;
  await worker.close();
  await media.close();
  await redis.quit();
  await db.close();
  process.disconnect();
});
