import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketMessages,
  ticketStatuses,
  tickets,
  uuidv7,
  type WebhookDeliveryRow,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type { WebhookEnvelope } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { createWebhookSourceHandler, WEBHOOK_DELIVERY_REQUESTED_EVENT } from './webhook-events.js';
import { WebhooksRepository } from './webhooks.repository.js';

/**
 * The webhooks subscriber (M8-03) against real Postgres: what one domain
 * event leaves behind in `webhook_deliveries` and the outbox.
 *
 * 1. **The delivery carries the thing, not its id**: the ticket as the public
 *    API shows it, frozen into the row, one row per endpoint that asked, and
 *    one `webhook.delivery_requested` event per row.
 * 2. **A redelivered event adds nothing** (DOMAIN-RULES §6).
 * 3. **A reply sends the message with its ticket**; a reply whose message
 *    turned out to be a note sends nothing.
 * 4. **A ticket that is gone sends nothing.**
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 83).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const NOW = new Date('2026-10-06T10:00:00Z');

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the webhooks subscriber integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the webhooks subscriber (M8-03)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let departmentId: string;
  let openStatusId: string;
  let ticketNumber = 7_000;

  const repository = new WebhooksRepository();
  const handle = createWebhookSourceHandler(repository, () => NOW);

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: postgres
        .getConnectionUri()
        .replace(/\/\/[^@]+@/, `//helpdock_app:${APP_ROLE_PASSWORD}@`)
        .replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      DATABASE_MIGRATION_URL: postgres.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://bucket.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock-webhooks',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const db = (): Db => runtime.db;

  const endpointFor = (events: string[]): Promise<string> =>
    withSystem(db(), seeded.brandId, async (tx) => {
      const row = await repository.insert(tx, {
        brandId: seeded.brandId,
        url: `https://hooks.example.com/${uuidv7()}`,
        description: '',
        events,
        secret: 'v1.test.sealed',
      });
      return row.id;
    });

  /** One open ticket with one message of the given kind. */
  const seedTicket = async (
    kind: 'public' | 'note' = 'public',
  ): Promise<{ ticketId: string; messageId: string; number: number }> => {
    const ticketId = uuidv7();
    ticketNumber += 1;
    const number = ticketNumber;
    return withSystem(db(), seeded.brandId, async (tx) => {
      await tx.insert(tickets).values({
        id: ticketId,
        brandId: seeded.brandId,
        departmentId,
        number,
        prefix: 'WH',
        subject: `Webhook ticket ${number}`,
        statusId: openStatusId,
        priority: 'high',
        channel: 'email',
        contactId: null,
      });
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          brandId: seeded.brandId,
          ticketId,
          departmentId,
          seq: 1,
          kind,
          authorType: 'staff',
          authorId: seeded.userId,
          bodyHtml: '<p>Your order left the warehouse.</p>',
          bodyText: 'Your order left the warehouse.',
          channel: 'email',
        })
        .returning({ id: ticketMessages.id });
      return { ticketId, messageId: message?.id ?? '', number };
    });
  };

  const run = (
    event: string,
    payload: Record<string, unknown>,
    outboxId = uuidv7(),
  ): Promise<string> =>
    withSystem(db(), seeded.brandId, async (tx) => {
      await handle({ outboxId, brandId: seeded.brandId, event, payload, tx, log: silentLogger });
      return outboxId;
    });

  const deliveriesOf = (webhookId: string): Promise<WebhookDeliveryRow[]> =>
    withSystem(db(), seeded.brandId, (tx) =>
      repository.deliveries(tx, webhookId, { before: undefined, limit: 10 }),
    );

  const requestedDeliveryIds = (): Promise<string[]> =>
    withSystem(db(), seeded.brandId, async (tx) =>
      (
        await tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, WEBHOOK_DELIVERY_REQUESTED_EVENT))
      ).map((row) => String(row.payload.deliveryId)),
    );

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    seeded = await seedDevInstall({ db: db(), env: envFor() });

    [departmentId, openStatusId] = await withSystem(db(), seeded.brandId, async (tx) => {
      const [department] = await tx.select({ id: departments.id }).from(departments).limit(1);
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'))
        .limit(1);
      return [department?.id ?? '', open?.id ?? ''];
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('freezes the ticket into one delivery per endpoint that asked, and asks for each', async () => {
    const { ticketId, number } = await seedTicket();
    const [first, second, closedOnly] = await Promise.all([
      endpointFor(['ticket.created']),
      endpointFor(['ticket.created', 'ticket.closed']),
      endpointFor(['ticket.closed']),
    ]);

    const outboxId = await run('ticket.created', { ticketId });

    const [delivery] = await deliveriesOf(first);
    expect(delivery).toMatchObject({
      brandId: seeded.brandId,
      webhookId: first,
      eventId: outboxId,
      event: 'ticket.created',
      status: 'pending',
      attempts: 0,
      replayOf: null,
    });
    const envelope = delivery?.payload as unknown as WebhookEnvelope;
    expect(envelope).toMatchObject({
      id: outboxId,
      event: 'ticket.created',
      createdAt: NOW.toISOString(),
      brandId: seeded.brandId,
    });
    expect(envelope.data).toEqual({
      ticket: expect.objectContaining({
        id: ticketId,
        number,
        prefix: 'WH',
        subject: `Webhook ticket ${number}`,
        priority: 'high',
        channel: 'email',
        departmentId,
        status: expect.objectContaining({ id: openStatusId, name: 'Open', systemState: 'open' }),
        tags: [],
      }),
    });
    // The row is the public shape: nothing that only the database knows.
    expect(envelope.data.ticket).not.toHaveProperty('statusId');
    expect(envelope.data.ticket).not.toHaveProperty('deletedAt');

    const [secondDelivery] = await deliveriesOf(second);
    expect(secondDelivery?.payload).toEqual(delivery?.payload);
    expect(await deliveriesOf(closedOnly)).toEqual([]);
    expect(await requestedDeliveryIds()).toEqual(
      expect.arrayContaining([delivery?.id, secondDelivery?.id]),
    );
  });

  it('adds no second delivery when the same event is delivered again', async () => {
    const { ticketId } = await seedTicket();
    const endpoint = await endpointFor(['ticket.updated']);
    const outboxId = uuidv7();

    await run('ticket.updated', { ticketId }, outboxId);
    await run('ticket.updated', { ticketId }, outboxId);

    const deliveries = await deliveriesOf(endpoint);
    expect(deliveries).toHaveLength(1);
    expect((await requestedDeliveryIds()).filter((id) => id === deliveries[0]?.id)).toHaveLength(1);
  });

  it('sends a public reply with its ticket, and nothing for a message that is a note', async () => {
    const replied = await seedTicket('public');
    const noted = await seedTicket('note');
    const endpoint = await endpointFor(['ticket.replied']);

    await run('ticket.replied', { ticketId: replied.ticketId, messageId: replied.messageId });
    await run('ticket.replied', { ticketId: noted.ticketId, messageId: noted.messageId });

    const [delivery, ...more] = await deliveriesOf(endpoint);
    expect(more).toEqual([]);
    const envelope = delivery?.payload as unknown as WebhookEnvelope | undefined;
    expect(envelope?.data).toEqual({
      ticket: expect.objectContaining({ id: replied.ticketId }),
      message: expect.objectContaining({
        id: replied.messageId,
        ticketId: replied.ticketId,
        seq: 1,
        kind: 'public',
        authorType: 'staff',
        authorId: seeded.userId,
        bodyText: 'Your order left the warehouse.',
        channel: 'email',
        attachments: [],
      }),
    });
  });

  it('sends nothing when the ticket the event was about is gone', async () => {
    const { ticketId } = await seedTicket();
    const endpoint = await endpointFor(['ticket.closed']);
    await withSystem(db(), seeded.brandId, (tx) =>
      tx.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, ticketId)),
    );

    await run('ticket.closed', { ticketId });

    expect(await deliveriesOf(endpoint)).toEqual([]);
  });
});
