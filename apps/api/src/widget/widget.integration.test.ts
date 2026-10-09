import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CaptchaTransport } from '@helpdock/channels';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  emailDeliveries,
  emailOutboundSettings,
  outbox,
  ticketMessages,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  widgetVisitors,
  withSystem,
} from '@helpdock/db';
import { outboxEvents, silentLogger } from '@helpdock/jobs';
import {
  canonicalIdentityJson,
  defaultWeeklyHours,
  SOCKET_IO_PATH,
  type TicketDetail,
  type WeeklyHours,
  WIDGET_EVENTS,
  WIDGET_NAMESPACE,
  type WidgetAvailability,
  type WidgetConfig,
  type WidgetConversation,
  type WidgetConversationList,
  type WidgetEnvelope,
  type WidgetJoinAck,
  type WidgetMessage,
  type WidgetMessagePage,
  type WidgetSendAck,
  type WidgetSendResponse,
  type WidgetSession,
  type WidgetSettings,
  type WidgetSigningSecret,
  type WidgetStartResponse,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { registerContactEventHandlers } from '../contacts/contact-events.js';
import { createLogger } from '../logging/logger.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { PresenceService } from '../realtime/presence.service.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { ignoreAuthEmailInThisSuite, signInForTest } from '../testing/staff-sign-in.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';
import { WidgetConversationsService } from './widget-conversations.service.js';
import { registerWidgetEventHandlers } from './widget-events.js';
import { WIDGET_VISITOR_WRITE_RULE } from './widget-gate.js';
import { RedisWidgetBroadcast } from './widget-relay.js';

/**
 * M4-02, M4-03 and M4-04 against real Postgres and Redis, over real HTTP, a
 * real `/widget` socket and a real SSE stream.
 *
 * The three exit criteria this suite proves at the server:
 *
 * 1. **A guessed or leaked email opens nothing** (M4-02): a visitor who types
 *    another person's address into the pre-chat form sees none of that
 *    person's conversations, by list, by id, by catch-up or by socket.
 * 2. **A non-allowed origin is refused** (M4-03): config, session and the
 *    socket handshake. This is the api-level E2E test for the criterion; the
 *    browser half belongs to the widget build (M4-01).
 * 3. **Exactly one message, and the client catches up** (M4-04): a double
 *    submit, a retry after the api restarts, and a retry after the first
 *    attempt's response was lost each leave one row, and `?after=` returns
 *    what the client missed.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;
const APP_URL = 'https://support.example.com';
const SHOP = 'https://shop.example.com';
const STRANGER = 'https://evil.example.net';

/** A stand-in widget build, so the routes that serve `apps/widget/dist` have files to serve. */
const WIDGET_DIST = mkdtempSync(path.join(tmpdir(), 'helpdock-widget-it-'));
mkdirSync(path.join(WIDGET_DIST, 'chunks'));
writeFileSync(path.join(WIDGET_DIST, 'widget.js'), 'import("./chunks/remote-abc.js");');
writeFileSync(path.join(WIDGET_DIST, 'chunks', 'remote-abc.js'), 'export {};');

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the widget integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Visitor {
  readonly id: string;
  readonly secret: string;
}

/** The siteverify double: a token of `pass` passes, anything else fails. */
const captchaCalls: URLSearchParams[] = [];
const captchaTransport: CaptchaTransport = {
  postForm: async (_url, form) => {
    captchaCalls.push(form);
    return {
      status: 200,
      body: JSON.stringify(
        form.get('response') === 'pass'
          ? { success: true, hostname: 'shop.example.com' }
          : { success: false, 'error-codes': ['invalid-input-response'] },
      ),
    };
  },
};

describe.skipIf(!hasDocker)('the chat widget', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let url: string;
  let owner: DbHandle;
  let worker: Redis;
  let seeded: SeededInstall;
  let ada: Person;
  let tia: Person;
  let otherBrandId: string;
  let departmentId: string;
  const open: Socket[] = [];

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
      WIDGET_DIST_DIR: WIDGET_DIST,
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const startApp = async (): Promise<void> => {
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({
      runtime,
      widget: { captchaTransport, streamTimings: { maxAgeMs: 1_500, heartbeatMs: 500 } },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = await app.getUrl();
  };

  const staff = <T>(
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

  const widget = <T>(
    method: 'GET' | 'POST' | 'OPTIONS',
    path: string,
    options: {
      readonly visitor?: Visitor;
      readonly origin?: string | null;
      readonly payload?: unknown;
      readonly brandId?: string;
      readonly ip?: string;
    } = {},
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }> => {
    const origin = options.origin === undefined ? SHOP : options.origin;
    return app
      .inject({
        method,
        url: `/api/widget/${options.brandId ?? seeded.brandId}${path}`,
        ...(options.ip === undefined ? {} : { remoteAddress: options.ip }),
        headers: {
          ...(origin === null ? {} : { origin }),
          ...(options.visitor === undefined
            ? {}
            : { authorization: `Visitor ${options.visitor.secret}` }),
          ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.payload === undefined ? {} : { payload: JSON.stringify(options.payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
        headers: response.headers,
      }));
  };

  const newVisitor = async (body: Record<string, unknown> = {}, ip?: string): Promise<Visitor> => {
    const response = await widget<WidgetSession>('POST', '/session', {
      payload: body,
      ...(ip === undefined ? {} : { ip }),
    });
    expect(response.status).toBe(200);
    const secret = response.body.visitorSecret;
    if (secret === null) {
      throw new Error('a new visitor was not issued a secret');
    }
    return { id: response.body.visitorId, secret };
  };

  const start = (visitor: Visitor, body: Record<string, unknown> = {}) =>
    widget<WidgetSendResponse>('POST', '/conversations', {
      visitor,
      payload: { clientId: uuidv7(), text: 'Where is my order?', ...body },
    });

  const send = (visitor: Visitor, conversationId: string, body: Record<string, unknown>) =>
    widget<WidgetSendResponse>('POST', `/conversations/${conversationId}/messages`, {
      visitor,
      payload: body,
    });

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const addPerson = async (db: Db, name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${name}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name: `${name[0]?.toUpperCase() ?? ''}${name.slice(1)} Haddad`,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });
    return { id, email, token: '' };
  };

  /** What the worker's `outbox.event` consumer does with every unpublished row. */
  const drainOutbox = async (): Promise<string[]> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`).orderBy(outbox.id),
    );
    for (const row of rows) {
      await withSystem(runtime.db, row.brandId, async (tx) => {
        await outboxEvents.dispatch({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        });
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
      });
    }
    return rows.map((row) => row.event);
  };

  const connect = (visitor: Visitor, origin = SHOP, brandId = seeded.brandId): Promise<Socket> => {
    const socket = io(`${url}${WIDGET_NAMESPACE}`, {
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      auth: { brandId, visitorSecret: visitor.secret },
      extraHeaders: { origin },
      reconnection: false,
    });
    open.push(socket);
    return new Promise<Socket>((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  };

  const nextEvent = <T>(socket: Socket, event: string): Promise<WidgetEnvelope<T>> =>
    new Promise((resolve) => {
      socket.once(event, (envelope: WidgetEnvelope<T>) => resolve(envelope));
    });

  const agentReply = async (ticketId: string, kind: 'public' | 'note', text: string) => {
    const response = await staff<{ id: string; seq: number }>(
      'POST',
      `/api/brands/${seeded.brandId}/tickets/${ticketId}/messages`,
      ada,
      { kind, bodyHtml: `<p>${text}</p>` },
    );
    expect(response.status).toBe(201);
    return response.body;
  };

  const sign = (payload: Record<string, unknown>, secret: string) => {
    const typed = payload as Parameters<typeof canonicalIdentityJson>[0];
    return {
      payload: typed,
      signature: createHmac('sha256', secret).update(canonicalIdentityJson(typed)).digest('hex'),
    };
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await startApp();

    worker = new Redis(redisContainer.getConnectionUrl());
    registerTicketEventHandlers(new RedisRealtimeBroadcast(worker));
    // M8-03: every contact the suite makes writes `contact.created`.
    registerContactEventHandlers();
    ignoreAuthEmailInThisSuite();
    const hours = new BusinessHoursService(
      new SlaRepository(),
      new SlaService(new SlaRepository()),
    );
    registerWidgetEventHandlers(new RedisWidgetBroadcast(worker), {
      calendarsFor: (brandId, tx) => hours.calendarsFor(brandId, tx),
    });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    tia = await addPerson(runtime.db, 'tia');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values({
        userId: tia.id,
        brandId: seeded.brandId,
        role: 'team_leader',
        departmentIds: null,
      }),
    );
    ada.token = await signIn(ada.email, seeded.password);
    tia.token = await signIn(tia.email, PASSWORD);

    // A second brand, so a secret issued by one can be shown to be worthless at the other.
    otherBrandId = uuidv7();
    await runtime.db.insert(brands).values({ id: otherBrandId, name: 'Other', prefix: 'OT' });

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [first] = await tx.select({ id: departments.id }).from(departments).limit(1);
      departmentId = first?.id ?? '';
      // A sender for the brand, so a transcript has somewhere to come from.
      await tx.insert(emailOutboundSettings).values({
        brandId: seeded.brandId,
        defaultFromName: 'Helpdock support',
        defaultFromAddress: 'support@helpdock.test',
      });
    });

    const saved = await staff<WidgetSettings>(
      'PUT',
      `/api/brands/${seeded.brandId}/widget/access`,
      ada,
      {
        allowedOrigins: [SHOP, 'http://localhost:5173/'],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      },
    );
    expect(saved.status).toBe(200);
  }, 240_000);

  afterEach(() => {
    for (const socket of open.splice(0)) {
      socket.disconnect();
    }
  });

  afterAll(async () => {
    await worker?.quit();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------ settings

  describe('Channels › Widget (M4-06)', () => {
    it('shows a Team Leader the three cards they own and hides origins and signed identity', async () => {
      const settings = await staff<WidgetSettings>(
        'GET',
        `/api/brands/${seeded.brandId}/widget/settings`,
        tia,
      );

      expect(settings.status).toBe(200);
      expect(settings.body.access).toBeNull();
      expect(settings.body.signedIdentity).toBeNull();
      expect(
        (
          await staff('PUT', `/api/brands/${seeded.brandId}/widget/access`, tia, {
            allowedOrigins: [STRANGER],
            captchaEnabled: false,
            captchaProvider: 'turnstile',
            captchaSiteKey: '',
          })
        ).status,
      ).toBe(403);
    });

    it('stores origins normalised and refuses a path', async () => {
      const settings = await staff<WidgetSettings>(
        'GET',
        `/api/brands/${seeded.brandId}/widget/settings`,
        ada,
      );
      expect(settings.body.access?.allowedOrigins).toEqual([SHOP, 'http://localhost:5173']);

      const refused = await staff('PUT', `/api/brands/${seeded.brandId}/widget/access`, ada, {
        allowedOrigins: ['https://shop.example.com/help'],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      });
      expect(refused.status).toBe(400);
    });

    it('lets a Team Leader save the look and refuses an accent white text cannot be read on', async () => {
      const appearance = {
        mode: 'chat',
        accent: '#0f766e',
        colorScheme: 'auto',
        position: 'end',
        launcher: 'icon_text',
        greetingEn: 'Hi there',
        greetingAr: '',
      };
      const saved = await staff<WidgetSettings>(
        'PUT',
        `/api/brands/${seeded.brandId}/widget/appearance`,
        tia,
        appearance,
      );
      expect(saved.status).toBe(200);
      expect(saved.body.appearance.accent).toBe('#0F766E');

      const pale = await staff('PUT', `/api/brands/${seeded.brandId}/widget/appearance`, tia, {
        ...appearance,
        accent: '#FDE68A',
      });
      expect(pale.status).toBe(400);
    });
  });

  // -------------------------------------------------------------- origins

  describe('the origin allow-list (M4-03)', () => {
    it('serves the config to an allowed origin, with an ETag a reload can reuse', async () => {
      const first = await widget<WidgetConfig>('GET', '/config');
      expect(first.status).toBe(200);
      expect(first.body.brandId).toBe(seeded.brandId);
      expect(first.headers['access-control-allow-origin']).toBe(SHOP);

      const again = await app.inject({
        method: 'GET',
        url: `/api/widget/${seeded.brandId}/config`,
        headers: { origin: SHOP, 'if-none-match': String(first.headers.etag) },
      });
      expect(again.statusCode).toBe(304);
    });

    it('refuses the config, the session and every route to a page on another origin', async () => {
      const visitor = await newVisitor();
      for (const [method, path] of [
        ['GET', '/config'],
        ['POST', '/session'],
        ['GET', '/conversations'],
      ] as const) {
        const response = await widget<{ error: { widget?: { reason: string } } }>(method, path, {
          origin: STRANGER,
          visitor,
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(response.status).toBe(403);
        expect(response.body.error.widget?.reason).toBe('origin_not_allowed');
      }
    });

    it('refuses a request with no origin at all', async () => {
      const response = await widget('GET', '/config', { origin: null });
      expect(response.status).toBe(403);
    });

    it('refuses the socket handshake from another origin', async () => {
      const visitor = await newVisitor();
      await expect(connect(visitor, STRANGER)).rejects.toMatchObject({
        data: { code: 'origin_not_allowed' },
      });
      await expect(connect(visitor, SHOP)).resolves.toMatchObject({ connected: true });
    });

    it('answers a preflight without touching the database', async () => {
      const response = await widget('OPTIONS', '/session');
      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
    });
  });

  // ------------------------------------------------------------- identity

  describe('visitor identity (M4-02)', () => {
    it('issues a secret once and stores only its hash', async () => {
      const visitor = await newVisitor();
      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(widgetVisitors).where(eq(widgetVisitors.id, visitor.id)),
      );

      expect(row?.secretHash).toBe(createHash('sha256').update(visitor.secret).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(visitor.secret);

      const again = await widget<WidgetSession>('POST', '/session', { visitor, payload: {} });
      expect(again.body).toMatchObject({ visitorId: visitor.id, visitorSecret: null });
    });

    it('refuses a secret another brand issued, and a made-up one', async () => {
      await withSystem(runtime.db, otherBrandId, (tx) =>
        tx.execute(
          sql`INSERT INTO widget_settings (brand_id, allowed_origins) VALUES (${otherBrandId}::uuid, ARRAY[${SHOP}])`,
        ),
      );
      const visitor = await newVisitor();

      const elsewhere = await widget('GET', '/conversations', { visitor, brandId: otherBrandId });
      expect(elsewhere.status).toBe(401);
      const madeUp = await widget('GET', '/conversations', {
        visitor: { id: visitor.id, secret: 'A'.repeat(43) },
      });
      expect(madeUp.status).toBe(401);
    });

    it('never opens another contact’s conversations to a visitor who types their email (exit criterion)', async () => {
      const address = `mona-${uuidv7()}@example.com`;
      // Mona also writes in by email, so her address is verified on a contact
      // of hers that holds an email ticket.
      const monaByEmail = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({ brandId: seeded.brandId, name: 'Mona Khalil' })
          .returning();
        await tx.insert(contactIdentities).values({
          brandId: seeded.brandId,
          contactId: contact?.id ?? '',
          kind: 'email',
          value: address,
          verified: true,
          verifiedAt: new Date(),
          source: 'email.inbound',
        });
        return contact?.id ?? '';
      });
      const emailTicket = await staff<TicketDetail>(
        'POST',
        `/api/brands/${seeded.brandId}/tickets`,
        ada,
        {
          subject: 'Invoice',
          bodyHtml: '<p>Invoice question</p>',
          channel: 'email',
          departmentId,
          contactId: monaByEmail,
        },
      );
      expect(emailTicket.status).toBe(201);

      await staff('PUT', `/api/brands/${seeded.brandId}/widget/conversation`, tia, {
        prechatEnabled: true,
        prechatFields: [
          { kind: 'name', required: false },
          { kind: 'email', required: false },
        ],
        showAgentIdentity: true,
        whenUnavailable: 'form',
        transcriptEnabled: false,
      });
      const mona = await newVisitor();
      const started = await start(mona, {
        prechat: { name: 'Mona Khalil', email: address },
      });
      expect(started.status).toBe(201);
      const monaConversation = started.body.conversation.id;

      const mallory = await newVisitor();
      const hers = await start(mallory, {
        prechat: { name: 'Mona Khalil', email: address.toUpperCase() },
      });
      expect(hers.status).toBe(201);
      expect(hers.body.conversation.id).not.toBe(monaConversation);

      const list = await widget<WidgetConversationList>('GET', '/conversations', {
        visitor: mallory,
      });
      expect(list.body.conversations.map((c) => c.id)).toEqual([hers.body.conversation.id]);

      for (const path of [
        `/conversations/${monaConversation}`,
        `/conversations/${monaConversation}/messages?after=0`,
        `/conversations/${emailTicket.body.ticket.id}`,
      ]) {
        const response = await widget<{ error: { widget?: { reason: string } } }>('GET', path, {
          visitor: mallory,
        });
        expect(response.status).toBe(404);
        expect(response.body.error.widget?.reason).toBe('not_found');
      }
      expect(
        (await send(mallory, monaConversation, { clientId: uuidv7(), text: 'let me in' })).status,
      ).toBe(404);

      const socket = await connect(mallory);
      const ack: WidgetJoinAck = await socket.emitWithAck(WIDGET_EVENTS.join, {
        conversationId: monaConversation,
      });
      expect(ack).toMatchObject({ ok: false, error: { code: 'not_found' } });

      // The typed address stays where the proof put it, on Mona's email
      // contact; typing it moved nobody onto that contact.
      const identities = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(contactIdentities)
          .where(and(eq(contactIdentities.kind, 'email'), eq(contactIdentities.value, address))),
      );
      expect(identities).toEqual([
        expect.objectContaining({ contactId: monaByEmail, verified: true }),
      ]);
      const [malloryRow] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(widgetVisitors).where(eq(widgetVisitors.id, mallory.id)),
      );
      expect(malloryRow?.contactId).not.toBe(monaByEmail);
      expect(malloryRow?.verifiedContactId).toBeNull();
    });

    it('shows the agent the pre-chat email as unverified', async () => {
      const visitor = await newVisitor();
      const started = await start(visitor, {
        prechat: { name: 'Sara', email: `sara-${visitor.id}@example.com` },
      });
      const detail = await staff<TicketDetail>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${started.body.conversation.id}`,
        ada,
      );
      const contactId = detail.body.ticket.contactId ?? '';
      const contact = await staff<{ primaryIdentity: { kind: string; verified: boolean } }>(
        'GET',
        `/api/brands/${seeded.brandId}/contacts/${contactId}`,
        ada,
      );

      expect(detail.body.ticket.channel).toBe('chat');
      expect(contact.body.primaryIdentity).toMatchObject({ kind: 'email', verified: false });
    });

    describe('signed identity (§4.2)', () => {
      let secret: string;

      beforeAll(async () => {
        const made = await staff<WidgetSigningSecret>(
          'POST',
          `/api/brands/${seeded.brandId}/widget/signing-secret`,
          ada,
        );
        expect(made.status).toBe(201);
        secret = made.body.secret;
        const enabled = await staff<WidgetSettings>(
          'PUT',
          `/api/brands/${seeded.brandId}/widget/signed-identity`,
          ada,
          { enabled: true, seesAllChannels: false },
        );
        expect(enabled.body.signedIdentity?.secret).not.toBeNull();
        expect(JSON.stringify(enabled.body)).not.toContain(secret);
      });

      const identify = (visitor: Visitor, payload: Record<string, unknown>, key = secret) =>
        widget<WidgetSession>('POST', '/session', {
          visitor,
          payload: { identity: sign(payload, key) },
        });

      it('carries a verified visitor’s widget conversations to another device, and no other channel', async () => {
        const now = Math.floor(Date.now() / 1000);
        const laptop = await newVisitor();
        expect((await identify(laptop, { user_id: 'cust-42', ts: now })).body.verified).toBe(true);
        const opened = await start(laptop);

        const phone = await newVisitor();
        expect((await identify(phone, { user_id: 'cust-42', ts: now })).body.verified).toBe(true);
        const seen = await widget<WidgetConversationList>('GET', '/conversations', {
          visitor: phone,
        });
        expect(seen.body.conversations.map((c) => c.id)).toContain(opened.body.conversation.id);

        // Signing out on the host site: the next load carries no identity.
        await widget('POST', '/session', { visitor: phone, payload: {} });
        const after = await widget<WidgetConversationList>('GET', '/conversations', {
          visitor: phone,
        });
        expect(after.body.conversations.map((c) => c.id)).not.toContain(
          opened.body.conversation.id,
        );
      });

      it('shows a verified visitor their email tickets only when the brand allows it', async () => {
        const now = Math.floor(Date.now() / 1000);
        const visitor = await newVisitor();
        await identify(visitor, { user_id: 'cust-77', ts: now });
        const [visitorRow] = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.select().from(widgetVisitors).where(eq(widgetVisitors.id, visitor.id)),
        );
        const emailTicket = await staff<TicketDetail>(
          'POST',
          `/api/brands/${seeded.brandId}/tickets`,
          ada,
          {
            subject: 'By email',
            bodyHtml: '<p>hello</p>',
            channel: 'email',
            departmentId,
            contactId: visitorRow?.verifiedContactId,
          },
        );

        const hidden = await widget('GET', `/conversations/${emailTicket.body.ticket.id}`, {
          visitor,
        });
        expect(hidden.status).toBe(404);

        await staff('PUT', `/api/brands/${seeded.brandId}/widget/signed-identity`, ada, {
          enabled: true,
          seesAllChannels: true,
        });
        const shown = await widget('GET', `/conversations/${emailTicket.body.ticket.id}`, {
          visitor,
        });
        expect(shown.status).toBe(200);
        const write = await send(visitor, emailTicket.body.ticket.id, {
          clientId: uuidv7(),
          text: 'hi',
        });
        expect(write.status).toBe(409);
        await staff('PUT', `/api/brands/${seeded.brandId}/widget/signed-identity`, ada, {
          enabled: true,
          seesAllChannels: false,
        });
      });

      it('leaves a bad or stale signature anonymous, and audits it', async () => {
        const visitor = await newVisitor();
        const now = Math.floor(Date.now() / 1000);
        expect(
          (await identify(visitor, { user_id: 'cust-42', ts: now }, 'wrong')).body.verified,
        ).toBe(false);
        expect((await identify(visitor, { user_id: 'cust-42', ts: now - 600 })).body.verified).toBe(
          false,
        );

        const audits = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, 'widget.identity_rejected'),
                eq(auditLog.targetId, visitor.id),
              ),
            ),
        );
        expect(audits.map((row) => (row.meta as { reason: string }).reason).sort()).toEqual([
          'bad_signature',
          'expired',
        ]);
      });
    });
  });

  // ------------------------------------------------------------- delivery

  describe('the delivery contract (M4-04)', () => {
    it('keeps one message for a double submit, and one conversation for a double start', async () => {
      const visitor = await newVisitor();
      const clientId = uuidv7();
      const [a, b] = await Promise.all([
        start(visitor, { clientId, text: 'Hello?' }),
        start(visitor, { clientId, text: 'Hello?' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 201]);
      expect(a.body.conversation.id).toBe(b.body.conversation.id);
      expect(a.body.message.seq).toBe(b.body.message.seq);

      const conversationId = a.body.conversation.id;
      const sendId = uuidv7();
      const replies = await Promise.all(
        [1, 2, 3].map(() => send(visitor, conversationId, { clientId: sendId, text: 'Anyone?' })),
      );
      expect(new Set(replies.map((reply) => reply.body.message.id)).size).toBe(1);

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(ticketMessages).where(eq(ticketMessages.ticketId, conversationId)),
      );
      expect(rows.filter((row) => row.clientId === clientId)).toHaveLength(1);
      expect(rows.filter((row) => row.clientId === sendId)).toHaveLength(1);
      const created = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.visitorId, visitor.id)),
      );
      expect(created).toHaveLength(1);
    });

    it('answers a retry after the api restarts with the message that exists', async () => {
      const visitor = await newVisitor();
      const opened = await start(visitor);
      const clientId = uuidv7();
      const first = await send(visitor, opened.body.conversation.id, {
        clientId,
        text: 'Still there?',
      });

      await app.close();
      await runtime.close();
      await startApp();

      const retried = await send(visitor, opened.body.conversation.id, {
        clientId,
        text: 'Still there?',
      });
      expect(retried.status).toBe(201);
      expect(retried.body.message).toEqual(first.body.message);
    });

    it('catches a client up from its cursor, past notes it never sees', async () => {
      const visitor = await newVisitor();
      const opened = await start(visitor);
      const conversationId = opened.body.conversation.id;
      const cursor = opened.body.message.seq;

      await agentReply(conversationId, 'note', 'internal: check the warehouse');
      const reply = await agentReply(conversationId, 'public', 'On its way!');

      const page = await widget<WidgetMessagePage>(
        'GET',
        `/conversations/${conversationId}/messages?after=${String(cursor)}`,
        { visitor },
      );
      expect(page.body.messages.map((m) => m.text)).toEqual(['On its way!']);
      // The brand shows agents: a first name, never a surname.
      expect(page.body.messages[0]?.author).toBe('agent');
      expect(page.body.messages[0]?.agent?.name).toMatch(/^\S+$/);
      expect(page.body.lastSeq).toBe(reply.seq);
      expect(JSON.stringify(page.body)).not.toContain('warehouse');
    });

    it('delivers an agent reply over the socket and over SSE, with the same payload', async () => {
      const visitor = await newVisitor();
      const opened = await start(visitor);
      const conversationId = opened.body.conversation.id;
      await drainOutbox();

      const socket = await connect(visitor);
      const joined: WidgetJoinAck = await socket.emitWithAck(WIDGET_EVENTS.join, {
        conversationId,
      });
      expect(joined).toEqual({
        ok: true,
        data: { conversationId, lastSeq: opened.body.message.seq },
      });

      const controller = new AbortController();
      const stream = await fetch(
        `${url}/api/widget/${seeded.brandId}/stream?conversationId=${conversationId}&after=${String(opened.body.message.seq)}`,
        {
          headers: { origin: SHOP, authorization: `Visitor ${visitor.secret}` },
          signal: controller.signal,
        },
      );
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = stream.body?.getReader();

      const overSocket = nextEvent<WidgetMessage>(socket, WIDGET_EVENTS.message);
      const reply = await agentReply(conversationId, 'public', 'Here to help');
      await drainOutbox();

      const socketEnvelope = await overSocket;
      expect(socketEnvelope.seq).toBe(reply.seq);
      expect(socketEnvelope.data).toMatchObject({ text: 'Here to help', author: 'agent' });

      let text = '';
      const decoder = new TextDecoder();
      while (!text.includes(`"seq":${String(reply.seq)}`) && reader !== undefined) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        text += decoder.decode(chunk.value);
      }
      controller.abort();
      const frame = text.split('\n\n').find((block) => block.startsWith('event: message'));
      const envelope = JSON.parse(
        frame?.split('data: ')[1] ?? '{}',
      ) as WidgetEnvelope<WidgetMessage>;
      expect(envelope.seq).toBe(socketEnvelope.seq);
      expect(envelope.data).toEqual(socketEnvelope.data);
    });

    it('sends over the socket with an acknowledgement that carries the seq', async () => {
      const visitor = await newVisitor();
      const opened = await start(visitor);
      const socket = await connect(visitor);
      const clientId = uuidv7();
      const message = { clientId, text: 'via socket' };

      const ack: WidgetSendAck = await socket.emitWithAck(WIDGET_EVENTS.send, {
        conversationId: opened.body.conversation.id,
        message,
      });
      const again: WidgetSendAck = await socket.emitWithAck(WIDGET_EVENTS.send, {
        conversationId: opened.body.conversation.id,
        message,
      });

      expect(ack.ok && again.ok && ack.data.message.id === again.data.message.id).toBe(true);
      expect(ack.ok ? ack.data.message.seq : 0).toBeGreaterThan(opened.body.message.seq);
    });

    it('closes an SSE stream after its lifetime so the client reconnects with its cursor', async () => {
      const visitor = await newVisitor();
      const opened = await start(visitor);
      const response = await fetch(
        `${url}/api/widget/${seeded.brandId}/stream?conversationId=${opened.body.conversation.id}&after=0`,
        { headers: { origin: SHOP, authorization: `Visitor ${visitor.secret}` } },
      );
      const body = await response.text();

      expect(body).toContain('event: message');
      expect(body).toContain('event: presence');
    });
  });

  // --------------------------------------------------------- access controls

  describe('throttles and the bot check (M4-03)', () => {
    it('throttles one visitor’s writes', async () => {
      const visitor = await newVisitor({}, '10.9.0.1');
      const opened = await start(visitor);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < WIDGET_VISITOR_WRITE_RULE.limit; attempt += 1) {
        statuses.push(
          (
            await send(visitor, opened.body.conversation.id, {
              clientId: uuidv7(),
              text: `n${attempt}`,
            })
          ).status,
        );
      }
      expect(statuses.at(-1)).toBe(429);
    });

    it('asks for a CAPTCHA before the first message when the brand wants one', async () => {
      await staff('PUT', `/api/brands/${seeded.brandId}/widget/access`, ada, {
        allowedOrigins: [SHOP],
        captchaEnabled: true,
        captchaProvider: 'turnstile',
        captchaSiteKey: '0x4AAAAAAA',
        captchaSecret: '0x4AAAAAAA-secret',
      });
      const config = await widget<WidgetConfig>('GET', '/config');
      expect(config.body.captcha).toEqual({ provider: 'turnstile', siteKey: '0x4AAAAAAA' });

      const visitor = await newVisitor();
      const refused = await start(visitor, { captchaToken: 'nope' });
      expect(refused.status).toBe(403);
      const before = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.visitorId, visitor.id)),
      );
      expect(before).toHaveLength(0);

      const passed = await start(visitor, { captchaToken: 'pass' });
      expect(passed.status).toBe(201);
      expect(captchaCalls.at(-1)?.get('secret')).toBe('0x4AAAAAAA-secret');

      await staff('PUT', `/api/brands/${seeded.brandId}/widget/access`, ada, {
        allowedOrigins: [SHOP],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '0x4AAAAAAA',
      });
    });
  });

  // ------------------------------------------------------------- M4-08

  describe('transcript and availability (M4-08)', () => {
    it('queues a transcript through the outbox, to the address typed and nobody else', async () => {
      await staff('PUT', `/api/brands/${seeded.brandId}/widget/conversation`, tia, {
        prechatEnabled: true,
        prechatFields: [{ kind: 'email', required: false }],
        showAgentIdentity: true,
        whenUnavailable: 'keep_chat',
        transcriptEnabled: true,
      });
      const visitor = await newVisitor();
      const opened = await start(visitor);

      const asked = await widget(
        'POST',
        `/conversations/${opened.body.conversation.id}/transcript`,
        {
          visitor,
          payload: { email: 'Visitor@Example.com' },
        },
      );

      expect(asked.status).toBe(202);
      const deliveries = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(emailDeliveries)
          .where(eq(emailDeliveries.ticketId, opened.body.conversation.id)),
      );
      expect(deliveries).toEqual([
        expect.objectContaining({
          kind: 'transcript',
          toAddress: 'visitor@example.com',
          ccAddresses: [],
        }),
      ]);
    });

    it('says whether the brand is open and when it next opens', async () => {
      const availability = await widget<{ open: boolean; nextOpenAt: string | null }>(
        'GET',
        '/availability',
      );
      expect(availability.status).toBe(200);
      expect(typeof availability.body.open).toBe('boolean');
    });

    describe('the hours of a conversation (M7-06)', () => {
      const SATURDAY = new Date('2026-09-26T12:00:00.000Z');
      const WEEKDAYS = defaultWeeklyHours();
      const ALL_DAY = Array.from({ length: 7 }, () => [{ start: '00:00', end: '24:00' }]);

      const hoursAt = async (visitor: Visitor, conversationId: string, now: Date) =>
        (
          await app
            .get(WidgetConversationsService)
            .get(
              seeded.brandId,
              { origin: SHOP, authorization: `Visitor ${visitor.secret}`, ip: null },
              conversationId,
              now,
            )
        ).hours;

      const saveBrandHours = async (weekly: WeeklyHours): Promise<void> => {
        const saved = await staff('PUT', `/api/brands/${seeded.brandId}/business-hours`, ada, {
          brand: { timezone: 'UTC', weekly },
          departments: [],
        });
        expect(saved.status).toBe(200);
      };

      it('is the default Monday-to-Friday week in the brand zone when no hours were saved', async () => {
        const visitor = await newVisitor();
        const opened = await start(visitor);
        const conversationId = opened.body.conversation.id;

        expect(await hoursAt(visitor, conversationId, SATURDAY)).toEqual({
          open: false,
          nextOpenAt: '2026-09-28T09:00:00.000Z',
          timezone: 'UTC',
        });
        const overHttp = await widget<WidgetConversation>(
          'GET',
          `/conversations/${conversationId}`,
          {
            visitor,
          },
        );
        expect(overHttp.body.hours).toMatchObject({ timezone: 'UTC' });
        expect(opened.body.conversation.hours).toMatchObject({ timezone: 'UTC' });
      });

      it('is open, with no opening, when the brand saved 24/7 hours', async () => {
        const visitor = await newVisitor();
        const conversationId = (await start(visitor)).body.conversation.id;

        await saveBrandHours(ALL_DAY);
        try {
          expect(await hoursAt(visitor, conversationId, SATURDAY)).toEqual({
            open: true,
            nextOpenAt: null,
            timezone: 'UTC',
          });
        } finally {
          await saveBrandHours(WEEKDAYS);
        }
      });
    });

    it('names the agents online by first name, unless the brand hides who they are', async () => {
      const conversation = {
        prechatEnabled: false,
        prechatFields: [],
        whenUnavailable: 'keep_chat',
        transcriptEnabled: false,
      };
      const presence = app.get(PresenceService);
      const membership = {
        brandId: seeded.brandId,
        userId: tia.id,
        socketId: 'widget-test-socket',
      };
      await presence.join(membership);
      try {
        await staff('PUT', `/api/brands/${seeded.brandId}/widget/conversation`, tia, {
          ...conversation,
          showAgentIdentity: true,
        });
        const shown = await widget<WidgetAvailability>('GET', '/availability');
        expect(shown.body).toMatchObject({
          agentsOnline: true,
          agents: [{ name: 'Tia', avatarUrl: null }],
        });

        await staff('PUT', `/api/brands/${seeded.brandId}/widget/conversation`, tia, {
          ...conversation,
          showAgentIdentity: false,
        });
        const hidden = await widget<WidgetAvailability>('GET', '/availability');
        expect(hidden.body).toMatchObject({ agentsOnline: true, agents: [] });
      } finally {
        await presence.leave(membership);
      }
    });
  });
  // ------------------------------------------------ what the widget loads

  describe('the config the widget paints from (M4-06, M4-08)', () => {
    it('resolves the theme, and words the greeting and the fields in the language asked', async () => {
      await staff('PUT', `/api/brands/${seeded.brandId}/widget/appearance`, tia, {
        mode: 'chat',
        accent: '#1D4ED8',
        colorScheme: 'auto',
        position: 'start',
        launcher: 'icon_text',
        greetingEn: 'Hi, how can we help?',
        greetingAr: 'مرحباً، كيف نساعدك؟',
      });

      const english = await widget<WidgetConfig>('GET', '/config?locale=en');
      const arabic = await widget<WidgetConfig>('GET', '/config?locale=ar');

      expect(english.status).toBe(200);
      expect(english.body).toMatchObject({
        locale: 'en',
        mode: 'chat',
        greeting: 'Hi, how can we help?',
        popularArticles: [],
        helpCenterUrl: null,
        showPoweredBy: true,
        theme: {
          colorScheme: 'auto',
          launcher: { style: 'icon_text', label: null, position: 'start' },
        },
      });
      expect(english.body.theme.tokens.light['action.primary']).toBe('#1D4ED8');
      expect(english.body.theme.tokens.dark['action.primary']).not.toBe('#1D4ED8');
      expect(english.body.theme.fonts[0]?.url).toMatch(`${APP_URL}/widget-fonts/`);
      expect(arabic.body.greeting).toBe('مرحباً، كيف نساعدك؟');
      expect(arabic.headers.etag).not.toBe(english.headers.etag);

      const refused = await widget('GET', '/config?locale=fr');
      expect(refused.status).toBe(400);
    });
  });

  describe('starting a conversation before its first message (M4-04)', () => {
    it('opens it empty, answers a retried start with the same conversation, and names it from the first message', async () => {
      const visitor = await newVisitor();
      const clientId = uuidv7();
      const body = {
        clientId,
        prechat: { name: 'Omar', email: 'omar@example.com' },
      };

      const [first, second] = await Promise.all([
        widget<WidgetStartResponse>('POST', '/conversations', { visitor, payload: body }),
        widget<WidgetStartResponse>('POST', '/conversations', { visitor, payload: body }),
      ]);
      const retried = await widget<WidgetStartResponse>('POST', '/conversations', {
        visitor,
        payload: body,
      });

      expect([first.status, second.status, retried.status]).toEqual([201, 201, 201]);
      expect(first.body.message).toBeNull();
      const conversationId = first.body.conversation.id;
      expect(second.body.conversation.id).toBe(conversationId);
      expect(retried.body.conversation.id).toBe(conversationId);
      const opened = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.visitorId, visitor.id)),
      );
      expect(opened).toEqual([
        expect.objectContaining({ subject: 'Chat conversation', visitorClientId: clientId }),
      ]);

      const sent = await send(visitor, conversationId, {
        clientId: uuidv7(),
        text: 'My parcel never arrived',
      });
      expect(sent.status).toBe(201);
      expect(sent.body.message.seq).toBe(1);
      const named = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.id, conversationId)),
      );
      expect(named[0]?.subject).toBe('My parcel never arrived');

      const later = await send(visitor, conversationId, { clientId: uuidv7(), text: 'Any news?' });
      expect(later.status).toBe(201);
      const kept = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.id, conversationId)),
      );
      expect(kept[0]?.subject).toBe('My parcel never arrived');
    });
  });

  describe('the widget bundle (M4-01)', () => {
    it('serves widget.js and its chunks to any site, and keeps the hashed chunks for a year', async () => {
      const entry = await app.inject({ method: 'GET', url: '/widget.js' });
      const chunk = await app.inject({ method: 'GET', url: '/chunks/remote-abc.js' });

      expect(entry.statusCode).toBe(200);
      expect(entry.body).toContain('remote-abc.js');
      expect(entry.headers).toMatchObject({
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'public, max-age=300',
      });
      expect(String(entry.headers['content-type'])).toContain('text/javascript');
      expect(chunk.statusCode).toBe(200);
      expect(chunk.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('answers 404 for a file the build does not have, and refuses a path out of it', async () => {
      const missing = await app.inject({ method: 'GET', url: '/chunks/nope.js' });
      const font = await app.inject({ method: 'GET', url: '/widget-fonts/nope.woff2' });
      const climbing = await app.inject({ method: 'GET', url: '/chunks/..%2Fwidget.js' });

      expect(missing.statusCode).toBe(404);
      expect(font.statusCode).toBe(404);
      expect(climbing.statusCode).toBe(400);
    });
  });
});
