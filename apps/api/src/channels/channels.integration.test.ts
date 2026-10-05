import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  attachments,
  auditLog,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  mailboxes,
  outbox,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type {
  ImapTestResult,
  InboundParseSecret,
  InboundParseSettings,
  Mailbox,
  MailboxList,
  TicketMessagePage,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, desc, eq, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import sharp from 'sharp';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { FakeStorage } from '../testing/media.js';
import {
  createEmailPollProcessor,
  createMailboxChangedHandler,
  type PollScheduler,
  scheduleAllPollers,
} from './email-poll.job.js';
import { createInboundEmailService } from './inbound/factory.js';
import { MailboxesRepository } from './mailboxes.repository.js';

/**
 * M2-01 to M2-04, M2-07 and the inbound half of M2-08 against real Postgres,
 * Redis and an IMAP server (GreenMail), over real sessions.
 *
 * What only exists once the pieces are together:
 *
 * 1. **Channels › Mailboxes** writes, audits and schedules, and never returns a
 *    secret; an Agent cannot touch it.
 * 2. **Inbound parse**: a message posted with the brand's secret becomes a
 *    ticket; a redelivery does not become a second one; a wrong secret or an
 *    unknown recipient is the same 401.
 * 3. **Threading (DOMAIN-RULES §4.3)**: a participant's reply threads, a
 *    stranger quoting the ticket number gets a ticket of their own with the
 *    mismatch note — M2 exit criterion 2.
 * 4. **Email security (M2-07)**: scripts go, remote images leave the body and
 *    come back only through the proxy, re-encoded.
 * 5. **IMAP polling (M2-02)**: mail sent to a GreenMail mailbox is polled into
 *    a ticket, and a refused sign-in is recorded as the mailbox's health.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.5';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;
const SMTP_PORT = 3025;
const IMAPS_PORT = 3993;
/**
 * GreenMail starts its servers, waits up to `greenmail.startup.timeout` (2 s by
 * default) for all of them, and only then creates the users. On a busy Docker
 * host a server misses that window: GreenMail's main thread throws, the users
 * are never created, and the servers it did start stay up, so the ports listen
 * and every login is "Invalid login/password". A generous timeout keeps that
 * from happening, and waiting for the API server's log line — written after
 * the users exist, never after a failed start — makes a failed start fail the
 * suite's setup instead of its IMAP tests.
 */
const GREENMAIL_READY = Wait.forAll([
  Wait.forListeningPorts(),
  Wait.forLogMessage(/Starting GreenMail API server/),
]);
/** GreenMail's certificate is self-signed; only these suites say so. */
const TEST_IMAP = { tls: { rejectUnauthorized: false }, timeoutMs: 10_000 };

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M2 inbound integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

const PNG = await sharp({
  create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 20, b: 20 } },
})
  .png()
  .toBuffer();

describe.skipIf(!hasDocker)('the inbound email channel', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let greenmail: StartedTestContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: FakeStorage;

  let support: string;
  let billing: string;
  let ada: Person;
  let sam: Person;
  let secret = '';
  const fetched: string[] = [];

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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    who: Person | null,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Record<string, unknown>; raw: Buffer }> =>
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
        body: (response.headers['content-type']?.toString().includes('json')
          ? response.json()
          : undefined) as T,
        headers: response.headers,
        raw: response.rawPayload,
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

  let sequence = 0;
  const unique = (local: string): string => {
    sequence += 1;
    return `${local}-${String(sequence)}@example.com`;
  };

  const parse = (
    body: unknown,
    options: { provider?: string; secret?: string; contentType?: string; raw?: string } = {},
  ) =>
    app
      .inject({
        method: 'POST',
        url: `/internal/inbound-parse/${options.provider ?? 'generic'}`,
        headers: {
          'content-type': options.contentType ?? 'application/json',
          ...(options.secret === undefined
            ? { 'x-helpdock-inbound-secret': secret }
            : options.secret === ''
              ? {}
              : { 'x-helpdock-inbound-secret': options.secret }),
        },
        payload: options.raw ?? JSON.stringify(body),
      })
      .then((response) => ({
        status: response.statusCode,
        body: response.json() as { outcome?: string },
      }));

  const messageOf = (messageId: string) =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [row] = await tx
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.externalMessageId, messageId));
      return row;
    });

  const ticketOf = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [row] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
      return row;
    });

  const createMailbox = (body: Record<string, unknown>) =>
    call<Mailbox>('POST', `${brandPath()}/mailboxes`, ada, {
      displayName: 'Helpdock Support',
      departmentId: support,
      method: 'inbound_parse',
      ...body,
    });

  beforeAll(async () => {
    [postgres, redisContainer, greenmail] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(GREENMAIL_IMAGE)
        .withEnvironment({
          GREENMAIL_OPTS:
            '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.startup.timeout=60000 -Dgreenmail.users=desk:desk-password@helpdock.test',
        })
        .withExposedPorts(SMTP_PORT, IMAPS_PORT)
        .withWaitStrategy(GREENMAIL_READY)
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-inbound-')));
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      channels: {
        imap: TEST_IMAP,
        imageFetcher: {
          fetch: async (url) => {
            fetched.push(url);
            await Promise.resolve();
            return url.includes('not-an-image')
              ? { status: 200, contentType: 'text/html', body: Buffer.from('<p>no</p>') }
              : { status: 200, contentType: 'image/png', body: PNG };
          },
        },
      },
    });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');

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
    await Promise.all([postgres?.stop(), redisContainer?.stop(), greenmail?.stop()]);
  });

  // ------------------------------------------------------------------ admin

  describe('Channels › Mailboxes (M2-08)', () => {
    it('creates an IMAP mailbox, keeps its password to itself and schedules it', async () => {
      const created = await createMailbox({
        address: 'Billing@Helpdock.test',
        displayName: 'Helpdock Billing',
        departmentId: billing,
        method: 'imap',
        imap: {
          host: 'imap.fastmail.com',
          port: 993,
          security: 'tls',
          username: 'billing@helpdock.test',
          password: 'app-password-1',
        },
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        address: 'billing@helpdock.test',
        departmentName: 'Billing',
        method: 'imap',
        imap: {
          folder: 'INBOX',
          pollIntervalSeconds: 60,
          passwordSet: true,
          passwordUpdatedByName: 'Dev Admin',
        },
        remoteImages: 'block',
        health: { state: 'healthy' },
      });
      expect(JSON.stringify(created.body)).not.toContain('app-password-1');

      const stored = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(mailboxes).where(eq(mailboxes.id, created.body.id)),
      );
      expect(stored[0]?.imapPassword).toMatch(/^v1\./);
      const events = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ event: outbox.event, payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, 'mailbox.changed')),
      );
      expect(events.map((row) => row.payload)).toContainEqual({ mailboxId: created.body.id });
    });

    it('refuses an address that is already taken, and a department of nobody', async () => {
      const taken = await createMailbox({ address: 'billing@helpdock.test' });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ error: { channels: { reason: 'address-taken' } } });

      const nowhere = await createMailbox({ address: unique('x'), departmentId: uuidv7() });
      expect(nowhere.status).toBe(404);
    });

    it('updates it whole, keeps the password unless replaced, and needs one to become IMAP', async () => {
      const inbound = await createMailbox({ address: unique('switch') });
      expect(inbound.body.imap).toBeNull();

      const base = {
        address: inbound.body.address,
        displayName: 'Renamed',
        departmentId: support,
        remoteImages: 'proxy',
        authFailureIsSpam: true,
        automatedAllowlist: ['Alerts@StatusPage.io', 'alerts@statuspage.io'],
      };
      const noPassword = await call('PUT', `${brandPath()}/mailboxes/${inbound.body.id}`, ada, {
        ...base,
        method: 'imap',
        imap: { host: 'imap.example.com', port: 993, security: 'tls', username: 'u' },
      });
      expect(noPassword.status).toBe(400);

      const withPassword = await call<Mailbox>(
        'PUT',
        `${brandPath()}/mailboxes/${inbound.body.id}`,
        ada,
        {
          ...base,
          method: 'imap',
          imap: {
            host: 'imap.example.com',
            port: 993,
            security: 'tls',
            username: 'u',
            password: 'p',
          },
        },
      );
      expect(withPassword.body).toMatchObject({
        displayName: 'Renamed',
        remoteImages: 'proxy',
        automatedAllowlist: ['alerts@statuspage.io'],
        imap: { passwordSet: true },
      });

      const kept = await call<Mailbox>('PUT', `${brandPath()}/mailboxes/${inbound.body.id}`, ada, {
        ...base,
        method: 'imap',
        imap: {
          host: 'imap.example.com',
          port: 143,
          security: 'starttls',
          username: 'u',
          pollIntervalSeconds: 300,
        },
      });
      expect(kept.body.imap).toMatchObject({
        port: 143,
        security: 'starttls',
        pollIntervalSeconds: 300,
        passwordSet: true,
      });

      const back = await call<Mailbox>('PUT', `${brandPath()}/mailboxes/${inbound.body.id}`, ada, {
        ...base,
        method: 'inbound_parse',
      });
      expect(back.body.imap).toBeNull();

      const clash = await call('PUT', `${brandPath()}/mailboxes/${inbound.body.id}`, ada, {
        ...base,
        address: 'billing@helpdock.test',
        method: 'inbound_parse',
      });
      expect(clash.status).toBe(409);

      const gone = await call('DELETE', `${brandPath()}/mailboxes/${inbound.body.id}`, ada);
      expect(gone.status).toBe(204);
      expect((await call('GET', `${brandPath()}/mailboxes/${inbound.body.id}`, ada)).status).toBe(
        404,
      );
      expect(
        (await call('DELETE', `${brandPath()}/mailboxes/${inbound.body.id}`, ada)).status,
      ).toBe(404);
      expect(
        (
          await call('PUT', `${brandPath()}/mailboxes/${inbound.body.id}`, ada, {
            ...base,
            method: 'inbound_parse',
          })
        ).status,
      ).toBe(404);

      const audited = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, inbound.body.id)),
      );
      expect(audited.map((row) => row.action)).toEqual(
        expect.arrayContaining(['mailbox.created', 'mailbox.updated', 'mailbox.deleted']),
      );
    });

    it('is the Admin’s alone: an Agent can neither read nor change it', async () => {
      expect((await call('GET', `${brandPath()}/mailboxes`, sam)).status).toBe(403);
      expect((await call('GET', `${brandPath()}/inbound-parse`, sam)).status).toBe(403);
      expect((await call('POST', `${brandPath()}/inbound-parse/secret`, sam)).status).toBe(403);
    });

    it('lists the mailboxes in address order', async () => {
      const list = await call<MailboxList>('GET', `${brandPath()}/mailboxes`, ada);
      const addresses = list.body.mailboxes.map((mailbox) => mailbox.address);
      expect(addresses).toEqual([...addresses].sort());
    });

    it('tests IMAP against a real server with the typed values, and with the stored password', async () => {
      const settings = {
        host: greenmail.getHost(),
        port: greenmail.getMappedPort(IMAPS_PORT),
        security: 'tls',
        username: 'desk',
        folder: 'INBOX',
      };
      const good = await call<ImapTestResult>('POST', `${brandPath()}/mailboxes/test-imap`, ada, {
        ...settings,
        password: 'desk-password',
      });
      expect(good.status).toBe(200);
      expect(good.body).toMatchObject({ ok: true, folder: 'INBOX' });

      const bad = await call<ImapTestResult>('POST', `${brandPath()}/mailboxes/test-imap`, ada, {
        ...settings,
        password: 'wrong',
      });
      expect(bad.body).toMatchObject({ ok: false, kind: 'auth' });

      const saved = await createMailbox({
        address: unique('desk'),
        method: 'imap',
        imap: { ...settings, password: 'desk-password' },
      });
      const stored = await call<ImapTestResult>('POST', `${brandPath()}/mailboxes/test-imap`, ada, {
        ...settings,
        mailboxId: saved.body.id,
      });
      expect(stored.body).toMatchObject({ ok: true });

      const none = await call('POST', `${brandPath()}/mailboxes/test-imap`, ada, settings);
      expect(none.status).toBe(400);
    });
  });

  // ---------------------------------------------------------- inbound parse

  describe('inbound parse (M2-03)', () => {
    it('has no secret until one is set, and shows the new one once', async () => {
      const before = await call<InboundParseSettings>('GET', `${brandPath()}/inbound-parse`, ada);
      expect(before.body).toEqual({ secretSet: false, secretUpdatedAt: null, lastRequest: null });

      const replaced = await call<InboundParseSecret>(
        'POST',
        `${brandPath()}/inbound-parse/secret`,
        ada,
      );
      expect(replaced.status).toBe(200);
      secret = replaced.body.secret;
      expect(secret.length).toBeGreaterThanOrEqual(40);

      const after = await call<InboundParseSettings>('GET', `${brandPath()}/inbound-parse`, ada);
      expect(after.body.secretSet).toBe(true);
      expect(JSON.stringify(after.body)).not.toContain(secret);

      const created = await createMailbox({ address: 'hello@helpdock.test' });
      expect(created.body.health.state).toBe('waiting');
    });

    it('answers the same 401 for a wrong secret, no secret and a recipient that is no mailbox', async () => {
      const message = {
        from: { address: unique('mona') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Hi',
        text: 'Hi',
      };
      expect((await parse(message, { secret: 'wrong' })).status).toBe(401);
      expect((await parse(message, { secret: '' })).status).toBe(401);
      expect((await parse({ ...message, to: [{ address: 'nobody@helpdock.test' }] })).status).toBe(
        401,
      );

      const settings = await call<InboundParseSettings>('GET', `${brandPath()}/inbound-parse`, ada);
      expect(settings.body.lastRequest).toMatchObject({ provider: 'generic', outcome: 'refused' });
    });

    it('accepts the secret as the password of HTTP Basic auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/inbound-parse/generic',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`inbound:${secret}`).toString('base64')}`,
        },
        payload: JSON.stringify({
          from: { address: unique('basic') },
          to: [{ address: 'hello@helpdock.test' }],
          subject: 'Basic',
          text: 'Basic auth works',
        }),
      });
      expect(response.statusCode).toBe(200);
    });

    it('refuses a body that is not the provider’s shape, and a Resend webhook without a body', async () => {
      expect((await parse({ nonsense: true })).status).toBe(400);
      const resend = await parse(
        { type: 'email.received', data: { from: 'a@example.com', to: ['hello@helpdock.test'] } },
        { provider: 'resend' },
      );
      expect(resend.status).toBe(422);
      expect((await parse({}, { provider: 'nope' })).status).toBe(400);
    });

    it('turns a message into a ticket in the mailbox’s department, once', async () => {
      const from = unique('mona');
      const message = {
        from: { address: from, name: 'Mona Khalil' },
        to: [{ address: 'hello@helpdock.test' }],
        cc: [{ address: 'Karim@Example.com', name: 'Karim' }, { address: 'billing@helpdock.test' }],
        subject: 'Refund not received',
        html:
          '<p>Hello<script>alert(1)</script></p><img src="https://mail.acme.de/pixel.gif" alt="">' +
          '<img src="cid:statement@acme"><div class="gmail_quote">older text</div>',
        messageId: '<first-1@acme.de>',
        headers: { 'Authentication-Results': 'mx; spf=pass' },
        attachments: [
          {
            filename: 'statement.png',
            contentType: 'image/png',
            content: PNG.toString('base64'),
            contentId: 'statement@acme',
          },
          {
            filename: 'terms.exe',
            contentType: 'application/x-msdownload',
            content: Buffer.from('MZ').toString('base64'),
          },
        ],
      };

      const first = await parse(message);
      expect(first).toEqual({ status: 200, body: { outcome: 'accepted' } });
      expect((await parse(message)).body).toEqual({ outcome: 'duplicate' });

      const row = await messageOf('first-1@acme.de');
      expect(row?.bodyHtml).toBe('<p>Hello</p>');
      const ticket = await ticketOf(row?.ticketId ?? '');
      expect(ticket).toMatchObject({
        channel: 'email',
        subject: 'Refund not received',
        departmentId: support,
      });

      // The thread's read: the card's facts, and no remote URL.
      const page = await call<TicketMessagePage>(
        'GET',
        `${brandPath()}/tickets/${ticket?.id}/messages`,
        ada,
      );
      const [shown] = page.body.messages;
      expect(shown?.email).toMatchObject({
        from: { address: from, name: 'Mona Khalil' },
        quotedHtml: expect.stringContaining('older text'),
        remoteImages: { count: 1, hosts: ['mail.acme.de'], policy: 'block' },
      });
      expect(JSON.stringify(page.body)).not.toContain('pixel.gif');
      expect(shown?.attachments.map((file) => [file.originalName, file.status])).toEqual([
        ['statement.png', 'pending'],
        ['terms.exe', 'rejected'],
      ]);
      expect(shown?.email?.inlineAttachmentIds).toEqual([shown?.attachments[0]?.id]);

      const stored = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ key: attachments.s3Key })
          .from(attachments)
          .where(eq(attachments.messageId, row?.id ?? '')),
      );
      expect(await storage.read(stored[0]?.key ?? '')).toEqual(PNG);

      // Karim is copied in; the brand's own mailbox is not.
      const ccs = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ address: ticketParticipants.address })
          .from(ticketParticipants)
          .where(eq(ticketParticipants.ticketId, ticket?.id ?? '')),
      );
      expect(ccs.map((cc) => cc.address)).toEqual(['karim@example.com']);

      const settings = await call<InboundParseSettings>('GET', `${brandPath()}/inbound-parse`, ada);
      expect(settings.body.lastRequest).toMatchObject({
        provider: 'generic',
        outcome: 'duplicate',
      });
      const list = await call<MailboxList>('GET', `${brandPath()}/mailboxes`, ada);
      expect(
        list.body.mailboxes.find((mailbox) => mailbox.address === 'hello@helpdock.test'),
      ).toMatchObject({
        inboundProvider: 'generic',
        health: { state: 'healthy' },
      });
    });

    it('loads a remote image through the proxy, re-encoded, for a reader of the ticket only', async () => {
      const row = await messageOf('first-1@acme.de');
      const url = `${brandPath()}/tickets/${row?.ticketId}/messages/${row?.id}/remote-images/0`;

      const image = await call('GET', url, ada);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/webp');
      expect(image.headers['cache-control']).toBe('private, max-age=300');
      expect((await sharp(image.raw).metadata()).format).toBe('webp');
      expect(fetched).toContain('https://mail.acme.de/pixel.gif');

      expect((await call('GET', url.replace(/0$/, '1'), ada)).status).toBe(404);
      // Sam is an Agent of Support, where the ticket is; a stranger's token is refused outright.
      expect((await call('GET', url, sam)).status).toBe(200);
      expect((await call('GET', url, null)).status).toBe(401);
    });

    it('refuses a proxied answer that is not an image', async () => {
      await parse({
        from: { address: unique('page') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Page',
        html: '<p>x</p><img src="https://example.com/not-an-image">',
        messageId: '<not-image@example.com>',
      });
      const row = await messageOf('not-image@example.com');
      const response = await call(
        'GET',
        `${brandPath()}/tickets/${row?.ticketId}/messages/${row?.id}/remote-images/0`,
        ada,
      );
      expect(response.status).toBe(422);
    });

    it('threads a participant’s reply, and gives a stranger quoting the number a ticket of their own (§4.3)', async () => {
      const original = await messageOf('first-1@acme.de');
      const ticket = await ticketOf(original?.ticketId ?? '');
      const reference = `[HD-${String(ticket?.number)}]`;

      // The contact replies by In-Reply-To.
      const reply = await parse({
        from: {
          address:
            (
              await withSystem(runtime.db, seeded.brandId, (tx) =>
                tx
                  .select({ value: contactIdentities.value })
                  .from(contactIdentities)
                  .where(eq(contactIdentities.contactId, ticket?.contactId ?? '')),
              )
            )[0]?.value ?? '',
        },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Re: Refund not received',
        text: 'Any news?\n\nOn Tue, Helpdock wrote:\n> older',
        messageId: '<reply-1@acme.de>',
        inReplyTo: '<first-1@acme.de>',
      });
      expect(reply.body.outcome).toBe('accepted');
      const replied = await messageOf('reply-1@acme.de');
      expect(replied?.ticketId).toBe(ticket?.id);
      expect(replied?.bodyText).toBe('Any news?');

      // Karim, copied in, may reply by subject token alone.
      await parse({
        from: { address: 'karim@example.com' },
        to: [{ address: 'hello@helpdock.test' }],
        subject: `Re: ${reference} Refund`,
        text: 'I am on it too',
        messageId: '<karim-1@example.com>',
      });
      expect((await messageOf('karim-1@example.com'))?.ticketId).toBe(ticket?.id);

      // A stranger with the number and even the Message-ID does not get in.
      await parse({
        from: { address: unique('stranger') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: `Re: ${reference} give me the refund`,
        text: 'Send it to me instead',
        messageId: '<stranger-1@evil.example>',
        references: ['<first-1@acme.de>'],
      });
      const stranger = await messageOf('stranger-1@evil.example');
      expect(stranger?.ticketId).not.toBe(ticket?.id);
      const separate = await ticketOf(stranger?.ticketId ?? '');
      expect(separate?.departmentId).toBe(ticket?.departmentId);

      const page = await call<TicketMessagePage>(
        'GET',
        `${brandPath()}/tickets/${separate?.id}/messages`,
        ada,
      );
      const note = page.body.messages.find((message) => message.kind === 'system');
      expect(note?.bodyText).toBe(
        `Referenced HD-${String(ticket?.number)} but sender is not a participant`,
      );
      expect(note?.email?.mismatch).toEqual({
        ticketId: ticket?.id,
        reference: `HD-${String(ticket?.number)}`,
      });

      // The original thread never saw the stranger's words.
      const original_ = await call<TicketMessagePage>(
        'GET',
        `${brandPath()}/tickets/${ticket?.id}/messages`,
        ada,
      );
      expect(JSON.stringify(original_.body)).not.toContain('Send it to me instead');
    });

    it('follows a merged ticket to its primary', async () => {
      const from = unique('merge');
      await parse({
        from: { address: from },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'A',
        text: 'a',
        messageId: '<merge-a@x>',
      });
      await parse({
        from: { address: unique('other') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'B',
        text: 'b',
        messageId: '<merge-b@x>',
      });
      const secondary = await messageOf('merge-a@x');
      const primary = await messageOf('merge-b@x');
      const merged = await call(
        'POST',
        `${brandPath()}/tickets/${secondary?.ticketId}/merge`,
        ada,
        {
          primaryTicketId: primary?.ticketId,
        },
      );
      expect(merged.status).toBe(200);

      await parse({
        from: { address: from },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Re: A',
        text: 'again',
        messageId: '<merge-c@x>',
        inReplyTo: '<merge-a@x>',
      });
      // The secondary's contact is a CC of the primary after a merge (§2.4), so it threads there.
      expect((await messageOf('merge-c@x'))?.ticketId).toBe(primary?.ticketId);
    });

    it('drops automated mail unless the mailbox allow-lists the sender, and blocked senders', async () => {
      const auto = await parse({
        from: { address: 'noreply@shop.example' },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Your order',
        text: 'Thanks',
      });
      expect(auto.body.outcome).toBe('ignored');

      const bulk = await parse({
        from: { address: unique('news') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'News',
        text: 'News',
        headers: { Precedence: 'bulk' },
      });
      expect(bulk.body.outcome).toBe('ignored');

      const hello = (
        await call<MailboxList>('GET', `${brandPath()}/mailboxes`, ada)
      ).body.mailboxes.find((mailbox) => mailbox.address === 'hello@helpdock.test');
      await call('PUT', `${brandPath()}/mailboxes/${hello?.id}`, ada, {
        address: 'hello@helpdock.test',
        displayName: 'Hello',
        departmentId: support,
        method: 'inbound_parse',
        remoteImages: 'proxy',
        authFailureIsSpam: true,
        automatedAllowlist: ['alerts@statuspage.io'],
      });
      const allowed = await parse({
        from: { address: 'alerts@statuspage.io' },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Incident',
        text: 'Down',
        headers: { 'Auto-Submitted': 'auto-generated' },
        messageId: '<incident@statuspage.io>',
      });
      expect(allowed.body.outcome).toBe('accepted');

      const blocked = 'blocked@promo-deals.biz';
      const block = await call('POST', `${brandPath()}/blocked-senders`, ada, {
        kind: 'email',
        value: blocked,
      });
      expect(block.status).toBe(201);
      expect(
        (
          await parse({
            from: { address: blocked },
            to: [{ address: 'hello@helpdock.test' }],
            subject: 'x',
            text: 'x',
          })
        ).body.outcome,
      ).toBe('ignored');
    });

    it('files a message that failed SPF under Spam when the mailbox says so (M2-07)', async () => {
      await parse({
        from: { address: unique('spoof') },
        to: [{ address: 'hello@helpdock.test' }],
        subject: 'Invoice',
        text: 'Pay here',
        messageId: '<spoof@evil.example>',
        headers: {
          'Authentication-Results': 'mx.helpdock.test; spf=fail smtp.mailfrom=evil.example',
        },
      });
      const row = await messageOf('spoof@evil.example');
      const status = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const [found] = await tx
          .select({ isSpam: ticketStatuses.isSpam })
          .from(tickets)
          .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
          .where(eq(tickets.id, row?.ticketId ?? ''));
        return found;
      });
      expect(status?.isSpam).toBe(true);
    });

    it('parses SendGrid’s multipart form and Postmark’s JSON through the same pipeline', async () => {
      const raw = [
        `From: ${unique('grid')}`,
        'To: hello@helpdock.test',
        'Subject: Via SendGrid',
        'Message-ID: <sendgrid-1@example.com>',
        '',
        'Raw body',
        '',
      ].join('\r\n');
      const form = new FormData();
      form.set('email', raw);
      form.set('envelope', JSON.stringify({ to: ['hello@helpdock.test'] }));
      const encoded = new Response(form);
      const sendgrid = await app.inject({
        method: 'POST',
        url: '/internal/inbound-parse/sendgrid',
        headers: {
          'content-type': encoded.headers.get('content-type') ?? '',
          'x-helpdock-inbound-secret': secret,
        },
        payload: Buffer.from(await encoded.arrayBuffer()),
      });
      expect(sendgrid.statusCode).toBe(200);
      expect((await messageOf('sendgrid-1@example.com'))?.bodyText).toBe('Raw body');

      const postmark = await parse(
        {
          FromFull: { Email: unique('mark'), Name: 'Mark' },
          ToFull: [{ Email: 'hello@helpdock.test' }],
          Subject: 'Via Postmark',
          TextBody: 'Postmark body',
          Headers: [{ Name: 'Message-ID', Value: '<postmark-1@example.com>' }],
        },
        { provider: 'postmark' },
      );
      expect(postmark.body.outcome).toBe('accepted');

      // Mailgun's url-encoded form.
      const mailgun = await app.inject({
        method: 'POST',
        url: '/internal/inbound-parse/mailgun',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-helpdock-inbound-secret': secret,
        },
        payload: new URLSearchParams({
          sender: unique('gun'),
          recipient: 'hello@helpdock.test',
          subject: 'Via Mailgun',
          'body-plain': 'Mailgun body',
          'Message-Id': '<mailgun-1@example.com>',
        }).toString(),
      });
      expect(mailgun.statusCode).toBe(200);
      expect((await messageOf('mailgun-1@example.com'))?.bodyText).toBe('Mailgun body');

      // Multipart bodies are for these routes only.
      const elsewhere = await app.inject({
        method: 'POST',
        url: `${brandPath()}/mailboxes`,
        headers: {
          'content-type': encoded.headers.get('content-type') ?? '',
          authorization: `Bearer ${ada.token}`,
        },
        payload: Buffer.from('--x--'),
      });
      expect(elsewhere.statusCode).toBe(415);
    });
  });

  // ---------------------------------------------------------------- polling

  describe('IMAP polling (M2-02)', () => {
    const repository = new MailboxesRepository();

    const poller = () =>
      createEmailPollProcessor({
        db: runtime.db,
        log: silentLogger,
        keyring: createKeyring(envFor()),
        repository,
        inbound: createInboundEmailService({ db: runtime.db, storage, log: silentLogger }),
        imap: TEST_IMAP,
      });

    const deliver = async (subject: string, from: string): Promise<void> => {
      const transport = nodemailer.createTransport({
        host: greenmail.getHost(),
        port: greenmail.getMappedPort(SMTP_PORT),
        secure: false,
        ignoreTLS: true,
      });
      await transport.sendMail({
        from,
        to: 'desk@helpdock.test',
        subject,
        text: `Body of ${subject}`,
      });
      transport.close();
    };

    it('polls new mail into tickets and records the mailbox healthy', async () => {
      const mailbox = await createMailbox({
        address: 'desk@helpdock.test',
        method: 'imap',
        imap: {
          host: greenmail.getHost(),
          port: greenmail.getMappedPort(IMAPS_PORT),
          security: 'tls',
          username: 'desk',
          password: 'desk-password',
        },
      });
      const from = unique('imap');
      await deliver('Printer on fire', from);

      await poller()({ data: { brandId: seeded.brandId, mailboxId: mailbox.body.id } });

      const created = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ subject: tickets.subject })
          .from(tickets)
          .innerJoin(contacts, eq(contacts.id, tickets.contactId))
          .where(and(eq(tickets.channel, 'email'), eq(contacts.name, from)))
          .orderBy(desc(tickets.createdAt)),
      );
      expect(created.map((row) => row.subject)).toEqual(['Printer on fire']);

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(mailboxes).where(eq(mailboxes.id, mailbox.body.id)),
      );
      expect(row?.imapLastUid).not.toBeNull();
      expect(row?.lastSuccessAt).not.toBeNull();
      expect(row?.lastError).toBeNull();

      // A second tick finds nothing new.
      await poller()({ data: { brandId: seeded.brandId, mailboxId: mailbox.body.id } });
      const again = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ id: tickets.id })
          .from(tickets)
          .innerJoin(contacts, eq(contacts.id, tickets.contactId))
          .where(eq(contacts.name, from)),
      );
      expect(again).toHaveLength(1);
    });

    it('records a refused sign-in as the mailbox’s health, and does nothing for a mailbox that is gone', async () => {
      const mailbox = await createMailbox({
        address: unique('wrong'),
        method: 'imap',
        imap: {
          host: greenmail.getHost(),
          port: greenmail.getMappedPort(IMAPS_PORT),
          security: 'tls',
          username: 'desk',
          password: 'not-the-password',
        },
      });

      await poller()({ data: { brandId: seeded.brandId, mailboxId: mailbox.body.id } });

      const read = await call<Mailbox>('GET', `${brandPath()}/mailboxes/${mailbox.body.id}`, ada);
      expect(read.body.health).toMatchObject({ state: 'failing', lastErrorKind: 'auth' });

      await expect(
        poller()({ data: { brandId: seeded.brandId, mailboxId: uuidv7() } }),
      ).resolves.toBeUndefined();
    });

    it('schedules every IMAP mailbox on boot, and follows mailbox.changed', async () => {
      const upserted: string[] = [];
      const removed: string[] = [];
      const scheduler: PollScheduler = {
        upsert: async (mailbox) => {
          await Promise.resolve();
          upserted.push(mailbox.id);
        },
        remove: async (id) => {
          await Promise.resolve();
          removed.push(id);
        },
      };

      const count = await scheduleAllPollers(runtime.db, repository, scheduler);
      const imap = (
        await call<MailboxList>('GET', `${brandPath()}/mailboxes`, ada)
      ).body.mailboxes.filter((mailbox) => mailbox.method === 'imap');
      expect(count).toBe(imap.length);
      expect(new Set(upserted)).toEqual(new Set(imap.map((mailbox) => mailbox.id)));

      const handler = createMailboxChangedHandler(repository, scheduler);
      const inbound = (
        await call<MailboxList>('GET', `${brandPath()}/mailboxes`, ada)
      ).body.mailboxes.find((mailbox) => mailbox.method === 'inbound_parse');
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        handler({
          tx,
          brandId: seeded.brandId,
          outboxId: uuidv7(),
          event: 'mailbox.changed',
          payload: { mailboxId: inbound?.id ?? '' },
          log: silentLogger,
        }),
      );
      expect(removed).toEqual([inbound?.id]);

      upserted.length = 0;
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        handler({
          tx,
          brandId: seeded.brandId,
          outboxId: uuidv7(),
          event: 'mailbox.changed',
          payload: { mailboxId: imap[0]?.id ?? '' },
          log: silentLogger,
        }),
      );
      expect(upserted).toEqual([imap[0]?.id]);
    });
  });
});
