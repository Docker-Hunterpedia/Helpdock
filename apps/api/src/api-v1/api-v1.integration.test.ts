import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { createKeyring, type Env } from '@helpdock/config';
import { apiKeys, auditLog, createDb, departments, tickets, withSystem } from '@helpdock/db';
import {
  createJobProcessor,
  createOutboxDispatcher,
  createOutboxEventHandler,
  type OutboxEventPayload,
  outboxEventJob,
  runRelayCycle,
  silentLogger,
  type WebhookDeliverPayload,
  webhookDeliverJob,
} from '@helpdock/jobs';
import type {
  ApiKey,
  ApiKeyCreated,
  TicketList,
  V1ContactUpsert,
  V1TicketDetail,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryList,
  WebhookEnvelope,
  WebhookOverviewList,
  WebhookWithSecret,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { createWebhookDeliverProcessor } from '../webhooks/webhook-deliver.job.js';
import {
  registerWebhookEventHandlers,
  WEBHOOK_DELIVERY_REQUESTED_EVENT,
  WEBHOOK_SOURCE_EVENTS,
} from '../webhooks/webhook-events.js';
import { verifyWebhookSignature } from '../webhooks/webhook-signature.js';
import { WebhooksRepository } from '../webhooks/webhooks.repository.js';

/**
 * M8-01, M8-02 and M8-03 against a real Postgres and Redis, through the real
 * guards, and the M8 exit criterion: **a ticket created through the API with
 * an API key triggers a signed `ticket.created` webhook received by a test
 * endpoint**, whose signature verifies.
 *
 * The worker's half runs in this process: one relay cycle publishes the
 * outbox, the webhooks subscriber writes the deliveries, a second cycle feeds
 * `webhook.delivery_requested`, and the `webhook.deliver` processor POSTs
 * through `@helpdock/net` to an HTTP server on loopback — reachable only
 * because this suite allow-lists it, the seam `OUTBOUND_ALLOW_CIDRS` is in
 * production.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the public API integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe.skipIf(!hasDocker)('public API, API keys and webhooks', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let seeded: SeededInstall;
  let staffToken: string;
  let departmentId: string;
  let receiver: Server;
  let receiverUrl: string;
  let receiverPort: number;
  const received: Received[] = [];

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: 'apps/admin/dist',
      // Loopback, for the receiver below: the registration check refuses
      // plain http anywhere else, and a private address everywhere.
      OUTBOUND_ALLOW_CIDRS: ['127.0.0.1/32'],
    }) as Env;

  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      body: (response.body === '' ? undefined : response.json()) as T,
    };
  };

  const issueKey = async (scopes: string[], rateLimitPerMinute?: number) => {
    const created = await call<ApiKeyCreated>(
      'POST',
      `/api/brands/${seeded.brandId}/api-keys`,
      staffToken,
      {
        name: `key ${scopes.join(' ')}`,
        scopes,
        ...(rateLimitPerMinute ? { rateLimitPerMinute } : {}),
      },
    );
    expect(created.status).toBe(201);
    return created.body;
  };

  const newTicket = (subject: string) => ({
    subject,
    bodyHtml: '<p>My order never arrived.</p>',
    departmentId,
  });

  /**
   * What the worker does: relay what committed, run the webhooks subscriber on
   * every event it listens to, and hand back the `webhook.deliver` jobs that
   * `webhook.delivery_requested` added. Two passes, because the subscriber's
   * own outbox rows are published by the next cycle.
   */
  const runWorker = async (): Promise<Job[]> => {
    const deliverJobs: Job[] = [];
    const dispatcher = createOutboxDispatcher();
    registerWebhookEventHandlers(
      {
        repository: new WebhooksRepository(),
        queue: {
          add: async (payload: WebhookDeliverPayload, jobId: string) => {
            deliverJobs.push({
              name: webhookDeliverJob.name,
              id: jobId,
              data: payload,
              attemptsMade: 0,
              opts: { attempts: 8 },
            } as unknown as Job);
          },
        },
      },
      dispatcher,
    );
    const handled = new Set<string>([...WEBHOOK_SOURCE_EVENTS, WEBHOOK_DELIVERY_REQUESTED_EVENT]);
    const process = createJobProcessor(outboxEventJob, createOutboxEventHandler(dispatcher), {
      db: runtime.db,
    });

    for (let pass = 0; pass < 2; pass += 1) {
      const published: Job[] = [];
      await runRelayCycle({
        db: runtime.db,
        queue: {
          add: async (name, data, options) => {
            published.push({ name, data, id: options.jobId } as Job);
          },
        },
      });
      for (const job of published) {
        if (handled.has((job.data as OutboxEventPayload).event)) {
          await process(job);
        }
      }
    }
    return deliverJobs;
  };

  /** One attempt of a `webhook.deliver` job, by the worker's own processor. */
  const deliver = (job: Job): Promise<void> =>
    createWebhookDeliverProcessor({
      db: runtime.db,
      log: silentLogger,
      repository: new WebhooksRepository(),
      keyring: createKeyring(envFor()),
      // The test seam: loopback and the receiver's port are allowed here, and
      // nowhere else (DOMAIN-RULES §13).
      policy: { allowCidrs: ['127.0.0.1/32'], allowedPorts: [receiverPort] },
    })(job);

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    const owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    await app.getHttpAdapter().getInstance().ready();
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    staffToken = await signInForTest(app, { email: seeded.email, password: seeded.password });

    const [department] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select({ id: departments.id }).from(departments).limit(1),
    );
    departmentId = department?.id ?? '';

    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'text/plain' }).end('thanks');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as AddressInfo).port;
    receiverUrl = `http://127.0.0.1:${String(receiverPort)}/hooks/helpdock`;
  }, 300_000);

  afterAll(async () => {
    await new Promise((resolve) => receiver?.close(resolve));
    await app?.close();
    await runtime?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('API keys (M8-01)', () => {
    it('shows a key once, stores its hash, lists only the prefix, and audits the create', async () => {
      const created = await issueKey(['tickets:read']);

      expect(created.key).toMatch(/^hd_live_[A-Za-z0-9_-]{43}$/);
      const listed = await call<{ keys: ApiKey[] }>(
        'GET',
        `/api/brands/${seeded.brandId}/api-keys`,
        staffToken,
      );
      expect(JSON.stringify(listed.body)).not.toContain(created.key);
      expect(listed.body.keys.find((key) => key.id === created.id)?.prefix).toBe(
        created.key.slice(0, 12),
      );
      expect(listed.body.keys.find((key) => key.id === created.id)).toMatchObject({
        createdByName: expect.any(String),
        revokedByName: null,
      });

      const [stored] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, created.id)),
      );
      expect(stored?.keyHash).not.toContain(created.key);
      const audits = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, created.id)),
      );
      expect(audits.map((row) => row.action)).toEqual(['api_key.created']);
    });

    it('holds a key to its scopes: a tickets:read key cannot write, and no key reaches a staff route', async () => {
      const { key } = await issueKey(['tickets:read']);

      expect((await call('GET', '/api/v1/tickets', key)).status).toBe(200);
      expect((await call('POST', '/api/v1/tickets', key, newTicket('Nope'))).status).toBe(403);
      expect((await call('GET', '/api/v1/contacts', key)).status).toBe(403);
      expect((await call('GET', `/api/brands/${seeded.brandId}/tickets`, key)).status).toBe(403);
      // And a staff session does not reach the public API.
      expect((await call('GET', '/api/v1/tickets', staffToken)).status).toBe(403);
    });

    it('records when a key was last used', async () => {
      const created = await issueKey(['tickets:read']);
      await call('GET', '/api/v1/tickets', created.key);

      const [stored] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, created.id)),
      );
      expect(stored?.lastUsedAt).not.toBeNull();
    });

    it('answers 401 once a key is revoked, and audits the revocation', async () => {
      const created = await issueKey(['tickets:read']);
      const revoked = await call<ApiKey>(
        'DELETE',
        `/api/brands/${seeded.brandId}/api-keys/${created.id}`,
        staffToken,
      );

      expect(revoked.body.revokedAt).not.toBeNull();
      expect((await call('GET', '/api/v1/tickets', created.key)).status).toBe(401);
      expect((await call('GET', '/api/v1/tickets', 'hd_live_never-issued')).status).toBe(401);
    });

    it('throttles a key past its per-minute budget with 429', async () => {
      const { key } = await issueKey(['tickets:read'], 2);

      expect((await call('GET', '/api/v1/tickets', key)).status).toBe(200);
      expect((await call('GET', '/api/v1/tickets', key)).status).toBe(200);
      expect((await call('GET', '/api/v1/tickets', key)).status).toBe(429);
    });
  });

  describe('REST v1 (M8-02)', () => {
    it('files a ticket on the api channel, pages the list, and replies through the same rules', async () => {
      const { key } = await issueKey(['tickets:read', 'tickets:write']);

      const created = await call<V1TicketDetail>(
        'POST',
        '/api/v1/tickets',
        key,
        newTicket('Late order'),
      );
      expect(created.status).toBe(201);
      expect(created.body.ticket.channel).toBe('api');
      expect(created.body.messages).toHaveLength(1);

      const ticketId = created.body.ticket.id;
      const reply = await call('POST', `/api/v1/tickets/${ticketId}/messages`, key, {
        kind: 'note',
        bodyHtml: '<p>Checked the carrier.</p>',
      });
      expect(reply.status).toBe(201);

      const patched = await call<{ priority: string }>(
        'PATCH',
        `/api/v1/tickets/${ticketId}`,
        key,
        {
          priority: 'high',
        },
      );
      expect(patched.body.priority).toBe('high');

      await call('POST', '/api/v1/tickets', key, newTicket('Second order'));
      const page = await call<TicketList>('GET', '/api/v1/tickets?limit=1', key);
      expect(page.body.tickets).toHaveLength(1);
      const next = await call<TicketList>(
        'GET',
        `/api/v1/tickets?limit=1&cursor=${encodeURIComponent(page.body.nextCursor ?? '')}`,
        key,
      );
      expect(next.body.tickets).toHaveLength(1);
      expect(next.body.tickets[0]?.id).not.toBe(page.body.tickets[0]?.id);

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.id, ticketId)),
      );
      expect(row?.channel).toBe('api');
      expect(
        (await call('GET', '/api/v1/tickets/0192a000-0000-7000-8000-00000000dead', key)).status,
      ).toBe(404);
    });

    it('replays a POST sent again with the same Idempotency-Key, and refuses the key for another body', async () => {
      const { key } = await issueKey(['tickets:write']);
      const headers = { 'idempotency-key': 'order-1042' };

      const first = await call<V1TicketDetail>(
        'POST',
        '/api/v1/tickets',
        key,
        newTicket('Once'),
        headers,
      );
      const second = await call<V1TicketDetail>(
        'POST',
        '/api/v1/tickets',
        key,
        newTicket('Once'),
        headers,
      );
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.ticket.id).toBe(first.body.ticket.id);

      const filed = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.subject, 'Once')),
      );
      expect(filed).toHaveLength(1);

      const other = await call('POST', '/api/v1/tickets', key, newTicket('Twice'), headers);
      expect(other.status).toBe(422);
    });

    it('upserts a contact by the integration’s own id, and finds it by search', async () => {
      const { key } = await issueKey(['contacts:read', 'contacts:write']);
      const body = {
        name: 'Ada Lovelace',
        externalId: 'crm-42',
        identities: [{ kind: 'email', value: 'Ada@Example.com' }],
      };

      const created = await call<V1ContactUpsert>('POST', '/api/v1/contacts', key, body);
      expect(created.body.created).toBe(true);
      const again = await call<V1ContactUpsert>('POST', '/api/v1/contacts', key, {
        ...body,
        name: 'Ada King',
      });
      expect(again.body).toMatchObject({
        created: false,
        contact: { id: created.body.contact.id, name: 'Ada King' },
      });

      const found = await call<{ contacts: { id: string }[] }>(
        'GET',
        '/api/v1/contacts?search=ada',
        key,
      );
      expect(found.body.contacts.map((contact) => contact.id)).toContain(created.body.contact.id);
    });

    it('reads articles as a visitor does', async () => {
      const { key } = await issueKey(['articles:read']);

      const search = await call<{ hits: unknown[] }>('GET', '/api/v1/articles?q=refund', key);
      expect(search.status).toBe(200);
      expect(search.body.hits).toEqual([]);
      expect((await call('GET', '/api/v1/articles/no-such-article', key)).status).toBe(404);
    });

    it('serves the OpenAPI 3.1 document and its page without a key', async () => {
      const document = await app.inject({ method: 'GET', url: '/api/docs/openapi.json' });
      expect(document.statusCode).toBe(200);
      expect((document.json() as { openapi: string }).openapi).toBe('3.1.0');

      const page = await app.inject({ method: 'GET', url: '/api/docs' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  describe('outbound webhooks (M8-03)', () => {
    it('a ticket created through the API is delivered as a signed ticket.created webhook', async () => {
      const { key } = await issueKey(['tickets:write', 'webhooks:manage']);
      await runWorker(); // Earlier tests' events, before anybody subscribed.
      received.length = 0;

      const webhook = await call<WebhookWithSecret>('POST', '/api/v1/webhooks', key, {
        url: receiverUrl,
        events: ['ticket.created'],
      });
      expect(webhook.status).toBe(201);
      const created = await call<V1TicketDetail>(
        'POST',
        '/api/v1/tickets',
        key,
        newTicket('Signed'),
      );

      const jobs = await runWorker();
      expect(jobs).toHaveLength(1);
      for (const job of jobs) {
        await deliver(job);
      }

      expect(received).toHaveLength(1);
      const [delivery] = received;
      const signature = String(delivery?.headers['x-helpdock-signature']);
      expect(
        verifyWebhookSignature({
          secret: webhook.body.secret,
          header: signature,
          body: delivery?.body ?? '',
        }),
      ).toBe(true);
      const envelope = JSON.parse(delivery?.body ?? '{}') as WebhookEnvelope;
      expect(envelope.event).toBe('ticket.created');
      expect(envelope.brandId).toBe(seeded.brandId);
      expect((envelope.data.ticket as { id: string }).id).toBe(created.body.ticket.id);
      expect(delivery?.headers['x-helpdock-event-id']).toBe(envelope.id);

      // The delivery log says so, and a replay sends the same event again.
      const log = await call<WebhookDeliveryList>(
        'GET',
        `/api/v1/webhooks/${webhook.body.id}/deliveries`,
        key,
      );
      const [logged] = log.body.deliveries;
      expect(logged).toMatchObject({
        status: 'succeeded',
        attempts: 1,
        responseStatus: 200,
        responseExcerpt: 'thanks',
      });

      const replay = await call<{ id: string; replayOf: string }>(
        'POST',
        `/api/v1/webhooks/${webhook.body.id}/deliveries/${logged?.id}/replay`,
        key,
      );
      expect(replay.body.replayOf).toBe(logged?.id);
      for (const job of await runWorker()) {
        await deliver(job);
      }
      expect(received).toHaveLength(2);
      expect((JSON.parse(received[1]?.body ?? '{}') as WebhookEnvelope).id).toBe(envelope.id);

      // A redelivered event adds no second delivery.
      expect(await runWorker()).toEqual([]);
    });

    it('refuses a private address or plain http when the endpoint is added', async () => {
      const { key } = await issueKey(['webhooks:manage']);

      const blocked = await call<{ error: { webhooks?: unknown } }>(
        'POST',
        '/api/v1/webhooks',
        key,
        { url: 'https://10.0.4.12/hooks', events: ['ticket.created'] },
      );
      const http = await call<{ error: { webhooks?: unknown } }>(
        'POST',
        `/api/brands/${seeded.brandId}/webhooks`,
        staffToken,
        { url: 'http://93.184.216.34/hooks', events: ['ticket.created'] },
      );

      expect(blocked.status).toBe(400);
      expect(blocked.body.error.webhooks).toEqual({
        reason: 'webhook-destination-blocked',
        address: '10.0.4.12',
      });
      expect(http.status).toBe(400);
      expect(http.body.error.webhooks).toEqual({ reason: 'webhook-https-required' });
    });

    it('never reaches an endpoint the outbound policy blocks at delivery time, and logs why', async () => {
      const { key } = await issueKey(['tickets:write', 'webhooks:manage']);
      await runWorker();
      received.length = 0;

      // Allowed when added, refused when sent: the delivery policy allows the
      // receiver's port alone.
      const webhook = await call<WebhookWithSecret>('POST', '/api/v1/webhooks', key, {
        url: 'http://127.0.0.1:1/hooks',
        events: ['ticket.created'],
      });
      await call('POST', '/api/v1/tickets', key, newTicket('Blocked'));

      // Two endpoints now hear `ticket.created`: the earlier test's, which is
      // delivered, and this one, whose attempt fails and is retried.
      const jobs = await runWorker();
      expect(jobs).toHaveLength(2);
      const outcomes = await Promise.allSettled(jobs.map((job) => deliver(job)));
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);

      const log = await call<WebhookDeliveryList>(
        'GET',
        `/api/v1/webhooks/${webhook.body.id}/deliveries`,
        key,
      );
      expect(log.body.deliveries[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        responseStatus: null,
      });
      expect(log.body.deliveries[0]?.error).toMatch(/destination-blocked|port-not-allowed/);
      expect(received).toHaveLength(1);
    });

    it('sends contact.created and a public ticket.replied, and never a note', async () => {
      const { key } = await issueKey(['tickets:write', 'contacts:write', 'webhooks:manage']);
      const ticket = await call<V1TicketDetail>(
        'POST',
        '/api/v1/tickets',
        key,
        newTicket('Thread'),
      );
      await runWorker();
      received.length = 0;
      await call('POST', '/api/v1/webhooks', key, {
        url: receiverUrl,
        events: ['contact.created', 'ticket.replied'],
      });

      const contact = await call<V1ContactUpsert>('POST', '/api/v1/contacts', key, {
        name: 'Grace Hopper',
        identities: [{ kind: 'email', value: 'grace@example.com' }],
      });
      const path = `/api/v1/tickets/${ticket.body.ticket.id}/messages`;
      await call('POST', path, key, { kind: 'note', bodyHtml: '<p>Internal only</p>' });
      await call('POST', path, key, { kind: 'public', bodyHtml: '<p>On its way.</p>' });
      for (const job of await runWorker()) {
        await deliver(job);
      }

      const envelopes = received.map((delivery) => JSON.parse(delivery.body) as WebhookEnvelope);
      expect(envelopes.map((envelope) => envelope.event).sort()).toEqual([
        'contact.created',
        'ticket.replied',
      ]);
      const created = envelopes.find((envelope) => envelope.event === 'contact.created');
      expect(created?.data.contact).toMatchObject({ id: contact.body.contact.id });
      const replied = envelopes.find((envelope) => envelope.event === 'ticket.replied');
      expect(replied?.data.message).toMatchObject({
        bodyText: expect.stringContaining('On its way.'),
      });
      expect(JSON.stringify(envelopes)).not.toContain('Internal only');
    });

    it('serves the Developers page: the overview, a test ping, and one delivery as it was sent', async () => {
      await runWorker();
      received.length = 0;
      const base = `/api/brands/${seeded.brandId}/webhooks`;
      const webhook = await call<WebhookWithSecret>('POST', base, staffToken, {
        url: receiverUrl,
        events: ['article.published'],
      });

      const ping = await call<WebhookDelivery>(
        'POST',
        `${base}/${webhook.body.id}/test`,
        staffToken,
      );
      expect(ping.status).toBe(202);
      expect(ping.body).toMatchObject({ event: 'ping', status: 'pending' });
      for (const job of await runWorker()) {
        await deliver(job);
      }
      expect(received).toHaveLength(1);
      expect(received[0]?.headers['x-helpdock-event']).toBe('ping');

      const detail = await call<WebhookDeliveryDetail>(
        'GET',
        `${base}/${webhook.body.id}/deliveries/${ping.body.id}`,
        staffToken,
      );
      expect(detail.body).toMatchObject({ status: 'succeeded', responseStatus: 200 });
      const sent = detail.body.request.headers.find(
        (header) => header.name === 'x-helpdock-signature',
      );
      expect(sent?.value).toBe(received[0]?.headers['x-helpdock-signature']);
      expect(detail.body.request.body).toBe(received[0]?.body);

      const overview = await call<WebhookOverviewList>('GET', base, staffToken);
      const listed = overview.body.webhooks.find((candidate) => candidate.id === webhook.body.id);
      expect(listed).toMatchObject({
        createdByName: expect.any(String),
        last24h: { total: 1, succeeded: 1 },
        lastDelivery: { id: ping.body.id, status: 'succeeded' },
      });
      expect(JSON.stringify(overview.body)).not.toContain(webhook.body.secret);
    });
  });
});
