import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  cannedResponses,
  createDb,
  type Db,
  type DbHandle,
  outbox,
  ticketActivity,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type {
  ContactDetail,
  DepartmentSummary,
  Macro,
  MacroList,
  MacroRunResponse,
  RenderedMacro,
  TagSummary,
  TicketDetail,
  TicketStatusList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { CannedResponsesService } from './canned-responses.service.js';

/**
 * M3-06 against a real Postgres, over real sessions.
 *
 * 1. **A personal item is its owner's alone**, by the owner policy.
 * 2. **A shared item follows DOMAIN-RULES §1.2**: an Agent cannot share, and an
 *    item shared with Billing is not offered on a Support ticket.
 * 3. **Rendering fills the placeholders** from the ticket, in the contact's
 *    language, falling back to English when the variant is empty.
 * 4. **Applying a macro is one transaction and one activity entry**, and an
 *    action the macro does not have is refused.
 * 5. **Every audit row a request writes says where it came from.**
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M3-06 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: { readonly ticketing?: { readonly reason: string } };
}

describe.skipIf(!hasDocker)('macros and canned responses', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** The install admin, whose department scope is `all`. */
  let ada: Person;
  /** An Agent of Support. */
  let sam: Person;
  /** A Team Leader who leads Billing and nothing else. */
  let tia: Person;

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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
          'user-agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) Firefox/130.0',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = () => `/api/brands/${seeded.brandId}`;

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const addPerson = async (db: Db, who: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }

    const id = uuidv7();
    const email = `${who.toLowerCase().replaceAll(' ', '.')}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name: who,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });

    return { id, email, token: '' };
  };

  const addDepartment = async (name: string): Promise<string> => {
    const response = await call<DepartmentSummary>('POST', `${brandPath()}/departments`, ada, {
      name,
    });
    expect(response.status).toBe(201);

    return response.body.id;
  };

  const createTicket = async (departmentId: string, contactId?: string): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'International shipping fees',
      bodyHtml: '<p>Why was I charged on delivery?</p>',
      departmentId,
      ...(contactId === undefined ? {} : { contactId }),
    });
    expect(response.status).toBe(201);

    return response.body;
  };

  const createMacro = async (who: Person, body: unknown): Promise<Macro> => {
    const response = await call<Macro>('POST', `${brandPath()}/macros`, who, body);
    expect(response.status).toBe(201);

    return response.body;
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
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    ada.token = await signIn(seeded.email, seeded.password);

    support = await addDepartment('Support');
    billing = await addDepartment('Billing');

    sam = await addPerson(runtime.db, 'Sam Agent');
    tia = await addPerson(runtime.db, 'Tia Leader');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: tia.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [billing] },
      ]),
    );
    sam.token = await signIn(sam.email, STAFF_PASSWORD);
    tia.token = await signIn(tia.email, STAFF_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('scope', () => {
    it('keeps a personal canned response its owner’s alone, an Admin included', async () => {
      const mine = await createMacro(sam, {
        kind: 'canned',
        name: 'My follow-up line',
        scope: 'personal',
        bodies: { en: 'Talk soon', ar: '' },
      });

      const own = await call<MacroList>('GET', `${brandPath()}/macros`, sam);
      expect(own.body.macros.map((macro) => macro.id)).toContain(mine.id);

      const admins = await call<MacroList>('GET', `${brandPath()}/macros`, ada);
      expect(admins.body.macros.map((macro) => macro.id)).not.toContain(mine.id);
      expect(
        (await call('PATCH', `${brandPath()}/macros/${mine.id}`, ada, { name: 'Taken' })).status,
      ).toBe(404);
    });

    it('refuses an Agent a shared item, and a Team Leader one outside Billing', async () => {
      const shared = {
        kind: 'canned',
        name: 'Shared',
        scope: 'shared',
        bodies: { en: 'Hi', ar: '' },
      };

      const agent = await call<Refusal>('POST', `${brandPath()}/macros`, sam, shared);
      expect(agent.status).toBe(403);
      expect(agent.body.error.ticketing?.reason).toBe('out-of-scope');

      const outside = await call<Refusal>('POST', `${brandPath()}/macros`, tia, {
        ...shared,
        departmentId: support,
      });
      expect(outside.status).toBe(403);

      await createMacro(tia, { ...shared, departmentId: billing });
    });
  });

  describe('filling one in and applying it', () => {
    let refund: Macro;
    let ticket: TicketDetail;
    let awaiting: string;
    let refundTag: string;

    beforeAll(async () => {
      const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
      awaiting =
        statuses.body.statuses.find((status) => status.awaitingCustomer)?.id ??
        statuses.body.statuses[0]?.id ??
        '';
      const tag = await call<TagSummary>('POST', `${brandPath()}/tags`, ada, {
        name: 'refund-issued',
      });
      refundTag = tag.body.id;

      const contact = await call<ContactDetail>('POST', `${brandPath()}/contacts`, ada, {
        name: 'Sara Mansour',
        locale: 'ar',
        identities: [{ kind: 'email', value: 'sara.m@example.com' }],
      });
      expect(contact.status).toBe(201);

      ticket = await createTicket(billing, contact.body.id);
      refund = await createMacro(ada, {
        kind: 'macro',
        name: 'Refund issued',
        scope: 'shared',
        departmentId: billing,
        bodies: {
          en: 'Hi {{contact.first_name}}, we refunded {{ticket.number}}. {{agent.first_name}}, {{brand.name}}',
          ar: '',
        },
        actions: [
          { type: 'set_status', statusId: awaiting },
          { type: 'set_priority', priority: 'high' },
          { type: 'add_tag', tagId: refundTag },
          { type: 'assign', assignee: { kind: 'self' } },
        ],
      });
    });

    it('fills the placeholders for the ticket, falling back to English for an empty Arabic variant', async () => {
      const rendered = await call<RenderedMacro>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}/macros/${refund.id}/render`,
        ada,
      );

      expect(rendered.status).toBe(200);
      expect(rendered.body).toMatchObject({
        locale: 'en',
        fellBack: true,
        text: `Hi Sara, we refunded HD-${String(ticket.ticket.number)}. Dev, Helpdock Dev`,
        unknownPlaceholders: [],
      });
      expect(rendered.body.segments.filter((segment) => segment.placeholder !== null)).toHaveLength(
        4,
      );
    });

    it('answers in the contact’s language when that variant has text', async () => {
      await call('PATCH', `${brandPath()}/macros/${refund.id}`, ada, {
        bodies: { en: refund.bodies.en, ar: 'مرحباً {{contact.first_name}}' },
      });

      const rendered = await call<RenderedMacro>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}/macros/${refund.id}/render`,
        ada,
      );

      expect(rendered.body).toMatchObject({ locale: 'ar', fellBack: false, text: 'مرحباً Sara' });
    });

    it('is the seam the rules engine calls, signed by the assignee when nobody is sending', async () => {
      const canned = app.get(CannedResponsesService);
      const rendered = await withSystem(runtime.db, seeded.brandId, (tx) =>
        canned.render(refund.id, { locale: 'en', ticket: { id: ticket.ticket.id }, tx }),
      );

      // The ticket has no assignee yet, so the sender stays spelled out.
      expect(rendered.text).toContain('{{agent.first_name}}');
      expect(rendered.unknownPlaceholders).toEqual(['agent.first_name']);
    });

    it('is not offered on a ticket of a department it is not shared with', async () => {
      const elsewhere = await createTicket(support);

      const response = await call(
        'GET',
        `${brandPath()}/tickets/${elsewhere.ticket.id}/macros/${refund.id}/render`,
        ada,
      );
      expect(response.status).toBe(404);
    });

    it('refuses an action the macro does not have', async () => {
      const response = await call<Refusal>(
        'POST',
        `${brandPath()}/tickets/${ticket.ticket.id}/macro-runs`,
        ada,
        { macroId: refund.id, actions: [{ type: 'set_priority', priority: 'low' }] },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.ticketing?.reason).toBe('macro-changed');
    });

    it('runs the reply and the kept actions in one go, as one activity entry', async () => {
      const response = await call<MacroRunResponse>(
        'POST',
        `${brandPath()}/tickets/${ticket.ticket.id}/macro-runs`,
        ada,
        {
          macroId: refund.id,
          // The agent removed the priority chip before sending.
          actions: refund.actions.filter((action) => action.type !== 'set_priority'),
          reply: { kind: 'public', bodyHtml: '<p>We refunded it.</p>', clientId: uuidv7() },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.message?.bodyText).toBe('We refunded it.');

      const after = await call<TicketDetail>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}`,
        ada,
      );
      expect(after.body.ticket).toMatchObject({
        assigneeId: ada.id,
        priority: ticket.ticket.priority,
      });
      expect(after.body.ticket.status.id).toBe(awaiting);
      expect((after.body.ticket.tags ?? []).map((tag) => tag.id)).toContain(refundTag);

      const activity = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ action: ticketActivity.action, to: ticketActivity.to })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, ticket.ticket.id)),
      );
      const actions = activity.map((row) => row.action);
      expect(actions.filter((action) => action === 'ticket.macro_applied')).toHaveLength(1);
      expect(actions).not.toContain('ticket.updated');
      expect(actions).not.toContain('ticket.tags.changed');
      // M3-07: an assign action tells the assignee, by the person who ran it.
      const assigned = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(
            sql`${outbox.event} = 'ticket.assigned' AND ${outbox.payload}->>'ticketId' = ${ticket.ticket.id}`,
          ),
      );
      expect(assigned.map((row) => row.payload)).toEqual([
        expect.objectContaining({ assigneeId: ada.id, assignedBy: 'person', actorId: ada.id }),
      ]);
      expect(activity.find((row) => row.action === 'ticket.macro_applied')?.to).toMatchObject({
        macroName: 'Refund issued',
        assigneeId: ada.id,
        // No `statusId`: the public reply itself already moved the ticket to
        // Awaiting customer (DOMAIN-RULES §2.2 row 2), so the macro's own
        // status action had nothing left to change.
        tagIds: [refundTag],
        messageId: response.body.message?.id,
      });

      const [used] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ lastUsedAt: cannedResponses.lastUsedAt })
          .from(cannedResponses)
          .where(eq(cannedResponses.id, refund.id)),
      );
      expect(used?.lastUsedAt).not.toBeNull();
    });

    it('runs at once without a reply, and records the status it moved', async () => {
      const quiet = await createTicket(billing);

      const response = await call<MacroRunResponse>(
        'POST',
        `${brandPath()}/tickets/${quiet.ticket.id}/macro-runs`,
        ada,
        { macroId: refund.id, actions: [{ type: 'set_status', statusId: awaiting }] },
      );
      expect(response.body.message).toBeNull();

      const [entry] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ from: ticketActivity.from, to: ticketActivity.to })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, quiet.ticket.id))
          .orderBy(sql`${ticketActivity.createdAt} DESC`)
          .limit(1),
      );
      expect(entry).toMatchObject({
        from: { statusId: quiet.ticket.status.id },
        to: { statusId: awaiting, macroName: 'Refund issued' },
      });
    });

    it('refuses the whole run, reply included, when an action is refused', async () => {
      const handOff = await createMacro(ada, {
        kind: 'macro',
        name: 'Hand to Sam',
        scope: 'shared',
        departmentId: billing,
        bodies: { en: '', ar: '' },
        // Sam works Support, so he cannot hold a Billing ticket.
        actions: [{ type: 'assign', assignee: { kind: 'user', userId: sam.id } }],
      });
      const before = await call<TicketDetail>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}`,
        ada,
      );

      const response = await call(
        'POST',
        `${brandPath()}/tickets/${ticket.ticket.id}/macro-runs`,
        ada,
        {
          macroId: handOff.id,
          actions: handOff.actions,
          reply: { kind: 'public', bodyHtml: '<p>Passing you on.</p>', clientId: uuidv7() },
        },
      );
      expect(response.status).toBeGreaterThanOrEqual(400);

      const after = await call<TicketDetail>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}`,
        ada,
      );
      expect(after.body.messages.messages).toHaveLength(before.body.messages.messages.length);
    });
  });

  describe('the audit trail', () => {
    it('records a shared change with where the request came from', async () => {
      const created = await createMacro(ada, {
        kind: 'canned',
        name: 'Audited',
        scope: 'shared',
        bodies: { en: 'Hi', ar: '' },
      });

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({
            action: auditLog.action,
            ip: auditLog.ip,
            requestId: auditLog.requestId,
            userAgent: auditLog.userAgent,
          })
          .from(auditLog)
          .where(eq(auditLog.targetId, created.id)),
      );

      expect(row).toMatchObject({ action: 'macro.created', ip: '127.0.0.1' });
      expect(row?.requestId).toMatch(/.+/);
      expect(row?.userAgent).toContain('Firefox');
    });
  });
});
