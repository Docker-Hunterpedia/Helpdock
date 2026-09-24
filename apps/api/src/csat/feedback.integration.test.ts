import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKeyring, decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  contacts,
  createDb,
  csatResponses,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketTimeEntries,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { outboxEvents, silentLogger } from '@helpdock/jobs';
import type {
  BrandSettings,
  ContactDetail,
  CsatSurveyView,
  TicketDetail,
  TicketMessage,
  TicketStatusList,
  TimeEntryList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { RedisRealtimeBroadcast } from '../realtime/broadcast.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { registerTicketEventHandlers } from '../tickets/ticket-events.js';
import { CsatRepository } from './csat.repository.js';
import { CSAT_PUBLIC_RULE } from './csat.service.js';
import { CSAT_EVENTS, registerCsatEventHandlers } from './csat-events.js';
import { CsatTokens } from './tokens.js';

/**
 * M1-12 against a real Postgres and a real Redis, over real sessions.
 *
 * What only the pieces together can prove:
 *
 * 1. **Time tracking follows the ticket's scope.** An Agent of another
 *    department cannot read or log time on a ticket, the entries move with the
 *    ticket, a reply's timer commits with the reply, and the brand toggle
 *    refuses a manual entry.
 * 2. **A close becomes one survey, through the outbox.** The closing
 *    transaction writes `csat.requested`; the worker's handler creates the row
 *    once however often it runs; spam, a reopened ticket and a brand with CSAT
 *    off get none (DOMAIN-RULES §2.2).
 * 3. **The link is single-use, signed and expiring** (DOMAIN-RULES §4.6), over
 *    the public routes, with an audit row per use.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 33).toString('base64');
const PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;
const APP_URL = 'https://support.example.com';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the feedback integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('time tracking and CSAT', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let worker: Redis;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** Agent in Support. */
  let sam: Person;
  /** Agent in Billing. */
  let bo: Person;
  /** Team Leader, every department. */
  let tia: Person;
  /** The install admin, an Admin of the brand. */
  let ada: Person;

  let openStatus: string;
  let closedStatus: string;
  let spamStatus: string;

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
    }) as Env;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    who: Person | null,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = () => `/api/brands/${seeded.brandId}`;
  const ticketPath = (ticketId: string) => `${brandPath()}/tickets/${ticketId}`;
  const timePath = (ticketId: string) => `${ticketPath(ticketId)}/time-entries`;
  const publicPath = (token: string) => `/api/public/csat/${token}`;

  const signIn = async (email: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email,
        password: email === seeded.email ? seeded.password : PASSWORD,
      }),
    });
    const body = response.json() as { kind: string; accessToken?: string };
    if (body.kind !== 'session' || body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }

    return body.accessToken;
  };

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
      name,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });

    return { id, email, token: '' };
  };

  const createTicket = async (body: Record<string, unknown> = {}): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, sam, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });
    expect(response.status).toBe(201);

    return response.body;
  };

  const setStatus = async (ticketId: string, statusId: string): Promise<void> => {
    const response = await call('PATCH', ticketPath(ticketId), ada, { statusId });
    expect(response.status).toBe(200);
  };

  const setFeedback = async (changes: Partial<BrandSettings>): Promise<void> => {
    const response = await call('PATCH', `${brandPath()}/ticketing/feedback`, tia, changes);
    expect(response.status).toBe(200);
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

  const surveysOf = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(csatResponses).where(eq(csatResponses.ticketId, ticketId)),
    );

  /** Closes a ticket and runs the survey job; returns the link the agent sees. */
  const closeAndSurvey = async (ticketId: string): Promise<string> => {
    await setStatus(ticketId, closedStatus);
    await drainOutbox();
    const detail = await call<TicketDetail>('GET', ticketPath(ticketId), sam);
    const link = detail.body.csat?.link;
    if (link === null || link === undefined) {
      throw new Error(`no survey link on ${ticketId}`);
    }

    return new URL(link).pathname.replace('/csat/', '');
  };

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
    app = await createApiApp({ runtime });

    // The worker's handlers, registered in this process as start-up does.
    worker = new Redis(redisContainer.getConnectionUrl());
    registerTicketEventHandlers(new RedisRealtimeBroadcast(worker));
    registerCsatEventHandlers({
      repository: new CsatRepository(),
      tokens: new CsatTokens(createKeyring(envFor())),
    });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    const db = runtime.db;
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(db, 'sam');
    bo = await addPerson(db, 'bo');
    tia = await addPerson(db, 'tia');

    await withSystem(db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
        { userId: tia.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: null },
      ]);
    });

    for (const person of [ada, sam, bo, tia]) {
      person.token = await signIn(person.email);
    }

    const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
    const named = (name: string) =>
      statuses.body.statuses.find((status) => status.name === name)?.id ?? '';
    openStatus = named('Open');
    closedStatus = named('Closed');
    spamStatus = named('Spam');
  }, 300_000);

  afterAll(async () => {
    await worker?.quit();
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------- settings

  describe('the Feedback tab', () => {
    it('starts with CSAT on and time tracking off', async () => {
      const { body } = await call<{ settings: BrandSettings }>('GET', brandPath(), ada);

      expect(body.settings).toMatchObject({
        csatEnabled: true,
        timeTrackingEnabled: false,
        timerStartsWithComposer: false,
      });
    });

    it('is a Team Leader’s to change, and never an Agent’s', async () => {
      const refused = await call('PATCH', `${brandPath()}/ticketing/feedback`, sam, {
        timeTrackingEnabled: true,
      });
      const accepted = await call<BrandSettings>(
        'PATCH',
        `${brandPath()}/ticketing/feedback`,
        tia,
        {
          timerStartsWithComposer: true,
        },
      );

      expect(refused.status).toBe(403);
      expect(accepted.status).toBe(200);
      // Merged, not replaced: the reply behaviour is untouched.
      expect(accepted.body).toMatchObject({
        timerStartsWithComposer: true,
        autoAwaitOnAgentReply: true,
      });
    });
  });

  // -------------------------------------------------------- time tracking

  describe('time tracking', () => {
    it('refuses a manual entry while the brand has it off', async () => {
      await setFeedback({ timeTrackingEnabled: false });
      const { ticket } = await createTicket();

      const response = await call<{ error: { ticketing?: { reason: string } } }>(
        'POST',
        timePath(ticket.id),
        sam,
        { seconds: 1800 },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.ticketing?.reason).toBe('time-tracking-off');
    });

    it('sends the reply and drops its timer while the brand has it off', async () => {
      await setFeedback({ timeTrackingEnabled: false });
      const { ticket } = await createTicket();

      const reply = await call('POST', `${ticketPath(ticket.id)}/messages`, sam, {
        kind: 'public',
        bodyHtml: '<p>On it.</p>',
        timeSpentSeconds: 600,
      });
      const list = await call<TimeEntryList>('GET', timePath(ticket.id), sam);

      expect(reply.status).toBe(201);
      expect(list.body).toEqual({ entries: [], totalSeconds: 0 });
    });

    describe('with the brand’s tracking on', () => {
      beforeEach(async () => {
        await setFeedback({ timeTrackingEnabled: true });
      });

      it('logs a manual entry and a reply’s timer, and totals both', async () => {
        const { ticket } = await createTicket();

        const logged = await call<TimeEntryList>('POST', timePath(ticket.id), sam, {
          seconds: 1800,
          note: 'Called the carrier',
        });
        const reply = await call<TicketMessage>('POST', `${ticketPath(ticket.id)}/messages`, sam, {
          kind: 'public',
          bodyHtml: '<p>Refund sent.</p>',
          timeSpentSeconds: 2700,
        });
        const list = await call<TimeEntryList>('GET', timePath(ticket.id), sam);

        expect(logged.status).toBe(201);
        expect(list.body.totalSeconds).toBe(4500);
        expect(list.body.entries).toEqual([
          expect.objectContaining({ seconds: 2700, messageId: reply.body.id, userName: 'sam' }),
          expect.objectContaining({ seconds: 1800, note: 'Called the carrier', messageId: null }),
        ]);
      });

      it('rolls the timer back with a reply that fails', async () => {
        const { ticket } = await createTicket();

        const reply = await call('POST', `${ticketPath(ticket.id)}/messages`, sam, {
          kind: 'public',
          bodyHtml: '<p>With a file that is not there.</p>',
          attachmentIds: [uuidv7()],
          timeSpentSeconds: 60,
        });
        const list = await call<TimeEntryList>('GET', timePath(ticket.id), sam);

        expect(reply.status).toBe(404);
        expect(list.body.totalSeconds).toBe(0);
      });

      it('hides a ticket’s time from an Agent of another department, and refuses them a write', async () => {
        const { ticket } = await createTicket();
        await call('POST', timePath(ticket.id), sam, { seconds: 300 });

        const read = await call('GET', timePath(ticket.id), bo);
        const write = await call('POST', timePath(ticket.id), bo, { seconds: 300 });
        const raw = await withTenant(
          runtime.db,
          {
            brandIds: [seeded.brandId],
            departmentIds: [billing],
            principalType: 'staff',
            principalId: bo.id,
          },
          (tx) =>
            tx.select().from(ticketTimeEntries).where(eq(ticketTimeEntries.ticketId, ticket.id)),
        );

        expect(read.status).toBe(404);
        expect(write.status).toBe(404);
        expect(raw).toEqual([]);
      });

      it('moves a ticket’s time with the ticket', async () => {
        const { ticket } = await createTicket();
        await call('POST', timePath(ticket.id), sam, { seconds: 300 });

        await call('PATCH', ticketPath(ticket.id), ada, { departmentId: billing });
        const list = await call<TimeEntryList>('GET', timePath(ticket.id), bo);

        expect(list.body.totalSeconds).toBe(300);
      });

      it('lets an Agent delete their own entry and nobody else’s', async () => {
        const { ticket } = await createTicket();
        const mine = await call<TimeEntryList>('POST', timePath(ticket.id), sam, { seconds: 120 });
        const theirs = await call<TimeEntryList>('POST', timePath(ticket.id), ada, {
          seconds: 240,
        });
        const mineId = mine.body.entries[0]?.id ?? '';
        const theirsId = theirs.body.entries.find((entry) => entry.seconds === 240)?.id ?? '';

        const refused = await call('DELETE', `${timePath(ticket.id)}/${theirsId}`, sam);
        const own = await call<TimeEntryList>('DELETE', `${timePath(ticket.id)}/${mineId}`, sam);

        expect(refused.status).toBe(403);
        expect(own.status).toBe(200);
        expect(own.body.totalSeconds).toBe(240);
      });

      it('lets a Team Leader delete anybody’s entry', async () => {
        const { ticket } = await createTicket();
        const logged = await call<TimeEntryList>('POST', timePath(ticket.id), sam, { seconds: 90 });

        const removed = await call<TimeEntryList>(
          'DELETE',
          `${timePath(ticket.id)}/${logged.body.entries[0]?.id ?? ''}`,
          tia,
        );

        expect(removed.status).toBe(200);
        expect(removed.body.entries).toEqual([]);
      });

      it('answers 404 for an entry of another ticket', async () => {
        const first = await createTicket();
        const second = await createTicket();
        const logged = await call<TimeEntryList>('POST', timePath(first.ticket.id), sam, {
          seconds: 90,
        });

        const response = await call(
          'DELETE',
          `${timePath(second.ticket.id)}/${logged.body.entries[0]?.id ?? ''}`,
          sam,
        );

        expect(response.status).toBe(404);
      });
    });
  });

  // ----------------------------------------------------------------- CSAT

  describe('the survey', () => {
    beforeEach(async () => {
      await setFeedback({ csatEnabled: true });
      // Every public call below comes from the same address; the budget is
      // proved by its own test at the end.
      await new RateLimiter(worker).reset(CSAT_PUBLIC_RULE, '127.0.0.1');
    });

    it('creates one survey per close, through the outbox, however often the job runs', async () => {
      const { ticket } = await createTicket();
      await setStatus(ticket.id, closedStatus);

      const events = await drainOutbox();
      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(outbox).where(eq(outbox.event, CSAT_EVENTS.requested)).limit(1),
      );
      // A second delivery of the same event, past the receipt.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        outboxEvents.dispatch({
          outboxId: uuidv7(),
          brandId: seeded.brandId,
          event: CSAT_EVENTS.requested,
          payload: row?.payload ?? {},
          tx,
          log: silentLogger,
        }),
      );

      expect(events).toContain(CSAT_EVENTS.requested);
      expect(await surveysOf(ticket.id)).toHaveLength(1);
    });

    it('shows the agent a pending survey with the link to share', async () => {
      const { ticket } = await createTicket();
      await setStatus(ticket.id, closedStatus);
      await drainOutbox();

      const { body } = await call<TicketDetail>('GET', ticketPath(ticket.id), sam);

      expect(body.csat).toMatchObject({ state: 'pending', rating: null, ratedAt: null });
      expect(body.csat?.link).toMatch(
        new RegExp(`^${APP_URL}/csat/[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$`),
      );
    });

    it('stores a hash of the link and never the link', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);

      const [survey] = await surveysOf(ticket.id);

      expect(survey?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(survey)).not.toContain(token);
    });

    it('opens for the customer with the brand, the reference and the subject', async () => {
      const { ticket } = await createTicket({ subject: 'Invoice shows the wrong VAT number' });
      const token = await closeAndSurvey(ticket.id);

      const { status, body } = await call<CsatSurveyView>('GET', publicPath(token), null);

      expect(status).toBe(200);
      expect(body).toEqual({
        state: 'open',
        brand: { name: expect.any(String), locale: 'en', accent: null },
        ticket: {
          reference: `${ticket.prefix}-${String(ticket.number)}`,
          subject: 'Invoice shows the wrong VAT number',
        },
      });
    });

    it('takes one rating, answers "used" to the second, and keeps the first', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);

      const first = await call<CsatSurveyView>('POST', publicPath(token), null, {
        rating: 4,
        comment: 'Quick and kind.',
      });
      const second = await call<CsatSurveyView>('POST', publicPath(token), null, { rating: 1 });
      const reopened = await call<CsatSurveyView>('GET', publicPath(token), null);
      const detail = await call<TicketDetail>('GET', ticketPath(ticket.id), sam);

      expect(first.body).toMatchObject({ state: 'rated', rating: 4 });
      expect(second.body).toMatchObject({ state: 'used' });
      expect(reopened.body).toEqual({ state: 'used', brand: expect.any(Object) });
      expect(detail.body.csat).toMatchObject({
        state: 'rated',
        rating: 4,
        comment: 'Quick and kind.',
        link: null,
      });
    });

    it('audits every use of a link as the survey’s system principal', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);
      await call('GET', publicPath(token), null);
      await call('POST', publicPath(token), null, { rating: 5 });

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ action: auditLog.action, actorType: auditLog.actorType })
          .from(auditLog)
          .where(and(eq(auditLog.targetType, 'ticket'), eq(auditLog.targetId, ticket.id))),
      );

      expect(rows).toEqual(
        expect.arrayContaining([
          { action: 'csat.viewed', actorType: 'system' },
          { action: 'csat.rated', actorType: 'system' },
        ]),
      );
    });

    it('answers "expired" after thirty days, to a read and to a rating', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(csatResponses)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(csatResponses.ticketId, ticket.id)),
      );

      const read = await call<CsatSurveyView>('GET', publicPath(token), null);
      const rate = await call<CsatSurveyView>('POST', publicPath(token), null, { rating: 5 });
      const detail = await call<TicketDetail>('GET', ticketPath(ticket.id), sam);

      expect(read.body.state).toBe('expired');
      expect(rate.body.state).toBe('expired');
      expect(detail.body.csat).toMatchObject({ state: 'expired', rating: null, link: null });
    });

    it('refuses an altered token without saying whether the survey exists', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);
      const [ids = '', mac = ''] = token.split('.');
      const altered = `${ids}.${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;

      const forged = await call('GET', publicPath(altered), null);
      const malformed = await call('GET', publicPath('not-a-token'), null);

      expect(forged.status).toBe(404);
      expect(malformed.status).toBe(400);
    });

    it('answers a deleted ticket’s link as if it did not exist', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);

      await call('DELETE', ticketPath(ticket.id), ada);
      const response = await call('GET', publicPath(token), null);

      expect(response.status).toBe(404);
    });

    it('asks again after a reopen and a second close', async () => {
      const { ticket } = await createTicket();
      await closeAndSurvey(ticket.id);
      await setStatus(ticket.id, openStatus);

      const secondToken = await closeAndSurvey(ticket.id);

      expect(await surveysOf(ticket.id)).toHaveLength(2);
      expect((await call<CsatSurveyView>('GET', publicPath(secondToken), null)).body.state).toBe(
        'open',
      );
    });

    it('skips a close that was undone before the job ran', async () => {
      const { ticket } = await createTicket();
      await setStatus(ticket.id, closedStatus);
      await setStatus(ticket.id, openStatus);

      await drainOutbox();

      expect(await surveysOf(ticket.id)).toEqual([]);
    });

    it('never asks about spam', async () => {
      const { ticket } = await createTicket();
      await setStatus(ticket.id, spamStatus);

      const events = await drainOutbox();
      const detail = await call<TicketDetail>('GET', ticketPath(ticket.id), sam);

      expect(events).not.toContain(CSAT_EVENTS.requested);
      expect(detail.body.csat).toBeNull();
    });

    it('never asks while the brand has CSAT off', async () => {
      await setFeedback({ csatEnabled: false });
      const { ticket } = await createTicket();
      await setStatus(ticket.id, closedStatus);

      const events = await drainOutbox();

      expect(events).not.toContain(CSAT_EVENTS.requested);
      expect(await surveysOf(ticket.id)).toEqual([]);
    });

    it('hides a survey from an Agent of another department', async () => {
      const { ticket } = await createTicket();
      await closeAndSurvey(ticket.id);

      const rows = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: [billing],
          principalType: 'staff',
          principalId: bo.id,
        },
        (tx) => tx.select().from(csatResponses).where(eq(csatResponses.ticketId, ticket.id)),
      );

      expect(rows).toEqual([]);
    });

    it('gives the contact card the share of ratings that were 4 or 5', async () => {
      const contactId = uuidv7();
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.insert(contacts).values({ id: contactId, brandId: seeded.brandId, name: 'Mona Khalil' }),
      );
      for (const rating of [5, 2]) {
        const { ticket } = await createTicket({ contactId });
        const token = await closeAndSurvey(ticket.id);
        await call('POST', publicPath(token), null, { rating });
      }

      const { body } = await call<ContactDetail>(
        'GET',
        `${brandPath()}/contacts/${contactId}`,
        sam,
      );

      expect(body.stats.csat).toBe(50);
    });

    it('limits how often one address may use the public routes', async () => {
      const { ticket } = await createTicket();
      const token = await closeAndSurvey(ticket.id);

      const statuses: number[] = [];
      for (let attempt = 0; attempt <= CSAT_PUBLIC_RULE.limit; attempt += 1) {
        statuses.push((await call('GET', publicPath(token), null)).status);
      }

      expect(statuses.slice(0, CSAT_PUBLIC_RULE.limit).every((status) => status === 200)).toBe(
        true,
      );
      expect(statuses.at(-1)).toBe(429);
    });
  });
});
