import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createKeyring, type Env } from '@helpdock/config';
import {
  createDb,
  type DbHandle,
  departments,
  emailDeliveries,
  outbox,
  ticketMessages,
  ticketSlaClocks,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type {
  EmailOutgoingSettings,
  InboundParseSecret,
  Mailbox,
  SlaPolicy,
  TicketMessage,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { AutoReplyService } from '../email/auto-reply.service.js';
import { EmailRepository } from '../email/email.repository.js';
import {
  createEmailReceivedEventHandler,
  createEmailSendEventHandler,
  EMAIL_EVENTS,
  type EmailReceivedEvent,
} from '../email/email-events.js';
import { createEmailSendHandler, createEmailSendProcessor } from '../email/email-send.job.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import { type InstallSmtp, smtpTransportFactory } from '../email/transport.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { businessHoursProbe } from '../sla/business-hours-probe.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { noSurveyEmails } from '../testing/csat-doubles.js';
import { FakeStorage } from '../testing/media.js';

/**
 * Where M2's two halves meet, against real Postgres, Redis and Mailpit:
 *
 * 1. An email to a mailbox writes `email.received` in the transaction that
 *    files it, and the auto-responder answers it with exactly one
 *    acknowledgment; a machine, allow-listed or not, is never answered.
 * 2. M2's first exit criterion: an email to a mailbox creates a ticket, the
 *    agent's reply is delivered, and the customer's reply to that email —
 *    `In-Reply-To` our `Message-ID`, no ticket number in the subject —
 *    threads onto the same ticket. A stranger holding the same `Message-ID`
 *    still gets a ticket of their own (DOMAIN-RULES §4.3).
 * 3. Where M2 meets M3: the out-of-hours reply reads M3-01's business hours,
 *    and a mailed ticket runs M3-02's clocks as a ticket typed in does.
 *
 * The worker is played by hand, one outbox row at a time, as the outbound
 * suite does: the relay and BullMQ are covered elsewhere.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const MAILBOX = 'desk@helpdock.test';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M2 round-trip integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface MailpitSummary {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly To: { Address: string }[];
}

const NO_INSTALL_SMTP: InstallSmtp = { read: async () => undefined };

describe.skipIf(!hasDocker)('inbound and outbound email together', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let mailpitApi: string;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let token = '';
  let secret = '';
  let support = '';

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
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = () => `/api/brands/${seeded.brandId}`;

  /** One email to the mailbox, through the generic inbound-parse endpoint. */
  const receive = async (message: Record<string, unknown>): Promise<string | undefined> => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/inbound-parse/generic',
      headers: { 'content-type': 'application/json', 'x-helpdock-inbound-secret': secret },
      payload: JSON.stringify({ to: [{ address: MAILBOX }], ...message }),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { outcome?: string }).outcome;
  };

  const messageOf = async (externalId: string) => {
    const [row] = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.externalMessageId, externalId));
    if (row === undefined) {
      throw new Error(`no ticket message for ${externalId}`);
    }
    return row;
  };

  const receivedEvents = async (
    ticketId: string,
  ): Promise<{ id: string; payload: Record<string, unknown> }[]> =>
    owner.db
      .select({ id: outbox.id, payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.event, EMAIL_EVENTS.received),
          sql`${outbox.payload} ->> 'ticketId' = ${ticketId}`,
        ),
      )
      .orderBy(outbox.id);

  const autoReplies = () => {
    const repository = new EmailRepository();
    return new AutoReplyService(repository, new OutboundEmailService(repository, NO_INSTALL_SMTP));
  };

  /** The worker's half of `email.received`: the auto-responder decides. */
  const handleReceived = async (
    event: {
      id: string;
      payload: Record<string, unknown>;
    },
    service: AutoReplyService = autoReplies(),
  ): Promise<void> => {
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      createEmailReceivedEventHandler(service)({
        outboxId: event.id,
        brandId: seeded.brandId,
        event: EMAIL_EVENTS.received,
        payload: event.payload,
        tx,
        log: silentLogger,
      }),
    );
  };

  /** The worker's half of `email.send` for every queued delivery of a ticket: one SMTP send each. */
  const sendQueued = async (ticketId: string): Promise<void> => {
    const repository = new EmailRepository();
    const process = createEmailSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository,
      handler: createEmailSendHandler({
        repository,
        keyring: createKeyring(envFor()),
        installSmtp: NO_INSTALL_SMTP,
        transports: smtpTransportFactory,
        surveys: noSurveyEmails,
      }),
    });
    const queued = await owner.db
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(and(eq(emailDeliveries.ticketId, ticketId), eq(emailDeliveries.status, 'queued')));
    for (const delivery of queued) {
      const [event] = await owner.db
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.event, EMAIL_EVENTS.send),
            sql`${outbox.payload} ->> 'deliveryId' = ${delivery.id}`,
          ),
        );
      const added: { jobId: string; payload: { brandId: string; deliveryId: string } }[] = [];
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        createEmailSendEventHandler({ add: async (input) => void added.push(input) })({
          outboxId: event?.id ?? '',
          brandId: seeded.brandId,
          event: EMAIL_EVENTS.send,
          payload: { deliveryId: delivery.id },
          tx,
          log: silentLogger,
        }),
      );
      for (const job of added) {
        await process({
          name: 'email.send',
          id: job.jobId,
          data: job.payload,
          attemptsMade: 0,
          opts: { attempts: 5 },
        } as Job);
      }
    }
  };

  const mailpitMessages = async (): Promise<MailpitSummary[]> => {
    const response = await fetch(`${mailpitApi}/api/v1/messages`);
    return ((await response.json()) as { messages: MailpitSummary[] }).messages;
  };

  const mailpitHeaders = async (id: string): Promise<Record<string, string[]>> => {
    const response = await fetch(`${mailpitApi}/api/v1/message/${id}/headers`);
    return (await response.json()) as Record<string, string[]>;
  };

  const setAcknowledgment = async (enabled: boolean): Promise<void> => {
    const saved = await call<EmailOutgoingSettings>('GET', `${brandPath()}/email/outgoing`);
    const updated = await call('PUT', `${brandPath()}/email/outgoing/auto-replies`, {
      ...saved.body.autoReplies,
      acknowledgment: { ...saved.body.autoReplies.acknowledgment, enabled },
    });
    expect(updated.status).toBe(200);
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
    app = await createApiApp({
      runtime,
      objectStorage: new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-roundtrip-'))),
    });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [created] = await tx
        .insert(departments)
        .values({ brandId: seeded.brandId, name: 'Support' })
        .returning({ id: departments.id });
      support = created?.id ?? '';
    });

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: seeded.email, password: seeded.password }),
    });
    token = (signIn.json() as { accessToken: string }).accessToken;

    expect(
      (
        await call('PUT', `${brandPath()}/email/outgoing/smtp`, {
          host: mailpit.getHost(),
          port: mailpit.getMappedPort(MAILPIT_SMTP_PORT),
          tls: 'none',
          user: '',
          password: 'relay-secret',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PUT', `${brandPath()}/email/outgoing/senders`, {
          defaultFrom: { name: 'Helpdock Support', address: MAILBOX },
          departments: [],
        })
      ).status,
    ).toBe(200);

    secret = (await call<InboundParseSecret>('POST', `${brandPath()}/inbound-parse/secret`)).body
      .secret;
    const mailbox = await call<Mailbox>('POST', `${brandPath()}/mailboxes`, {
      address: MAILBOX,
      displayName: 'Helpdock Support',
      departmentId: support,
      method: 'inbound_parse',
      automatedAllowlist: ['alerts@statuspage.io'],
    });
    expect(mailbox.status).toBe(201);
  }, 300_000);

  beforeEach(async () => {
    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  it('acknowledges an email to a mailbox exactly once, through email.received', async () => {
    await setAcknowledgment(true);

    expect(
      await receive({
        from: { address: 'Rana@Example.com', name: 'Rana Aziz' },
        subject: 'Printer on fire',
        text: 'It is on fire.',
        messageId: '<ack-1@example.com>',
      }),
    ).toBe('accepted');
    const filed = await messageOf('ack-1@example.com');

    const events = await receivedEvents(filed.ticketId);
    expect(events.map((event) => event.payload)).toEqual([
      {
        ticketId: filed.ticketId,
        ticketMessageId: filed.id,
        createdTicket: true,
        from: 'rana@example.com',
        fromName: 'Rana Aziz',
        autoGenerated: false,
      } satisfies EmailReceivedEvent,
    ]);

    // A redelivered event decides again and queues nothing new.
    const [event] = events;
    if (event === undefined) {
      throw new Error('no email.received event');
    }
    await handleReceived(event);
    await handleReceived(event);
    await sendQueued(filed.ticketId);

    const delivered = await mailpitMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.To.map((to) => to.Address)).toEqual(['rana@example.com']);
    expect(delivered[0]?.Subject).toMatch(/We received your message$/);
    expect((await mailpitHeaders(delivered[0]?.ID ?? ''))['Auto-Submitted']).toEqual([
      'auto-replied',
    ]);

    // Her second message on the same ticket is not acknowledged again.
    await receive({
      from: { address: 'rana@example.com' },
      subject: 'Re: Printer on fire',
      text: 'Still burning.',
      messageId: '<ack-2@example.com>',
      inReplyTo: '<ack-1@example.com>',
    });
    const second = await messageOf('ack-2@example.com');
    expect(second.ticketId).toBe(filed.ticketId);
    const [, again] = await receivedEvents(filed.ticketId);
    expect(again?.payload).toMatchObject({ createdTicket: false });
    if (again !== undefined) {
      await handleReceived(again);
    }
    await sendQueued(filed.ticketId);
    expect(await mailpitMessages()).toHaveLength(1);
  });

  it('never answers a machine: an allow-listed one files a ticket, the rest file nothing', async () => {
    await setAcknowledgment(true);

    expect(
      await receive({
        from: { address: 'alerts@statuspage.io' },
        subject: 'Incident',
        text: 'Down',
        headers: { 'Auto-Submitted': 'auto-generated' },
        messageId: '<incident-1@statuspage.io>',
      }),
    ).toBe('accepted');
    const incident = await messageOf('incident-1@statuspage.io');
    const [event] = await receivedEvents(incident.ticketId);
    expect(event?.payload).toMatchObject({ createdTicket: true, autoGenerated: true });
    if (event !== undefined) {
      await handleReceived(event);
    }
    const deliveries = await owner.db
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.ticketId, incident.ticketId));
    expect(deliveries).toEqual([]);

    const before = await owner.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outbox)
      .where(eq(outbox.event, EMAIL_EVENTS.received));
    expect(
      await receive({
        from: { address: 'noreply@shop.example' },
        subject: 'Your order',
        text: 'Thanks',
        messageId: '<order-1@shop.example>',
      }),
    ).toBe('ignored');
    const after = await owner.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outbox)
      .where(eq(outbox.event, EMAIL_EVENTS.received));
    expect(after[0]?.count).toBe(before[0]?.count);
    expect(await mailpitMessages()).toEqual([]);
  });

  it('threads the customer’s reply to the agent’s email onto the same ticket (M2 exit criterion 1)', async () => {
    await setAcknowledgment(false);

    // 1. The customer writes to the mailbox: a ticket.
    await receive({
      from: { address: 'omar@example.com', name: 'Omar Said' },
      subject: 'Invoice is wrong',
      text: 'The VAT line is doubled.',
      messageId: '<invoice-1@example.com>',
    });
    const first = await messageOf('invoice-1@example.com');

    // 2. The agent answers; the reply reaches the customer's inbox (Mailpit).
    const answer = await call<TicketMessage>(
      'POST',
      `${brandPath()}/tickets/${first.ticketId}/messages`,
      { kind: 'public', bodyHtml: '<p>Fixed, a new invoice is on its way.</p>' },
    );
    expect(answer.status).toBe(201);
    await sendQueued(first.ticketId);
    const [sent] = await mailpitMessages();
    expect(sent?.MessageID).toBe(`hd.m.${answer.body.id}@helpdock.test`);
    expect(sent?.To.map((to) => to.Address)).toEqual(['omar@example.com']);
    expect((await mailpitHeaders(sent?.ID ?? ''))['In-Reply-To']).toEqual([
      '<invoice-1@example.com>',
    ]);

    // 3. The customer answers that email. The subject carries no ticket
    //    number, so only the headers can thread it.
    await receive({
      from: { address: 'omar@example.com' },
      subject: 'Re: thanks',
      text: 'Got it, thank you.',
      messageId: '<invoice-2@example.com>',
      inReplyTo: `<${sent?.MessageID ?? ''}>`,
      references: [`<${sent?.MessageID ?? ''}>`],
    });
    const reply = await messageOf('invoice-2@example.com');
    expect(reply.ticketId).toBe(first.ticketId);
    expect(reply.authorType).toBe('contact');

    // A stranger holding our Message-ID is still not a participant (§4.3).
    await receive({
      from: { address: 'mallory@evil.example' },
      subject: 'Re: thanks',
      text: 'Send the invoice to me.',
      messageId: '<mallory-1@evil.example>',
      inReplyTo: `<${sent?.MessageID ?? ''}>`,
    });
    expect((await messageOf('mallory-1@evil.example')).ticketId).not.toBe(first.ticketId);
  });

  describe('with M3 business hours and SLAs', () => {
    /** The auto-responder as the worker builds it, with M3-01's calendar and a fixed clock. */
    const autoRepliesAt = (now: Date): AutoReplyService => {
      const repository = new EmailRepository();
      const sla = new SlaRepository();
      return new AutoReplyService(
        repository,
        new OutboundEmailService(repository, NO_INSTALL_SMTP),
        businessHoursProbe(new BusinessHoursService(sla, new SlaService(sla))),
        () => now,
      );
    };

    const kindsOf = async (ticketId: string) =>
      (
        await owner.db
          .select({ kind: emailDeliveries.kind })
          .from(emailDeliveries)
          .where(eq(emailDeliveries.ticketId, ticketId))
      ).map((row) => row.kind);

    const clocksOf = (ticketId: string) =>
      owner.db
        .select()
        .from(ticketSlaClocks)
        .where(and(eq(ticketSlaClocks.ticketId, ticketId), eq(ticketSlaClocks.isCurrent, true)));

    it('sends the out-of-hours reply instead of the acknowledgment while the department is closed', async () => {
      // Open on Sundays 10:00–14:00 UTC only.
      const hours = await call('PUT', `${brandPath()}/business-hours`, {
        brand: {
          timezone: 'UTC',
          weekly: [[{ start: '10:00', end: '14:00' }], [], [], [], [], [], []],
        },
        departments: [],
      });
      expect(hours.status).toBe(200);
      const saved = await call<EmailOutgoingSettings>('GET', `${brandPath()}/email/outgoing`);
      expect(
        (
          await call('PUT', `${brandPath()}/email/outgoing/auto-replies`, {
            ...saved.body.autoReplies,
            acknowledgment: { ...saved.body.autoReplies.acknowledgment, enabled: true },
            outOfHours: { ...saved.body.autoReplies.outOfHours, enabled: true },
          })
        ).status,
      ).toBe(200);

      const answer = async (messageId: string, at: Date): Promise<string> => {
        await receive({
          from: { address: `${messageId}@example.com` },
          subject: 'Printer jammed',
          text: 'Paper everywhere.',
          messageId: `<${messageId}@example.com>`,
        });
        const filed = await messageOf(`${messageId}@example.com`);
        const [event] = await receivedEvents(filed.ticketId);
        if (event === undefined) {
          throw new Error('no email.received event');
        }
        await handleReceived(event, autoRepliesAt(at));
        return filed.ticketId;
      };

      // Monday 2027-01-04 11:00 UTC: closed.
      const closed = await answer('hours-closed', new Date('2027-01-04T11:00:00Z'));
      expect(await kindsOf(closed)).toEqual(['out_of_hours']);
      await sendQueued(closed);
      const [notice] = await mailpitMessages();
      expect(notice?.To.map((to) => to.Address)).toEqual(['hours-closed@example.com']);
      expect((await mailpitHeaders(notice?.ID ?? ''))['Auto-Submitted']).toEqual(['auto-replied']);

      // Sunday 2027-01-03 11:00 UTC: open.
      const open = await answer('hours-open', new Date('2027-01-03T11:00:00Z'));
      expect(await kindsOf(open)).toEqual(['acknowledgment']);
    });

    it('starts the clocks of a mailed ticket and resumes them when the customer mails back', async () => {
      await setAcknowledgment(false);
      const hours = await call('PUT', `${brandPath()}/business-hours`, {
        brand: {
          timezone: 'UTC',
          weekly: Array.from({ length: 7 }, () => [{ start: '00:00', end: '24:00' }]),
        },
        departments: [],
      });
      expect(hours.status).toBe(200);
      const policy = await call<SlaPolicy>('POST', `${brandPath()}/sla-policies`, {
        name: 'Support by email',
        conditions: [{ field: 'department', operator: 'any', values: [support] }],
        timeMode: 'calendar',
        targets: {
          low: { firstResponseMinutes: 60, resolutionMinutes: 480 },
          medium: { firstResponseMinutes: 60, resolutionMinutes: 480 },
          high: { firstResponseMinutes: 30, resolutionMinutes: 240 },
          urgent: { firstResponseMinutes: 15, resolutionMinutes: 120 },
        },
        escalation: [],
      });
      expect(policy.status).toBe(201);

      // 1. The mail files a ticket: both clocks start under the policy.
      await receive({
        from: { address: 'sami@example.com' },
        subject: 'Cannot log in',
        text: 'The password reset never arrives.',
        messageId: '<sla-1@example.com>',
      });
      const filed = await messageOf('sla-1@example.com');
      const started = await clocksOf(filed.ticketId);
      expect(started.map((clock) => clock.kind).sort()).toEqual(['first_response', 'resolution']);
      expect(started.every((clock) => clock.policyId === policy.body.id)).toBe(true);
      expect(started.find((clock) => clock.kind === 'first_response')?.targetMinutes).toBe(60);

      // 2. The agent answers: first response met, and Awaiting customer pauses resolution.
      const reply = await call<TicketMessage>(
        'POST',
        `${brandPath()}/tickets/${filed.ticketId}/messages`,
        { kind: 'public', bodyHtml: '<p>Try again now, please.</p>' },
      );
      expect(reply.status).toBe(201);
      const answered = await clocksOf(filed.ticketId);
      expect(answered.find((clock) => clock.kind === 'first_response')?.satisfiedAt).not.toBeNull();
      expect(answered.find((clock) => clock.kind === 'resolution')?.pausedAt).not.toBeNull();

      // 3. The customer mails back on the thread: a customer message, so it resumes.
      await sendQueued(filed.ticketId);
      const [sent] = await mailpitMessages();
      await receive({
        from: { address: 'sami@example.com' },
        subject: 'Re: Cannot log in',
        text: 'Still nothing.',
        messageId: '<sla-2@example.com>',
        inReplyTo: `<${sent?.MessageID ?? ''}>`,
      });
      expect((await messageOf('sla-2@example.com')).ticketId).toBe(filed.ticketId);
      const resumed = await clocksOf(filed.ticketId);
      expect(resumed.find((clock) => clock.kind === 'resolution')?.pausedAt).toBeNull();
    });
  });
});
