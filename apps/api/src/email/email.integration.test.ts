import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  departments,
  emailDeliveries,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { type EmailSendPayload, silentLogger } from '@helpdock/jobs';
import type {
  EmailOutgoingSettings,
  EmailSignature,
  FailedSendList,
  OutgoingSmtpTestResult,
  TicketDetail,
  TicketEmailContext,
  TicketMessage,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { AutoReplyService } from './auto-reply.service.js';
import { EmailRepository } from './email.repository.js';
import { createEmailSendEventHandler, EMAIL_EVENTS } from './email-events.js';
import { createEmailSendHandler, createEmailSendProcessor } from './email-send.job.js';
import { OutboundEmailService } from './outbound-email.service.js';
import { type InstallSmtp, smtpTransportFactory } from './transport.js';

/**
 * M2-05 and M2-06 against a real Postgres, Redis and Mailpit (ARCHITECTURE
 * §15's SMTP double). What only the whole chain can prove:
 *
 * - an agent's reply on an email ticket queues one `email_deliveries` row and
 *   one `email.send` outbox row in the reply's transaction, and the consumer
 *   delivers it to the contact with the CC copied and a deterministic
 *   `Message-ID`;
 * - **delivering the same job twice sends one email** (M2 exit criterion);
 * - a send the relay keeps refusing lands in Failed sends after five attempts,
 *   visible to the Admin and on the thread, and can be discarded and retried
 *   (M2 exit criterion "fails gracefully into the DLQ, visible in admin");
 * - the acknowledgment is sent once per ticket with `Auto-Submitted`, never to
 *   a machine, and not past the per-sender cap;
 * - the routes are Admin-only where they configure, and department-scoped
 *   where they read a ticket.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the outbound email integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface MailpitSummary {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly From: { Address: string; Name: string };
  readonly To: { Address: string }[];
  readonly Cc: { Address: string }[] | null;
}

const NO_INSTALL_SMTP: InstallSmtp = { read: async () => undefined };

describe.skipIf(!hasDocker)('outbound email', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let mailpitApi: string;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  let admin: Person;
  let agent: Person;
  let contactId: string;

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
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    who: Person,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = () => `/api/brands/${seeded.brandId}`;

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });
    const body = response.json() as { kind: string; accessToken?: string };
    if (body.kind !== 'session' || body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }
    return body.accessToken;
  };

  const mailpitMessages = async (): Promise<MailpitSummary[]> => {
    const response = await fetch(`${mailpitApi}/api/v1/messages`);
    return ((await response.json()) as { messages: MailpitSummary[] }).messages;
  };

  const mailpitHeaders = async (id: string): Promise<Record<string, string[]>> => {
    const response = await fetch(`${mailpitApi}/api/v1/message/${id}/headers`);
    return (await response.json()) as Record<string, string[]>;
  };

  const clearMailpit = async (): Promise<void> => {
    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
  };

  /** The brand's own server, pointed at Mailpit or at a port nothing listens on. */
  const useSmtp = async (port: number): Promise<void> => {
    const saved = await call<EmailOutgoingSettings>(
      'PUT',
      `${brandPath()}/email/outgoing/smtp`,
      admin,
      {
        host: mailpit.getHost(),
        port,
        tls: 'none',
        user: '',
        password: 'relay-secret',
      },
    );
    expect(saved.status).toBe(200);
  };

  const createTicket = async (departmentId: string, channel = 'email'): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, admin, {
      subject: 'Refund not received after 10 days',
      bodyHtml: '<p>My refund has not arrived.</p>',
      departmentId,
      contactId,
      channel,
    });
    expect(response.status).toBe(201);
    return response.body.ticket.id;
  };

  const reply = async (ticketId: string, emailFrom?: string): Promise<TicketMessage> => {
    const response = await call<TicketMessage>(
      'POST',
      `${brandPath()}/tickets/${ticketId}/messages`,
      admin,
      {
        kind: 'public',
        bodyHtml: '<p>Your refund was issued on 4 September.</p>',
        ...(emailFrom === undefined ? {} : { emailFrom }),
      },
    );
    expect(response.status).toBe(201);
    return response.body;
  };

  /** The `email.send` outbox rows for a delivery, oldest first. */
  const sendEvents = async (deliveryId: string): Promise<{ id: string }[]> =>
    owner.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.event, EMAIL_EVENTS.send),
          sql`${outbox.payload} ->> 'deliveryId' = ${deliveryId}`,
        ),
      )
      .orderBy(outbox.id);

  const deliveryFor = async (messageId: string) => {
    const [row] = await owner.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.ticketMessageId, messageId));
    if (row === undefined) {
      throw new Error(`no delivery for message ${messageId}`);
    }
    return row;
  };

  /** What the worker does with one `email.send` outbox row: the job it adds. */
  const jobFor = async (outboxId: string, deliveryId: string): Promise<Job> => {
    const added: { jobId: string; payload: EmailSendPayload }[] = [];
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      createEmailSendEventHandler({ add: async (input) => void added.push(input) })({
        outboxId,
        brandId: seeded.brandId,
        event: EMAIL_EVENTS.send,
        payload: { deliveryId },
        tx,
        log: silentLogger,
      }),
    );
    const [first] = added;
    if (first === undefined) {
      throw new Error('the email.send handler added no job');
    }
    return {
      name: 'email.send',
      id: first.jobId,
      data: first.payload,
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as Job;
  };

  const processor = () => {
    const repository = new EmailRepository();
    return createEmailSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository,
      handler: createEmailSendHandler({
        repository,
        keyring: createKeyring(envFor()),
        installSmtp: NO_INSTALL_SMTP,
        transports: smtpTransportFactory,
      }),
    });
  };

  beforeAll(async () => {
    [postgres, redisContainer, mailpit] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_HTTP_PORT)
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
    ]);
    mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(MAILPIT_HTTP_PORT))}`;

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });

    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    admin = { id: seeded.userId, email: seeded.email, token: '' };
    agent = { id: uuidv7(), email: `bo-${uuidv7()}@helpdock.test`, token: '' };
    await runtime.db.insert(users).values({
      id: agent.id,
      email: agent.email,
      name: 'Bo',
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
    });

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values({
        userId: agent.id,
        brandId: seeded.brandId,
        role: 'agent',
        departmentIds: [billing],
      });

      const [contact] = await tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: 'Mona Khalil' })
        .returning({ id: contacts.id });
      contactId = contact?.id ?? '';
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId,
        kind: 'email',
        value: 'mona@example.com',
        verified: true,
        source: 'email.inbound',
      });
    });

    admin.token = await signIn(seeded.email, seeded.password);
    agent.token = await signIn(agent.email, AGENT_PASSWORD);

    await useSmtp(mailpit.getMappedPort(MAILPIT_SMTP_PORT));
    const senders = await call<EmailOutgoingSettings>(
      'PUT',
      `${brandPath()}/email/outgoing/senders`,
      admin,
      {
        defaultFrom: { name: 'Helpdock Support', address: 'support@helpdock.test' },
        departments: [
          {
            departmentId: billing,
            from: { name: 'Helpdock Billing', address: 'billing@helpdock.test' },
            replyTo: 'billing@helpdock.test',
          },
        ],
      },
    );
    expect(senders.status).toBe(200);
    await call<EmailSignature>('PUT', '/api/me/signature', admin, {
      en: 'Lina Haddad\nBilling team · Helpdock',
      ar: '',
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  it('shows the saved server without its password, and tests it with one message', async () => {
    await clearMailpit();

    const settings = await call<EmailOutgoingSettings>(
      'GET',
      `${brandPath()}/email/outgoing`,
      admin,
    );
    expect(settings.status).toBe(200);
    expect(settings.body.smtp).toMatchObject({ host: mailpit.getHost(), passwordSet: true });
    expect(JSON.stringify(settings.body)).not.toContain('relay-secret');

    const test = await call<OutgoingSmtpTestResult>(
      'POST',
      `${brandPath()}/email/outgoing/smtp/test`,
      admin,
      {
        host: mailpit.getHost(),
        port: mailpit.getMappedPort(MAILPIT_SMTP_PORT),
        tls: 'none',
        user: '',
      },
    );
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ delivered: true, recipient: admin.email });
    expect((await mailpitMessages()).map((message) => message.To[0]?.Address)).toEqual([
      admin.email,
    ]);
  });

  it('keeps the configuration and the Failed sends panel to Admins', async () => {
    expect((await call('GET', `${brandPath()}/email/outgoing`, agent)).status).toBe(403);
    expect((await call('GET', `${brandPath()}/email/failed-sends`, agent)).status).toBe(403);
  });

  it('delivers a reply to the contact with the CC, once, however often the job arrives', async () => {
    await clearMailpit();
    const ticketId = await createTicket(billing);
    const cc = await call('POST', `${brandPath()}/tickets/${ticketId}/participants`, admin, {
      email: 'karim@acme.test',
    });
    expect(cc.status).toBe(201);

    const message = await reply(ticketId);
    const delivery = await deliveryFor(message.id);
    expect(delivery).toMatchObject({
      status: 'queued',
      fromAddress: 'billing@helpdock.test',
      toAddress: 'mona@example.com',
      ccAddresses: ['karim@acme.test'],
      messageId: `<hd.m.${message.id}@helpdock.test>`,
    });
    const [event] = await sendEvents(delivery.id);
    const job = await jobFor(event?.id ?? '', delivery.id);
    const process = processor();

    await process(job);
    await process(job);
    await Promise.all([process(job), process(job)]);

    const delivered = await mailpitMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      MessageID: `hd.m.${message.id}@helpdock.test`,
      Subject: expect.stringMatching(/^Re: \[.+-\d+\] Refund not received after 10 days$/),
      From: { Address: 'billing@helpdock.test', Name: 'Dev Admin via Helpdock Billing' },
    });
    expect(delivered[0]?.Cc?.map((address) => address.Address)).toEqual(['karim@acme.test']);
    expect((await deliveryFor(message.id)).status).toBe('sent');
  });

  it('sends nothing for a chat ticket, and nothing for an internal note', async () => {
    const chat = await createTicket(billing, 'chat');
    const chatReply = await reply(chat);
    const note = await call<TicketMessage>(
      'POST',
      `${brandPath()}/tickets/${chat}/messages`,
      admin,
      {
        kind: 'note',
        bodyHtml: '<p>Internal.</p>',
      },
    );

    const rows = await owner.db
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.ticketId, chat));
    expect(rows).toEqual([]);
    expect([chatReply.id, note.body.id]).toHaveLength(2);
  });

  it('dead-letters a send the relay keeps refusing, shows it, and puts it back on retry', async () => {
    await useSmtp(1);
    const ticketId = await createTicket(billing);
    const message = await reply(ticketId);
    const delivery = await deliveryFor(message.id);
    const [event] = await sendEvents(delivery.id);
    const job = await jobFor(event?.id ?? '', delivery.id);
    const process = processor();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(process({ ...job, attemptsMade: attempt } as Job)).rejects.toThrow();
    }

    const failed = await deliveryFor(message.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 5 });
    expect(failed.lastError).not.toBeNull();

    const list = await call<FailedSendList>('GET', `${brandPath()}/email/failed-sends`, admin);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: delivery.id,
        recipient: 'mona@example.com',
        attempts: 5,
        maxAttempts: 5,
      }),
    ]);

    const context = await call<TicketEmailContext>(
      'GET',
      `${brandPath()}/tickets/${ticketId}/email`,
      agent,
    );
    expect(context.status).toBe(200);
    expect(context.body.deliveries).toEqual([
      expect.objectContaining({ messageId: message.id, status: 'failed', attempts: 5 }),
    ]);

    const discarded = await call(
      'POST',
      `${brandPath()}/email/failed-sends/${delivery.id}/discard`,
      admin,
    );
    expect(discarded.status).toBe(204);
    expect((await deliveryFor(message.id)).status).toBe('discarded');
    expect(
      (await call<FailedSendList>('GET', `${brandPath()}/email/failed-sends`, admin)).body.items,
    ).toEqual([]);

    await useSmtp(mailpit.getMappedPort(MAILPIT_SMTP_PORT));
    await clearMailpit();
    const retried = await call(
      'POST',
      `${brandPath()}/tickets/${ticketId}/email/messages/${message.id}/retry`,
      agent,
    );
    expect(retried.status).toBe(204);
    const events = await sendEvents(delivery.id);
    expect(events).toHaveLength(2);
    await processor()(await jobFor(events[1]?.id ?? '', delivery.id));

    expect((await deliveryFor(message.id)).status).toBe('sent');
    expect((await mailpitMessages())[0]?.MessageID).toBe(`hd.m.${message.id}@helpdock.test`);
  });

  it("hides another department's ticket from an agent, as every ticket read does", async () => {
    const ticketId = await createTicket(support);

    expect((await call('GET', `${brandPath()}/tickets/${ticketId}/email`, agent)).status).toBe(404);
  });

  it('acknowledges a new ticket once, marked Auto-Submitted, and never past the cap', async () => {
    await clearMailpit();
    const saved = await call<EmailOutgoingSettings>('GET', `${brandPath()}/email/outgoing`, admin);
    await call('PUT', `${brandPath()}/email/outgoing/auto-replies`, admin, {
      ...saved.body.autoReplies,
      acknowledgment: { ...saved.body.autoReplies.acknowledgment, enabled: true },
      perSenderHourlyCap: 2,
    });
    const repository = new EmailRepository();
    const autoReplies = new AutoReplyService(
      repository,
      new OutboundEmailService(repository, NO_INSTALL_SMTP),
    );
    const first = await createTicket(billing);
    const second = await createTicket(billing);
    const third = await createTicket(billing);
    const inbound = (ticketId: string, autoGenerated = false) => ({
      ticketId,
      ticketMessageId: uuidv7(),
      createdTicket: true,
      from: 'Mona@Example.com',
      autoGenerated,
    });

    const outcomes = await withSystem(runtime.db, seeded.brandId, async (tx) => [
      await autoReplies.onInboundEmail(tx, seeded.brandId, inbound(first, true)),
      await autoReplies.onInboundEmail(tx, seeded.brandId, inbound(first)),
      await autoReplies.onInboundEmail(tx, seeded.brandId, inbound(first)),
      await autoReplies.onInboundEmail(tx, seeded.brandId, inbound(second)),
      await autoReplies.onInboundEmail(tx, seeded.brandId, inbound(third)),
    ]);
    expect(outcomes).toEqual([
      'auto-generated',
      'acknowledgment',
      'not-queued',
      'acknowledgment',
      'capped',
    ]);

    const [ack] = await owner.db
      .select()
      .from(emailDeliveries)
      .where(and(eq(emailDeliveries.ticketId, first), eq(emailDeliveries.kind, 'acknowledgment')));
    const [event] = await sendEvents(ack?.id ?? '');
    await processor()(await jobFor(event?.id ?? '', ack?.id ?? ''));

    const [message] = await mailpitMessages();
    expect(message?.Subject).toMatch(/^\[.+-\d+\] We received your message$/);
    const headers = await mailpitHeaders(message?.ID ?? '');
    expect(headers['Auto-Submitted']).toEqual(['auto-replied']);
    expect(headers.Precedence).toEqual(['bulk']);
  });

  it('keeps a signature to six lines', async () => {
    const tooLong = await call('PUT', '/api/me/signature', agent, {
      en: '1\n2\n3\n4\n5\n6\n7',
      ar: '',
    });
    expect(tooLong.status).toBe(400);

    const saved = await call<EmailSignature>('PUT', '/api/me/signature', agent, {
      en: 'Bo',
      ar: 'بو',
    });
    expect(saved.body).toEqual({ en: 'Bo', ar: 'بو' });
    expect((await call<EmailSignature>('GET', '/api/me/signature', agent)).body).toEqual({
      en: 'Bo',
      ar: 'بو',
    });
  });
});
