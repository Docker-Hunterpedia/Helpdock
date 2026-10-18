import './api-source-loader.mjs';
import 'reflect-metadata';
import { createServer } from 'node:http';
import { createServer as createSmtpServer } from 'node:net';
import { loadEnv } from '@helpdock/config';
import { departments, outbox, tags, uuidv7, withSystem } from '@helpdock/db';
import { ImportRateLimiter } from '@helpdock/importers';
import {
  FakeZendesk,
  importBrowserCloseSchema,
  importBrowserInstallSchema,
  importBrowserReadySchema,
  importBrowserSnapshotSchema,
  zendeskCoreFixture,
} from '@helpdock/importers/testing';
import { eq, sql } from 'drizzle-orm';

if (process.env.NODE_ENV !== 'test') throw new Error('Import browser harness requires test mode');
const config = importBrowserInstallSchema.parse(
  await new Promise((resolve) => process.once('message', resolve)),
);
const { createApiApp, createRuntime } = await import('../../dist/bootstrap.js');
const { seedDevInstall } = await import('../../dist/seed/dev-seed.js');
const { createZendeskImportConnection } = await import(
  '../../dist/imports/jobs/connector-runtime.js'
);
const { nativeReferenceQueues } = await import('./native-reference-queues.js');
const { localVendorLookup } = await import('./vendor-lookup.js');

const sends = { smtp: 0, webhook: 0, telegram: 0, graph: 0 };
const smtp = createSmtpServer((socket) => {
  sends.smtp++;
  socket.end('421 Import tests must not send mail\r\n');
});
const traps = createServer((request, response) => {
  const name = request.url?.startsWith('/telegram')
    ? 'telegram'
    : request.url?.startsWith('/graph')
      ? 'graph'
      : 'webhook';
  sends[name]++;
  request.resume();
  response.writeHead(503).end();
});
const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address');
  return address.port;
};
const stopServer = (server) =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
let runtime, app, queues, control, vendor, pumping;
let closing = false;
const stopped = new Promise((resolve) => {
  process.on('message', (message) => {
    if (importBrowserCloseSchema.safeParse(message).success) resolve();
  });
  process.once('disconnect', resolve);
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});
try {
  const smtpPort = await listen(smtp),
    trapPort = await listen(traps);
  Object.assign(process.env, {
    HD_SMTP_HOST: '127.0.0.1',
    HD_SMTP_PORT: String(smtpPort),
    HD_SMTP_TLS: 'none',
    HD_SMTP_FROM: 'fixture@example.invalid',
  });
  const masterKey = Buffer.alloc(32, 29).toString('base64');
  const env = loadEnv({
    APP_URL: config.webOrigin,
    APP_ROLE: 'api',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_MASTER_KEY: masterKey,
    PORT: String(config.apiPort),
    DATABASE_URL: config.databaseUrl,
    DATABASE_MIGRATION_URL: config.migrationUrl,
    REDIS_URL: config.redisUrl,
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'test',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'synthetic',
    S3_SECRET_ACCESS_KEY: 'synthetic',
    OUTBOUND_ALLOW_CIDRS: '127.0.0.0/8',
    TELEGRAM_API_ROOT: `http://127.0.0.1:${trapPort}/telegram`,
    META_GRAPH_API_ROOT: `http://127.0.0.1:${trapPort}/graph`,
    META_INSTAGRAM_API_ROOT: `http://127.0.0.1:${trapPort}/graph`,
  });
  runtime = await createRuntime({ env });
  const seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
  const seededTargets = await withSystem(runtime.db, seeded.brandId, async (tx) => {
    const [department] = await tx
      .select()
      .from(departments)
      .where(eq(departments.brandId, seeded.brandId));
    if (!department) throw new Error('Missing browser fixture department');
    const tagId = uuidv7();
    await tx.insert(tags).values({ id: tagId, brandId: seeded.brandId, name: 'migration' });
    await tx.delete(outbox).where(eq(outbox.brandId, seeded.brandId));
    return { departmentId: department.id, tagId };
  });
  const fixture = structuredClone(zendeskCoreFixture);
  fixture.ticket_fields = [];
  fixture.user_fields = [];
  fixture.organization_fields = [];
  fixture.categories = [];
  fixture.sections = [];
  fixture.articles = [];
  fixture.translations = {};
  fixture.satisfaction_ratings = [];
  fixture.survey_responses = [];
  for (const ticket of fixture.tickets) {
    delete ticket.custom_status_id;
    ticket.custom_fields = [];
  }
  for (const company of fixture.organizations) company.organization_fields = {};
  vendor = new FakeZendesk(fixture, {
    authorization: 'Bearer synthetic-browser-token',
    now: Math.floor(Date.now() / 1000),
  });
  await vendor.server.start();
  const bytes = Buffer.from('%PDF-1.7\nOriginal browser import receipt\n%%EOF\n');
  const attachmentUrl = vendor.addAttachment('browser-receipt', bytes);
  fixture.comments['101'][0].attachments = [
    {
      id: 1101,
      file_name: 'receipt.pdf',
      content_type: 'application/pdf',
      size: bytes.length,
      content_url: attachmentUrl,
    },
  ];
  vendor.replaceFixture(fixture);
  const transport = {
    apiRoot: vendor.server.root,
    policy: {
      allowedPorts: [Number(new URL(vendor.server.root).port)],
      allowCidrs: ['127.0.0.1/32'],
      lookup: localVendorLookup,
    },
  };
  queues = await nativeReferenceQueues(
    {
      databaseUrl: config.databaseUrl,
      redisUrl: config.redisUrl,
      queueName: `browser-import-${uuidv7()}`,
      mediaQueueName: `browser-import-media-${uuidv7()}`,
      directory: config.directory,
      masterKey,
      apiRoot: vendor.server.root,
    },
    runtime.db,
    seeded.brandId,
  );
  app = await createApiApp({
    runtime,
    objectStorage: queues.storage,
    imports: {
      storage: queues.storage,
      connection: (request, source) => {
        if (source !== 'zendesk') throw new Error('Browser fixture only supplies Zendesk');
        return createZendeskImportConnection({
          ...request,
          transport,
          allowCidrs: [],
          limiter: new ImportRateLimiter({ capacity: 1000, perMinute: 100000 }),
          log: async () => {},
        });
      },
    },
  });
  await app.listen({ port: config.apiPort, host: '127.0.0.1' });
  await queues.start();
  pumping = queues
    .pumpUntil(async () => closing, 'browser import fixture')
    .catch((error) => {
      if (process.connected)
        process.send?.({
          type: 'failed',
          error: error instanceof Error ? error.name : 'UnknownFailure',
        });
    });
  control = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Bearer ${config.controlKey}` ||
      request.url !== '/snapshot' ||
      request.method !== 'GET'
    ) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    try {
      const snapshot = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const inert = {};
        for (const table of [
          'workflow_runs',
          'ticket_sla_clocks',
          'notifications',
          'ai_calls',
          'webhook_deliveries',
        ]) {
          const [row] = await tx.execute(
            sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)} WHERE brand_id = ${seeded.brandId}`,
          );
          inert[table] = row.count;
        }
        const [history] = await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM tickets WHERE brand_id = ${seeded.brandId}) AS tickets,
          (SELECT count(*)::int FROM ticket_messages WHERE brand_id = ${seeded.brandId}) AS messages,
          (SELECT count(*)::int FROM attachments WHERE brand_id = ${seeded.brandId} AND status = 'ready') AS files,
          (SELECT count(*)::int FROM import_runs WHERE brand_id = ${seeded.brandId} AND status = 'completed' AND credentials_encrypted IS NOT NULL) AS retained_credentials`);
        const [unexpected] = await tx.execute(sql`SELECT count(*)::int AS count FROM outbox
          WHERE brand_id = ${seeded.brandId} AND created_at >= (SELECT min(created_at) FROM import_runs WHERE brand_id = ${seeded.brandId})
          AND event NOT IN ('import.work_requested', 'import.file_uploaded', 'attachment.uploaded', 'media.objects.purge', 'help_center.media_uploaded', 'help_center.imported')`);
        const files = await tx.execute(
          sql`SELECT s3_key FROM attachments WHERE brand_id = ${seeded.brandId} AND status = 'ready'`,
        );
        let managedBytesMatch = true;
        for (const file of files)
          if (!(await queues.storage.read(file.s3_key)).equals(bytes)) managedBytesMatch = false;
        return { ...history, inert, managedBytesMatch, unexpectedOutbox: unexpected.count };
      });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          importBrowserSnapshotSchema.parse({
            ...snapshot,
            sends,
            sourceReadOnly: vendor.server.calls.every((call) => call.method === 'GET'),
          }),
        ),
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  const controlPort = await listen(control);
  if (process.connected)
    process.send(
      importBrowserReadySchema.parse({
        type: 'ready',
        ...seededTargets,
        brandId: seeded.brandId,
        userId: seeded.userId,
        email: seeded.email,
        password: seeded.password,
        totpSecret: seeded.totpSecret,
        controlOrigin: `http://127.0.0.1:${controlPort}`,
      }),
    );
  await stopped;
} catch (error) {
  if (process.connected)
    process.send({ type: 'failed', error: error instanceof Error ? error.name : 'UnknownFailure' });
  process.exitCode = 1;
} finally {
  closing = true;
  await pumping;
  try {
    await queues?.close();
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await runtime?.close();
      } finally {
        const closed = await Promise.allSettled([
          vendor?.server.close(),
          control ? stopServer(control) : undefined,
          stopServer(traps),
          stopServer(smtp),
        ]);
        if (closed.some((result) => result.status === 'rejected')) process.exitCode = 1;
        if (process.connected) process.disconnect();
      }
    }
  }
}
