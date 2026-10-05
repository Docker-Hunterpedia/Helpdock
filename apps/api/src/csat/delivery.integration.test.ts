import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createKeyring, type Env } from '@helpdock/config';
import {
  contactIdentities,
  contacts,
  createDb,
  csatResponses,
  type DbHandle,
  departments,
  emailDeliveries,
  emailOutboundSettings,
  outbox,
  tickets,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  type EmailSendPayload,
  outboxEvents,
  type RulesEvaluatePayload,
  silentLogger,
  type TelegramSendPayload,
} from '@helpdock/jobs';
import {
  type CsatSurveyView,
  SOCKET_IO_PATH,
  type TelegramBot,
  type TicketDetail,
  type TicketStatusList,
  WIDGET_EVENTS,
  WIDGET_NAMESPACE,
  type WidgetCsat,
  type WidgetCsatResponse,
  type WidgetEnvelope,
  type WidgetJoinAck,
  type WidgetSendResponse,
  type WidgetSession,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { AutoReplyService } from '../email/auto-reply.service.js';
import { EmailRepository } from '../email/email.repository.js';
import { registerEmailEventHandlers } from '../email/email-events.js';
import { createEmailSendHandler, createEmailSendProcessor } from '../email/email-send.job.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import type { InstallSmtp } from '../email/transport.js';
import { smtpTransportFactory } from '../email/transport.js';
import { createLogger } from '../logging/logger.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { registerRulesEventHandlers } from '../rules/rules-jobs.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { telegramApiFactory } from '../telegram/bot-api-factory.js';
import { TelegramRepository } from '../telegram/telegram.repository.js';
import { registerTelegramEventHandlers } from '../telegram/telegram-events.js';
import {
  createTelegramSendHandler,
  createTelegramSendProcessor,
} from '../telegram/telegram-send.job.js';
import { FakeTelegram, textUpdate } from '../testing/fake-telegram.js';
import { FakeStorage } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';
import { registerWidgetEventHandlers } from '../widget/widget-events.js';
import { RedisWidgetBroadcast } from '../widget/widget-relay.js';
import { CsatRepository } from './csat.repository.js';
import { CsatDelivery } from './csat-delivery.js';
import { CsatEmailSource } from './csat-email.js';
import { CSAT_EVENTS, registerCsatEventHandlers } from './csat-events.js';
import { CsatTelegramNotices } from './telegram-csat.js';
import { CsatTokens } from './tokens.js';

/**
 * M8-06 against real Postgres, Redis and Mailpit, a local stand-in for
 * api.telegram.org and a real widget socket.
 *
 * A close becomes one survey, and the survey goes out on the ticket's channel
 * through the outbox:
 *
 * 1. **Email**: a message with five links that only open the page with the
 *    score pressed — following one records nothing.
 * 2. **Widget**: a `csat` frame on the conversation's socket, the card over
 *    REST, a rating, and Skip.
 * 3. **Telegram**: the question with five buttons; a tap records the score in
 *    one go, is thanked, leaves the link open for a comment, and a second tap
 *    is told the survey has closed.
 *
 * Every recorded answer writes `csat.received`, which workflow rules turn into
 * a `rules.evaluate` job with the `csat_received` trigger (the M3 gap).
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const APP_URL = 'https://support.example.com';
const SHOP = 'https://shop.example.com';
const TOKEN = '7000009:AAEcsatSurveyBotTokenAbcdefghijklmnop';
const NO_INSTALL_SMTP: InstallSmtp = { read: async () => undefined };

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the CSAT delivery integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: { Address: string }[];
}

describe.skipIf(!hasDocker)('CSAT delivery on close (M8-06)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let mailpitApi: string;
  let runtime: Runtime;
  let app: ApiApp;
  let url: string;
  let owner: DbHandle;
  let worker: Redis;
  let seeded: SeededInstall;
  let token = '';
  let department: string;
  let closedStatus: string;
  let openStatus: string;
  let webhookSecret = '';
  let botId = '';
  let storage: FakeStorage;
  let updateId = 5_000;
  const telegram = new FakeTelegram();
  const sockets: Socket[] = [];

  const emailJobs: { jobId: string; payload: EmailSendPayload }[] = [];
  const telegramJobs: { jobId: string; payload: TelegramSendPayload }[] = [];
  const rulesJobs: RulesEvaluatePayload[] = [];

  const envFor = (): Env =>
    ({
      APP_URL,
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
      TELEGRAM_POLLING: false,
      TELEGRAM_API_ROOT: telegram.url,
    }) as Env;

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    options: {
      readonly payload?: unknown;
      readonly staff?: boolean;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          ...(options.staff === false ? {} : { authorization: `Bearer ${token}` }),
          ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = () => `/api/brands/${seeded.brandId}`;

  const setStatus = async (ticketId: string, statusId: string): Promise<void> => {
    const response = await call('PATCH', `${brandPath()}/tickets/${ticketId}`, {
      payload: { statusId },
    });
    expect(response.status).toBe(200);
  };

  /** The worker's `outbox.event` consumer, for every row a registered module handles. */
  const drainOutbox = async (): Promise<string[]> => {
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(sql`${outbox.publishedAt} is null`)
      .orderBy(outbox.id);
    for (const row of rows) {
      await withSystem(runtime.db, row.brandId, async (tx) => {
        if (outboxEvents.events.includes(row.event)) {
          await outboxEvents.dispatch({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          });
        }
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
      });
    }
    return rows.map((row) => row.event);
  };

  const keyring = () => createKeyring(envFor());
  const csatRepository = new CsatRepository();
  const csatTokens = () => new CsatTokens(keyring());

  /** The `outbound` queue's consumer, for the jobs the outbox handlers added. */
  const runOutbound = async (): Promise<void> => {
    const emailRepository = new EmailRepository();
    const email = createEmailSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository: emailRepository,
      handler: createEmailSendHandler({
        repository: emailRepository,
        keyring: keyring(),
        installSmtp: NO_INSTALL_SMTP,
        transports: smtpTransportFactory,
        surveys: new CsatEmailSource(csatRepository, csatTokens(), APP_URL),
      }),
    });
    const telegramRepository = new TelegramRepository();
    const telegramSend = createTelegramSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository: telegramRepository,
      handler: createTelegramSendHandler({
        db: runtime.db,
        repository: telegramRepository,
        keyring: keyring(),
        api: telegramApiFactory(telegram.url),
        storage,
        csat: new CsatTelegramNotices({
          repository: csatRepository,
          tokens: csatTokens(),
          appUrl: APP_URL,
        }),
      }),
    });
    const job = (name: string, id: string, data: unknown) =>
      ({ name, id, data, attemptsMade: 0, opts: { attempts: 5 } }) as Job;

    for (const { jobId, payload } of emailJobs.splice(0)) {
      await email(job('email.send', jobId, payload));
    }
    for (const { jobId, payload } of telegramJobs.splice(0)) {
      await telegramSend(job('telegram.send', jobId, payload));
    }
  };

  const settle = async (): Promise<void> => {
    // A survey's own events (a notice after a tap, `csat.received`) are
    // written by what the first pass ran, so the worker goes round again.
    await drainOutbox();
    await runOutbound();
    await drainOutbox();
    await runOutbound();
  };

  const surveysOf = (ticketId: string) =>
    owner.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, ticketId))
      .orderBy(csatResponses.closedAt);

  const receivedFor = (ticketId: string) =>
    owner.db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.event, CSAT_EVENTS.received),
          sql`${outbox.payload} ->> 'ticketId' = ${ticketId}`,
        ),
      )
      .orderBy(outbox.id);

  const tokenOf = (link: string): string => new URL(link).pathname.replace('/csat/', '');

  beforeAll(async () => {
    [postgres, redisContainer, mailpit] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_HTTP_PORT)
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
      telegram.start(),
    ]);
    mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(MAILPIT_HTTP_PORT))}`;
    telegram.bots.set(TOKEN, { id: 7_000_009, username: 'acme_survey_bot' });

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });

    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-csat-')));
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      telegram: { api: telegramApiFactory(telegram.url) },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = await app.getUrl();

    // The worker's handlers, registered in this process as its start-up does.
    worker = new Redis(redisContainer.getConnectionUrl());
    const widgetBroadcast = new RedisWidgetBroadcast(worker);
    const outbound = new OutboundEmailService(new EmailRepository(), NO_INSTALL_SMTP);
    registerTicketEventHandlers(new RedisRealtimeBroadcast(worker));
    registerWidgetEventHandlers(widgetBroadcast);
    registerCsatEventHandlers({
      repository: csatRepository,
      tokens: csatTokens(),
      delivery: new CsatDelivery({
        repository: csatRepository,
        email: outbound,
        telegram: new TelegramRepository(),
        locales: new TicketLifecycleRepository(),
        widget: widgetBroadcast,
      }),
    });
    registerEmailEventHandlers({
      queue: { add: async (input) => void emailJobs.push(input) },
      autoReplies: new AutoReplyService(new EmailRepository(), outbound),
    });
    registerTelegramEventHandlers({
      queue: { add: async (input) => void telegramJobs.push(input) },
      botChanged: async () => undefined,
    });
    registerRulesEventHandlers({ add: async (payload) => void rulesJobs.push(payload) });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    token = await signInForTest(app, { email: seeded.email, password: seeded.password });

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [first] = await tx.select({ id: departments.id }).from(departments).limit(1);
      department = first?.id ?? '';
      await tx.insert(emailOutboundSettings).values({
        brandId: seeded.brandId,
        defaultFromName: 'Helpdock Support',
        defaultFromAddress: 'support@helpdock.test',
        smtpHost: mailpit.getHost(),
        smtpPort: mailpit.getMappedPort(MAILPIT_SMTP_PORT),
        smtpTls: 'none',
        smtpUser: '',
      });
    });

    const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`);
    const named = (name: string) =>
      statuses.body.statuses.find((status) => status.name === name)?.id ?? '';
    closedStatus = named('Closed');
    openStatus = named('Open');

    const access = await call('PUT', `${brandPath()}/widget/access`, {
      payload: {
        allowedOrigins: [SHOP],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      },
    });
    expect(access.status).toBe(200);

    const bot = await call<TelegramBot>('POST', `${brandPath()}/telegram/bots`, {
      payload: { displayName: 'Acme Survey', departmentId: department, token: TOKEN },
    });
    expect(bot.status).toBe(201);
    botId = bot.body.id;
    await call('POST', `${brandPath()}/telegram/bots/${botId}/webhook`);
    webhookSecret = String(telegram.callsOf('setWebhook').at(-1)?.body.secret_token);
  }, 300_000);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await worker?.quit();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await telegram.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  // ------------------------------------------------------------------ email

  describe('by email', () => {
    const createEmailTicket = async (address: string): Promise<string> => {
      const contactId = uuidv7();
      await withSystem(runtime.db, seeded.brandId, async (tx) => {
        await tx
          .insert(contacts)
          .values({ id: contactId, brandId: seeded.brandId, name: 'Mona Khalil' });
        await tx.insert(contactIdentities).values({
          brandId: seeded.brandId,
          contactId,
          kind: 'email',
          value: address,
          verified: true,
          source: 'email.inbound',
        });
      });
      const created = await call<TicketDetail>('POST', `${brandPath()}/tickets`, {
        payload: {
          subject: 'Refund for order 8841',
          bodyHtml: '<p>My refund has not arrived.</p>',
          departmentId: department,
          contactId,
          channel: 'email',
        },
      });
      expect(created.status).toBe(201);
      return created.body.ticket.id;
    };

    const mailTo = async (address: string): Promise<MailpitSummary[]> => {
      const response = await fetch(`${mailpitApi}/api/v1/messages`);
      const { messages } = (await response.json()) as { messages: MailpitSummary[] };
      return messages.filter((message) => message.To.some((to) => to.Address === address));
    };

    it('sends five links that open the page with the score pressed, and records nothing until Send', async () => {
      const ticketId = await createEmailTicket('mona@example.com');
      await setStatus(ticketId, closedStatus);
      await settle();

      const [survey] = await surveysOf(ticketId);
      expect(survey?.sentAt).not.toBeNull();
      const [delivery] = await owner.db
        .select()
        .from(emailDeliveries)
        .where(and(eq(emailDeliveries.ticketId, ticketId), eq(emailDeliveries.kind, 'csat')));
      expect(delivery).toMatchObject({ status: 'sent', csatResponseId: survey?.id });

      const [mail] = await mailTo('mona@example.com');
      expect(mail?.Subject).toMatch(/^\[[A-Z]+-\d+\] How did we do\?$/);
      const detail = (await (
        await fetch(`${mailpitApi}/api/v1/message/${mail?.ID ?? ''}`)
      ).json()) as { HTML: string; Text: string };
      const links = [...detail.Text.matchAll(/https:\/\/\S+\?rating=(\d)&lang=en/g)];
      expect(links.map((link) => link[1])).toEqual(['1', '2', '3', '4', '5']);
      const headers = (await (
        await fetch(`${mailpitApi}/api/v1/message/${mail?.ID ?? ''}/headers`)
      ).json()) as Record<string, string[]>;
      expect(headers['Auto-Submitted']).toEqual(['auto-generated']);

      // A mail scanner follows every link: each only opens the page.
      const surveyToken = tokenOf(links[0]?.[0] ?? '');
      for (const _link of links) {
        const opened = await call<CsatSurveyView>('GET', `/api/public/csat/${surveyToken}`, {
          staff: false,
        });
        expect(opened.body.state).toBe('open');
      }
      expect((await surveysOf(ticketId))[0]?.ratedAt).toBeNull();
      expect(await receivedFor(ticketId)).toEqual([]);

      const rated = await call<CsatSurveyView>('POST', `/api/public/csat/${surveyToken}`, {
        staff: false,
        payload: { rating: 5, comment: 'Quick and kind.' },
      });
      expect(rated.body).toMatchObject({ state: 'rated', rating: 5 });
      expect((await surveysOf(ticketId))[0]).toMatchObject({ rating: 5, ratedVia: 'link' });
      expect(await receivedFor(ticketId)).toEqual([
        { payload: expect.objectContaining({ rating: 5, via: 'link' }) },
      ]);

      await drainOutbox();
      expect(rulesJobs.filter((job) => job.ticketId === ticketId).at(-1)).toMatchObject({
        triggers: ['csat_received'],
      });
    });

    it('sends a second survey after a reopen and a second close, and one per close however often the job runs', async () => {
      const ticketId = await createEmailTicket('karim@example.com');
      await setStatus(ticketId, closedStatus);
      await settle();
      await setStatus(ticketId, openStatus);
      await setStatus(ticketId, closedStatus);
      await settle();

      const surveys = await surveysOf(ticketId);
      expect(surveys).toHaveLength(2);
      expect(await mailTo('karim@example.com')).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------------- widget

  describe('in the widget', () => {
    const visitorCall = <T>(
      method: 'GET' | 'POST',
      path: string,
      secret: string | null,
      payload?: unknown,
    ) =>
      call<T>(method, `/api/widget/${seeded.brandId}${path}`, {
        staff: false,
        ...(payload === undefined ? {} : { payload }),
        headers: {
          origin: SHOP,
          ...(secret === null ? {} : { authorization: `Visitor ${secret}` }),
        },
      });

    const visitorConversation = async () => {
      const session = await visitorCall<WidgetSession>('POST', '/session', null, {});
      const secret = session.body.visitorSecret ?? '';
      const started = await visitorCall<WidgetSendResponse>('POST', '/conversations', secret, {
        clientId: uuidv7(),
        text: 'Where is my refund?',
      });
      expect(started.status).toBe(201);
      return { secret, conversationId: started.body.conversation.id };
    };

    const connect = (secret: string): Promise<Socket> => {
      const socket = io(`${url}${WIDGET_NAMESPACE}`, {
        path: SOCKET_IO_PATH,
        transports: ['websocket'],
        auth: { brandId: seeded.brandId, visitorSecret: secret },
        extraHeaders: { origin: SHOP },
        reconnection: false,
      });
      sockets.push(socket);
      return new Promise((resolve, reject) => {
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });
    };

    it('offers the card on the conversation’s socket when the agent ends it, and takes one rating', async () => {
      const { secret, conversationId } = await visitorConversation();
      const socket = await connect(secret);
      const joined: WidgetJoinAck = await socket.emitWithAck(WIDGET_EVENTS.join, {
        conversationId,
      });
      expect(joined.ok).toBe(true);
      const frame = new Promise<WidgetEnvelope<WidgetCsat>>((resolve) => {
        socket.once(WIDGET_EVENTS.csat, resolve);
      });

      await setStatus(conversationId, closedStatus);
      await settle();

      expect((await frame).data).toEqual({
        conversationId,
        state: 'open',
        rating: null,
        comment: null,
        skippedAt: null,
      });
      expect((await surveysOf(conversationId))[0]?.sentAt).not.toBeNull();
      const card = await visitorCall<WidgetCsatResponse>(
        'GET',
        `/conversations/${conversationId}/csat`,
        secret,
      );
      expect(card.body.csat?.state).toBe('open');

      const rated = await visitorCall<WidgetCsatResponse>(
        'POST',
        `/conversations/${conversationId}/csat`,
        secret,
        { rating: 4, comment: 'Quick and clear.' },
      );
      expect(rated.body.csat).toMatchObject({
        state: 'rated',
        rating: 4,
        comment: 'Quick and clear.',
      });
      const again = await visitorCall<WidgetCsatResponse>(
        'POST',
        `/conversations/${conversationId}/csat`,
        secret,
        { rating: 1 },
      );
      expect(again.body.csat).toMatchObject({ state: 'rated', rating: 4 });
      expect(await receivedFor(conversationId)).toEqual([
        { payload: expect.objectContaining({ rating: 4, via: 'widget' }) },
      ]);
    });

    it('records nothing on Skip, and offers the card to nobody else', async () => {
      const { secret, conversationId } = await visitorConversation();
      const other = await visitorConversation();
      await setStatus(conversationId, closedStatus);
      await settle();

      const skipped = await visitorCall<WidgetCsatResponse>(
        'POST',
        `/conversations/${conversationId}/csat/skip`,
        secret,
      );
      expect(skipped.body.csat).toMatchObject({ state: 'skipped', rating: null });
      expect((await surveysOf(conversationId))[0]).toMatchObject({ ratedAt: null });
      expect(await receivedFor(conversationId)).toEqual([]);

      const stranger = await visitorCall(
        'GET',
        `/conversations/${conversationId}/csat`,
        other.secret,
      );
      expect(stranger.status).toBe(404);
    });
  });

  // --------------------------------------------------------------- Telegram

  describe('on Telegram', () => {
    const deliver = (update: unknown) =>
      call('POST', `/api/telegram/${botId}/webhook`, {
        staff: false,
        payload: update,
        headers: { 'x-telegram-bot-api-secret-token': webhookSecret },
      });
    const tap = (chat: number, data: string, messageId: number) => {
      updateId += 1;
      return deliver({
        update_id: updateId,
        callback_query: {
          id: `cq-${String(updateId)}`,
          from: { id: chat, is_bot: false, first_name: 'Mona' },
          message: { message_id: messageId, date: 0, chat: { id: chat, type: 'private' } },
          data,
        },
      });
    };
    const ticketOfChat = async (chat: number): Promise<string> => {
      const [row] = await owner.db
        .select({ id: tickets.id })
        .from(tickets)
        .innerJoin(contactIdentities, eq(contactIdentities.contactId, tickets.contactId))
        .where(
          and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.value, String(chat))),
        );
      return row?.id ?? '';
    };
    const sentTo = (chat: number) =>
      telegram.callsOf('sendMessage').filter((entry) => entry.body.chat_id === String(chat));

    it('asks with five buttons, takes a tap in one go, thanks, and leaves the link for a comment', async () => {
      const chat = 4_242_101;
      updateId += 1;
      expect((await deliver(textUpdate(updateId, chat, 'My refund is late'))).status).toBe(200);
      await settle();
      const ticketId = await ticketOfChat(chat);
      await setStatus(ticketId, closedStatus);
      await settle();

      const [survey] = await surveysOf(ticketId);
      const question = sentTo(chat).at(-1);
      expect(question?.body.text).toMatch(/is closed\. How was our help\? Tap a number/);
      const keyboard = question?.body.reply_markup as {
        inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
      };
      expect(keyboard.inline_keyboard[0]?.map((button) => button.callback_data)).toEqual(
        [1, 2, 3, 4, 5].map((rating) => `csat:${survey?.id ?? ''}:${String(rating)}`),
      );
      const commentUrl = keyboard.inline_keyboard[1]?.[0]?.url ?? '';
      expect(commentUrl).toMatch(/^https:\/\/support\.example\.com\/csat\/[\w.-]+\?lang=en$/);
      expect(survey?.sentAt).not.toBeNull();

      expect((await tap(chat, `csat:${survey?.id ?? ''}:4`, 501)).status).toBe(200);
      await settle();

      expect((await surveysOf(ticketId))[0]).toMatchObject({ rating: 4, ratedVia: 'telegram' });
      expect(sentTo(chat).at(-1)?.body.text).toMatch(/^Thanks! You rated this request 4 · Good\./);
      expect(telegram.callsOf('editMessageReplyMarkup').at(-1)?.body).toEqual({
        chat_id: String(chat),
        message_id: 501,
        reply_markup: { inline_keyboard: [[{ text: 'Add a comment', url: commentUrl }]] },
      });
      expect(rulesJobs.filter((job) => job.ticketId === ticketId).at(-1)).toMatchObject({
        triggers: ['csat_received'],
      });

      // The link is still open once, with the tap's score pressed, for the comment.
      const linkToken = tokenOf(commentUrl);
      const page = await call<CsatSurveyView>('GET', `/api/public/csat/${linkToken}`, {
        staff: false,
      });
      expect(page.body).toMatchObject({ state: 'open', rating: 4 });
      await call('POST', `/api/public/csat/${linkToken}`, {
        staff: false,
        payload: { rating: 4, comment: 'The trace helped.' },
      });
      expect((await surveysOf(ticketId))[0]).toMatchObject({
        rating: 4,
        comment: 'The trace helped.',
        ratedVia: 'link',
      });
      const spent = await call<CsatSurveyView>('GET', `/api/public/csat/${linkToken}`, {
        staff: false,
      });
      expect(spent.body.state).toBe('used');

      // A second tap records nothing and is told so.
      await tap(chat, `csat:${survey?.id ?? ''}:1`, 501);
      await settle();
      expect((await surveysOf(ticketId))[0]?.rating).toBe(4);
      expect(sentTo(chat).at(-1)?.body.text).toBe('This survey has closed.');
    });

    it('refuses a tap from a chat the survey is not for', async () => {
      const chat = 4_242_102;
      updateId += 1;
      await deliver(textUpdate(updateId, chat, 'Hello'));
      await settle();
      const ticketId = await ticketOfChat(chat);
      await setStatus(ticketId, closedStatus);
      await settle();
      const [survey] = await surveysOf(ticketId);

      await tap(4_242_999, `csat:${survey?.id ?? ''}:1`, 777);
      await settle();

      expect((await surveysOf(ticketId))[0]?.ratedAt).toBeNull();
      expect(sentTo(4_242_999).at(-1)?.body.text).toBe('This survey has closed.');
    });
  });
});
