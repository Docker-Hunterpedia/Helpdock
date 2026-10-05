import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  attachments,
  auditLog,
  blockedSenders,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  telegramBots,
  telegramChats,
  telegramDeliveries,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { silentLogger, type TelegramSendPayload } from '@helpdock/jobs';
import type {
  TelegramBot,
  TelegramBotList,
  TelegramBotStatus,
  TelegramDeliveryList,
  TelegramTestResult,
  TelegramTicketContextResponse,
  TelegramWebhookResult,
  Ticket,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { readChannelStatuses } from '../channels/channel-status.js';
import { createLogger } from '../logging/logger.js';
import { objectKeyBeside } from '../media/keys.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { noCsatNotices } from '../testing/csat-doubles.js';
import { FakeTelegram, textUpdate } from '../testing/fake-telegram.js';
import { FakeStorage } from '../testing/media.js';
import { telegramApiFactory } from './bot-api-factory.js';
import { createTelegramInboundService } from './factory.js';
import { TelegramRepository } from './telegram.repository.js';
import {
  createTelegramNoticeEventHandler,
  createTelegramReplyEventHandler,
  TELEGRAM_EVENTS,
} from './telegram-events.js';
import { createTelegramPollProcessor } from './telegram-poll.job.js';
import { createTelegramSendHandler, createTelegramSendProcessor } from './telegram-send.job.js';

/**
 * M6 against real Postgres and Redis, with a local HTTP server standing in for
 * api.telegram.org.
 *
 * 1. **Channels › Telegram (M6-05)**: a bot is checked with `getMe`, stored
 *    with its token encrypted and never returned, audited; "Set webhook"
 *    registers the route with its secret; an Agent cannot touch any of it.
 * 2. **The webhook (M6-01)**: a wrong secret and an unknown bot are the same
 *    401.
 * 3. **The M6 exit criterion**: a message delivered through the webhook opens
 *    a ticket, the agent's reply goes through the outbox, and the stand-in
 *    receives `sendMessage` to that chat — once, however often the job runs.
 * 4. **One open ticket per chat (M6-02)**, the reopen policy, media and
 *    locations (M6-03), `/start` and the language pick (M6-04), failed
 *    deliveries and Retry, development polling, and the System page.
 *
 * The worker is played by hand, one outbox row at a time, as the email suites
 * do: the relay and BullMQ are covered elsewhere.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const TOKEN = '7000001:AAEacmeSupportBotTokenAbcdefghijklmn';
const OTHER_TOKEN = '7000002:AAEotherBotTokenAbcdefghijklmnopqrst';
const CHAT = 4_242_001;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M6 Telegram integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

const JPEG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 200 } },
})
  .jpeg()
  .toBuffer();

describe.skipIf(!hasDocker)('the Telegram channel', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  const telegram = new FakeTelegram();
  let storage: FakeStorage;

  let support: string;
  let ada: Person;
  let sam: Person;
  let bot: TelegramBot;
  let webhookSecret = '';
  let updateId = 1_000;
  const handled = new Set<string>();

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
      TELEGRAM_POLLING: false,
      TELEGRAM_API_ROOT: telegram.url,
    }) as Env;

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    who: Person | null,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url,
        headers: {
          ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const botsPath = () => `/api/brands/${seeded.brandId}/telegram/bots`;

  const deliver = (update: unknown, secret = webhookSecret, botId = bot.id) =>
    call<{ ok?: boolean }>('POST', `/api/telegram/${botId}/webhook`, null, update, {
      'x-telegram-bot-api-secret-token': secret,
    });

  const nextUpdate = (): number => {
    updateId += 1;
    return updateId;
  };

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

  const addPerson = async (db: Db, who: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${who}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name: who,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
    });
    return { id, email, token: '' };
  };

  const repository = new TelegramRepository();

  /** The worker's half: every outbox row M6 wrote and nobody handled yet, sent. */
  const runOutbox = async (attempts = 0): Promise<void> => {
    const rows = await owner.db
      .select({ id: outbox.id, event: outbox.event, payload: outbox.payload })
      .from(outbox)
      .where(inArray(outbox.event, [TELEGRAM_EVENTS.reply, TELEGRAM_EVENTS.notice]))
      .orderBy(outbox.id);
    const process = createTelegramSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository,
      handler: createTelegramSendHandler({
        db: runtime.db,
        repository,
        keyring: createKeyring(envFor()),
        api: telegramApiFactory(telegram.url),
        storage,

        csat: noCsatNotices,
      }),
    });
    for (const row of rows.filter((candidate) => !handled.has(candidate.id))) {
      handled.add(row.id);
      const added: { jobId: string; payload: TelegramSendPayload }[] = [];
      const queue = { add: async (input: (typeof added)[number]) => void added.push(input) };
      const handler =
        row.event === TELEGRAM_EVENTS.reply
          ? createTelegramReplyEventHandler(queue)
          : createTelegramNoticeEventHandler(queue);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        handler({
          outboxId: row.id,
          brandId: seeded.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
      for (const job of added) {
        await process({
          name: 'telegram.send',
          id: job.jobId,
          data: job.payload,
          attemptsMade: attempts,
          opts: { attempts: 5 },
        } as Job).catch(() => undefined);
      }
    }
  };

  const ticketForChat = async (chatId: number) =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const rows = await tx
        .select({ ticket: tickets })
        .from(tickets)
        .innerJoin(contactIdentities, eq(contactIdentities.contactId, tickets.contactId))
        .where(
          and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.value, String(chatId))),
        )
        .orderBy(sql`${tickets.createdAt} desc`);
      return rows.map((row) => row.ticket);
    });

  const messagesOf = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, ticketId))
        .orderBy(ticketMessages.seq),
    );

  const sentTo = (chatId: number) =>
    telegram.callsOf('sendMessage').filter((entry) => entry.body.chat_id === String(chatId));

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      telegram.start(),
    ]);
    telegram.bots.set(TOKEN, { id: 7_000_001, username: 'acme_support_bot' });
    telegram.bots.set(OTHER_TOKEN, { id: 7_000_002, username: 'acme_other_bot' });

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    // The container's superuser, which row-level security does not bind: the
    // suite reads the outbox and the audit log across the brand with it.
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-telegram-')));
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      telegram: { api: telegramApiFactory(telegram.url) },
    });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [created] = await tx
        .insert(departments)
        .values({ brandId: seeded.brandId, name: 'Support' })
        .returning({ id: departments.id });
      support = created?.id ?? '';
      await tx.insert(userBrandRoles).values({
        userId: sam.id,
        brandId: seeded.brandId,
        role: 'agent',
        departmentIds: [support],
      });
    });
    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await telegram.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------------ admin

  describe('Channels › Telegram (M6-05)', () => {
    it('checks the token with getMe, stores it encrypted and never returns it', async () => {
      const created = await call<TelegramBot>('POST', botsPath(), ada, {
        displayName: 'Acme Support',
        departmentId: support,
        token: TOKEN,
        welcomeEn: 'Welcome to Acme support.',
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        username: 'acme_support_bot',
        departmentName: 'Support',
        tokenSet: true,
        tokenHint: TOKEN.slice(-4),
        welcome: { en: 'Welcome to Acme support.', ar: null },
        languagePick: true,
        mode: 'webhook',
        health: { state: 'waiting' },
        webhook: {
          url: null,
          expectedUrl: `https://support.example.com/api/telegram/${created.body.id}/webhook`,
        },
      });
      expect(JSON.stringify(created.body)).not.toContain(TOKEN.split(':')[1]);
      bot = created.body;

      const [stored] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(telegramBots).where(eq(telegramBots.id, bot.id)),
      );
      expect(stored?.token).toMatch(/^v1\./);
      expect(stored?.webhookSecret).toMatch(/^v1\./);

      const audit = await owner.db
        .select({ action: auditLog.action, meta: auditLog.meta })
        .from(auditLog)
        .where(eq(auditLog.targetId, bot.id));
      expect(audit).toEqual([
        { action: 'telegram_bot.created', meta: { username: 'acme_support_bot' } },
      ]);
      expect(JSON.stringify(audit)).not.toContain(TOKEN);
    });

    it('refuses a token Telegram does not know, a bot already connected, and a token of another bot', async () => {
      const invalid = await call('POST', botsPath(), ada, {
        displayName: 'Nope',
        departmentId: support,
        token: '7000009:AAEunknownTokenAbcdefghijklmnopqrstu',
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ error: { telegram: { reason: 'token-invalid' } } });

      const taken = await call('POST', botsPath(), ada, {
        displayName: 'Again',
        departmentId: support,
        token: TOKEN,
      });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ error: { telegram: { reason: 'bot-taken' } } });

      const other = await call('PUT', `${botsPath()}/${bot.id}`, ada, {
        displayName: 'Acme Support',
        departmentId: support,
        token: OTHER_TOKEN,
      });
      expect(other.status).toBe(400);
      expect(other.body).toMatchObject({ error: { telegram: { reason: 'token-other-bot' } } });
    });

    it('keeps an Agent out of every bot route', async () => {
      expect((await call('GET', botsPath(), sam)).status).toBe(403);
      expect((await call('POST', `${botsPath()}/${bot.id}/webhook`, sam)).status).toBe(403);
    });

    it('lists, saves, tests the connection and reads the health', async () => {
      const list = await call<TelegramBotList>('GET', botsPath(), ada);
      expect(list.body.bots.map((entry) => entry.id)).toEqual([bot.id]);

      const saved = await call<TelegramBot>('PUT', `${botsPath()}/${bot.id}`, ada, {
        displayName: 'Acme Help',
        departmentId: support,
        welcomeEn: 'Welcome to Acme support.',
        welcomeAr: '',
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ displayName: 'Acme Help', welcome: { ar: null } });

      const test = await call<TelegramTestResult>('POST', `${botsPath()}/${bot.id}/test`, ada);
      expect(test.body).toEqual({
        ok: true,
        username: 'acme_support_bot',
        name: 'acme_support_bot',
        telegramId: 7_000_001,
      });
    });

    it('tests a typed token before the bot exists, and refuses one Telegram does not know', async () => {
      const known = await call<TelegramTestResult>('POST', `${botsPath()}/test`, ada, {
        token: OTHER_TOKEN,
      });
      expect(known.status).toBe(200);
      expect(known.body).toMatchObject({ ok: true, username: 'acme_other_bot' });

      const unknown = await call<TelegramTestResult>('POST', `${botsPath()}/test`, ada, {
        token: '7000009:AAEunknownTokenAbcdefghijklmnopqrstu',
      });
      expect(unknown.body).toEqual({ ok: false, kind: 'token', detail: '401: Unauthorized' });
      expect(JSON.stringify(unknown.body)).not.toContain('AAEunknown');

      expect((await call('POST', `${botsPath()}/test`, sam, { token: OTHER_TOKEN })).status).toBe(
        403,
      );
      const list = await call<TelegramBotList>('GET', botsPath(), ada);
      expect(list.body.bots).toHaveLength(1);
    });

    it('sets the webhook with the bot’s secret and reads it back in the health panel', async () => {
      const set = await call<TelegramWebhookResult>('POST', `${botsPath()}/${bot.id}/webhook`, ada);

      expect(set.body).toMatchObject({ ok: true, url: bot.webhook.expectedUrl });
      const registered = telegram.callsOf('setWebhook').at(-1)?.body;
      expect(registered).toMatchObject({
        url: bot.webhook.expectedUrl,
        allowed_updates: ['message', 'callback_query'],
      });
      webhookSecret = String(registered?.secret_token);
      expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);

      const status = await call<TelegramBotStatus>('GET', `${botsPath()}/${bot.id}/status`, ada);
      expect(status.body).toMatchObject({
        mode: 'webhook',
        webhook: { url: bot.webhook.expectedUrl, pendingUpdateCount: 0 },
        webhookError: null,
        activity: { lastReplyAt: null, failedSends24h: 0, openTickets: 0 },
      });
    });
  });

  // ---------------------------------------------------------------- webhook

  describe('the webhook (M6-01)', () => {
    it('answers a wrong secret, no secret and an unknown bot with the same 401', async () => {
      const update = textUpdate(nextUpdate(), CHAT, 'hello');
      expect((await deliver(update, 'wrong-secret')).status).toBe(401);
      expect((await deliver(update, '')).status).toBe(401);
      expect((await deliver(update, webhookSecret, uuidv7())).status).toBe(401);
      expect(await ticketForChat(CHAT)).toEqual([]);
    });

    it('refuses a body that is not an update', async () => {
      expect((await deliver({ hello: 'world' })).status).toBe(400);
    });

    it('answers 410 for a brand being deleted, but only after the secret (M8-07)', async () => {
      const setStatus = (status: 'active' | 'deleting') =>
        owner.db
          .update(brands)
          .set({ status, deletedAt: status === 'active' ? null : new Date() })
          .where(eq(brands.id, seeded.brandId));
      const update = textUpdate(nextUpdate(), CHAT, 'still there?');

      await setStatus('deleting');
      try {
        expect((await deliver(update, 'wrong-secret')).status).toBe(401);
        expect((await deliver(update)).status).toBe(410);
      } finally {
        await setStatus('active');
      }
      expect(await ticketForChat(CHAT)).toEqual([]);
    });
  });

  // -------------------------------------------------------- exit criterion

  describe('a conversation (M6-02)', () => {
    it('files a message as a ticket and delivers the agent’s reply to the chat (M6 exit criterion)', async () => {
      const received = await deliver(
        textUpdate(nextUpdate(), CHAT, 'My order #77 has not arrived'),
      );
      expect(received.status).toBe(200);

      const [ticket] = await ticketForChat(CHAT);
      expect(ticket).toMatchObject({
        channel: 'telegram',
        departmentId: support,
        subject: 'My order #77 has not arrived',
      });
      const [contact] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(contacts)
          .where(eq(contacts.id, ticket?.contactId ?? '')),
      );
      expect(contact?.name).toBe('Mona Khalil');

      const reply = await call(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/messages`,
        ada,
        {
          kind: 'public',
          bodyHtml: '<p>Sorry about that, Mona.</p><p>It ships today.</p>',
        },
      );
      expect(reply.status).toBe(201);
      expect(sentTo(CHAT)).toEqual([]);

      await runOutbox();

      expect(sentTo(CHAT).map((entry) => entry.body)).toEqual([
        { chat_id: String(CHAT), text: 'Sorry about that, Mona.\nIt ships today.' },
      ]);
      const deliveries = await call<TelegramDeliveryList>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/telegram/deliveries`,
        sam,
      );
      expect(deliveries.body.items).toMatchObject([{ status: 'sent', attempts: 0 }]);

      // The same job again, as after a crash between the send and the ack.
      handled.clear();
      await runOutbox();
      expect(sentTo(CHAT)).toHaveLength(1);
    });

    it('tells the ticket view who the chat is with, through which bot', async () => {
      const chat = 4_242_010;
      await deliver(
        textUpdate(nextUpdate(), chat, 'Where is my refund?', {
          from: { id: chat, is_bot: false, first_name: 'Mona', username: 'mona_k' },
        }),
      );
      const [ticket] = await ticketForChat(chat);

      const read = await call<TelegramTicketContextResponse>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/telegram`,
        sam,
      );
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        context: {
          bot: { id: bot.id, username: 'acme_support_bot' },
          chatId: String(chat),
          username: 'mona_k',
          name: 'Mona',
          locale: null,
          languageChosenAt: null,
        },
        deliveries: [],
      });

      const status = await call<TelegramBotStatus>('GET', `${botsPath()}/${bot.id}/status`, ada);
      expect(status.body.activity.openTickets).toBeGreaterThanOrEqual(2);
      expect(status.body.activity.lastReplyAt).not.toBeNull();
    });

    it('sends a reply’s attachments after its text, each once, and waits for one still processing', async () => {
      const chat = 4_242_011;
      await deliver(textUpdate(nextUpdate(), chat, 'Can you send the invoice?'));
      const [ticket] = await ticketForChat(chat);
      const attach = async (input: {
        name: string;
        kind: 'image' | 'file';
        mime: string;
        variant: 'webp' | 'original';
        bytes: Buffer;
        status: 'ready' | 'processing';
      }): Promise<string> => {
        const id = uuidv7();
        const s3Key = `brands/${seeded.brandId}/tickets/${ticket?.id}/${id}/original`;
        await storage.put(objectKeyBeside(s3Key, input.variant), input.bytes);
        await owner.db.insert(attachments).values({
          id,
          brandId: seeded.brandId,
          departmentId: ticket?.departmentId ?? '',
          ticketId: ticket?.id ?? '',
          uploaderType: 'staff',
          uploaderId: ada.id,
          s3Key,
          originalName: input.name,
          mime: input.mime,
          size: input.bytes.length,
          kind: input.kind,
          status: input.status,
          variants:
            input.status === 'ready'
              ? { [input.variant]: { mime: input.mime, size: input.bytes.length } }
              : {},
        });
        return id;
      };
      const photo = await attach({
        name: 'label.jpg',
        kind: 'image',
        mime: 'image/webp',
        variant: 'webp',
        bytes: Buffer.from('RIFF webp bytes'),
        status: 'ready',
      });
      const invoice = await attach({
        name: 'invoice.pdf',
        kind: 'file',
        mime: 'application/pdf',
        variant: 'original',
        bytes: Buffer.from('%PDF-1.7 invoice'),
        status: 'processing',
      });

      const reply = await call(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/messages`,
        ada,
        { kind: 'public', bodyHtml: '<p>Here you are.</p>', attachmentIds: [photo, invoice] },
      );
      expect(reply.status).toBe(201);
      await runOutbox();

      const toChat = (method: string) =>
        telegram.callsOf(method).filter((entry) => entry.body.chat_id === String(chat));
      expect(toChat('sendMessage').map((entry) => entry.body.text)).toEqual(['Here you are.']);
      expect(toChat('sendPhoto').map((entry) => entry.body.photo)).toEqual([
        { name: 'label-webp.webp', bytes: Buffer.from('RIFF webp bytes') },
      ]);
      expect(toChat('sendDocument')).toEqual([]);
      const [waiting] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(telegramDeliveries)
          .where(eq(telegramDeliveries.ticketId, ticket?.id ?? '')),
      );
      expect(waiting).toMatchObject({ status: 'queued', partsSent: 2, attempts: 1 });

      // The pipeline finishes, and BullMQ's next attempt sends only what is left.
      await owner.db
        .update(attachments)
        .set({
          status: 'ready',
          variants: { original: { mime: 'application/pdf', size: 16 } },
        })
        .where(eq(attachments.id, invoice));
      handled.clear();
      await runOutbox(1);
      handled.clear();
      await runOutbox(2);

      expect(toChat('sendMessage')).toHaveLength(1);
      expect(toChat('sendPhoto')).toHaveLength(1);
      expect(toChat('sendDocument').map((entry) => entry.body.document)).toEqual([
        { name: 'invoice.pdf', bytes: Buffer.from('%PDF-1.7 invoice') },
      ]);
      const [sent] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(telegramDeliveries)
          .where(eq(telegramDeliveries.ticketId, ticket?.id ?? '')),
      );
      expect(sent).toMatchObject({ status: 'sent', partsSent: 3 });
      expect(sent?.sentMessageIds).toHaveLength(3);
    });

    it('keeps one open ticket per chat, and ignores an update it has already filed', async () => {
      const update = textUpdate(nextUpdate(), CHAT, 'Any news?');
      await deliver(update);
      await deliver(update);

      const chatTickets = await ticketForChat(CHAT);
      expect(chatTickets).toHaveLength(1);
      const texts = (await messagesOf(chatTickets[0]?.id ?? '')).map((row) => row.bodyText);
      expect(texts.filter((text) => text === 'Any news?')).toHaveLength(1);
    });

    it('reopens a closed ticket the way the reopen policy says', async () => {
      const [ticket] = await ticketForChat(CHAT);
      const [closed] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ id: ticketStatuses.id })
          .from(ticketStatuses)
          .where(and(eq(ticketStatuses.systemState, 'closed'), eq(ticketStatuses.isSpam, false))),
      );
      const patched = await call<Ticket>(
        'PATCH',
        `/api/brands/${seeded.brandId}/tickets/${ticket?.id}`,
        ada,
        { statusId: closed?.id },
      );
      expect(patched.status).toBe(200);

      await deliver(textUpdate(nextUpdate(), CHAT, 'It still has not come'));

      const after = await ticketForChat(CHAT);
      expect(after).toHaveLength(1);
      expect(after[0]?.closedAt).toBeNull();
    });

    it('drops a blocked sender before anything is written, and counts it', async () => {
      const chat = 4_242_009;
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .insert(blockedSenders)
          .values({ brandId: seeded.brandId, kind: 'telegram', value: String(chat) }),
      );
      telegram.files.set('blocked-photo', JPEG);
      const downloadsBefore = telegram.callsOf('getFile').length;

      const received = await deliver(
        textUpdate(nextUpdate(), chat, '', {
          text: undefined,
          photo: [{ file_id: 'blocked-photo', file_unique_id: 'b', width: 8, height: 8 }],
        }),
      );

      expect(received.status).toBe(200);
      expect(await ticketForChat(chat)).toEqual([]);
      expect(telegram.callsOf('getFile')).toHaveLength(downloadsBefore);
      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ droppedCount: blockedSenders.droppedCount })
          .from(blockedSenders)
          .where(eq(blockedSenders.value, String(chat))),
      );
      expect(row?.droppedCount).toBe(1);
    });

    it('records a reply the chat refuses as failed, and Retry puts it back', async () => {
      const chat = 4_242_002;
      await deliver(textUpdate(nextUpdate(), chat, 'Hello?'));
      const [ticket] = await ticketForChat(chat);
      telegram.blockedChats.add(String(chat));

      await call('POST', `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/messages`, ada, {
        kind: 'public',
        bodyHtml: '<p>Hi there</p>',
      });
      await runOutbox();

      const deliveriesPath = `/api/brands/${seeded.brandId}/tickets/${ticket?.id}/telegram/deliveries`;
      const failed = await call<TelegramDeliveryList>('GET', deliveriesPath, ada);
      expect(failed.body.items).toMatchObject([
        { status: 'failed', lastError: '403: Forbidden: bot was blocked by the user' },
      ]);
      const [bad] = failed.body.items;

      telegram.blockedChats.delete(String(chat));
      const retried = await call('POST', `${deliveriesPath}/${bad?.id}/retry`, ada);
      expect(retried.status).toBe(204);
      await runOutbox();

      const after = await call<TelegramDeliveryList>('GET', deliveriesPath, ada);
      expect(after.body.items).toMatchObject([{ status: 'sent' }]);
      // One refused attempt, then the one Retry made.
      expect(sentTo(chat).map((entry) => entry.body.text)).toEqual(['Hi there', 'Hi there']);
    });
  });

  // ------------------------------------------------------------------ media

  describe('media and locations (M6-03)', () => {
    it('downloads a photo and a voice note through getFile into the media pipeline', async () => {
      const chat = 4_242_003;
      telegram.files.set('photo-large', JPEG);
      telegram.files.set('voice-1', Buffer.from('OggS fake voice note'));
      await deliver(
        textUpdate(nextUpdate(), chat, '', {
          text: undefined,
          caption: 'the box',
          photo: [{ file_id: 'photo-large', file_unique_id: 'p', width: 8, height: 8 }],
        }),
      );
      await deliver(
        textUpdate(nextUpdate(), chat, '', {
          text: undefined,
          voice: { file_id: 'voice-1', duration: 2, mime_type: 'audio/ogg' },
        }),
      );

      const [ticket] = await ticketForChat(chat);
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ kind: attachments.kind, mime: attachments.mime, status: attachments.status })
          .from(attachments)
          .where(eq(attachments.ticketId, ticket?.id ?? ''))
          .orderBy(attachments.createdAt),
      );
      expect(rows).toEqual([
        { kind: 'image', mime: 'image/jpeg', status: 'pending' },
        { kind: 'audio', mime: 'audio/ogg', status: 'pending' },
      ]);
      const uploaded = await owner.db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(eq(outbox.event, 'attachment.uploaded'));
      expect(uploaded.length).toBeGreaterThanOrEqual(2);
      expect(ticket?.subject).toBe('the box');
    });

    it('files a location as text with a map link', async () => {
      const chat = 4_242_004;
      await deliver(
        textUpdate(nextUpdate(), chat, '', {
          text: undefined,
          location: { latitude: 52.52, longitude: 13.405 },
        }),
      );

      const [ticket] = await ticketForChat(chat);
      const [message] = await messagesOf(ticket?.id ?? '');
      expect(message?.bodyText).toContain('Location: 52.52, 13.405');
      expect(message?.bodyHtml).toContain(
        'href="https://www.openstreetmap.org/?mlat=52.52&amp;mlon=13.405',
      );
    });
  });

  // ----------------------------------------------------- /start, language

  describe('/start and the language pick (M6-04)', () => {
    const chat = 4_242_005;

    it('welcomes with the bot’s own text and both languages, without opening a ticket', async () => {
      await deliver(textUpdate(nextUpdate(), chat, '/start'));
      await runOutbox();

      expect(await ticketForChat(chat)).toEqual([]);
      const [welcome] = sentTo(chat);
      expect(welcome?.body).toEqual({
        chat_id: String(chat),
        text: 'Welcome to Acme support.\n\nWhich language should we answer in?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'English', callback_data: 'lang:en' },
              { text: 'العربية', callback_data: 'lang:ar' },
            ],
          ],
        },
      });
    });

    it('sets the contact’s language from the button and confirms in it', async () => {
      await deliver({
        update_id: nextUpdate(),
        callback_query: {
          id: 'cq-ar',
          from: { id: chat, is_bot: false, first_name: 'Mona' },
          message: { message_id: 1, date: 0, chat: { id: chat, type: 'private' } },
          data: 'lang:ar',
        },
      });
      await runOutbox();

      const [identity] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ locale: contacts.locale })
          .from(contacts)
          .innerJoin(contactIdentities, eq(contactIdentities.contactId, contacts.id))
          .where(
            and(eq(contactIdentities.kind, 'telegram'), eq(contactIdentities.value, String(chat))),
          ),
      );
      expect(identity?.locale).toBe('ar');
      const [chatRow] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(telegramChats)
          .where(eq(telegramChats.chatId, String(chat))),
      );
      expect(chatRow?.languageChosenAt).toBeInstanceOf(Date);
      expect(telegram.callsOf('answerCallbackQuery').at(-1)?.body).toEqual({
        callback_query_id: 'cq-ar',
      });
      expect(sentTo(chat).at(-1)?.body.text).toBe(
        'شكرًا لك. سنرد عليك بالعربية. أرسل رسالتك متى شئت.',
      );
    });
  });

  // --------------------------------------------------------------- polling

  it('polls a bot in development and moves its offset past what it filed', async () => {
    const chat = 4_242_006;
    const update = textUpdate(nextUpdate(), chat, 'Polled hello');
    telegram.pending.set(TOKEN, [update]);
    const api = telegramApiFactory(telegram.url);
    const poll = createTelegramPollProcessor({
      db: runtime.db,
      log: silentLogger,
      keyring: createKeyring(envFor()),
      repository,
      api,
      inbound: createTelegramInboundService({
        db: runtime.db,
        storage: new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-telegram-poll-'))),
        log: silentLogger,
        keyring: createKeyring(envFor()),
        api,
      }),
    });

    await poll({ data: { brandId: seeded.brandId, botId: bot.id } });

    expect(await ticketForChat(chat)).toHaveLength(1);
    const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(telegramBots).where(eq(telegramBots.id, bot.id)),
    );
    expect(row?.pollOffset).toBe(update.update_id + 1);
  });

  it('shows the bot on the System page’s Channels card', async () => {
    const statuses = await readChannelStatuses(runtime.db, new Date());
    expect(statuses).toContainEqual(
      expect.objectContaining({
        id: bot.id,
        name: '@acme_support_bot',
        kind: 'telegram',
        status: 'ok',
        detail: 'healthy',
      }),
    );
  });

  it('removes a bot, its webhook and its chats, and keeps the tickets', async () => {
    const removed = await call('DELETE', `${botsPath()}/${bot.id}`, ada);
    expect(removed.status).toBe(204);
    expect(telegram.callsOf('deleteWebhook').at(-1)).toMatchObject({ token: TOKEN });
    expect(await ticketForChat(CHAT)).toHaveLength(1);
    const deliveries = await owner.db.select().from(telegramDeliveries);
    expect(deliveries).toEqual([]);
  });
});
