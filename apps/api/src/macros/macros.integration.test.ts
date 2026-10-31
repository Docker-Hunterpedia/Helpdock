import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  brands,
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
import { dockerAvailable } from '../testing/docker-available.js';
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

const hasDocker = await dockerAvailable();

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

    it('refuses a macro that sets the Snoozed status: it needs a wake time (M14-02)', async () => {
      const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, ada);
      const snoozed = statuses.body.statuses.find((status) => status.isSnoozed === true);

      const refused = await call('POST', `${brandPath()}/macros`, ada, {
        kind: 'macro',
        name: 'Snooze by macro',
        scope: 'shared',
        departmentId: billing,
        bodies: { en: 'Hi', ar: '' },
        actions: [{ type: 'set_status', statusId: snoozed?.id }],
      });

      expect(refused.status).toBe(400);
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

    it('publishes status and assignment changes from a Reply and close macro', async () => {
      const fresh = await createTicket(billing);
      const statuses = await call<{ statuses: { id: string; systemState: string }[] }>(
        'GET',
        `${brandPath()}/ticket-statuses`,
        ada,
      );
      const closedStatus = statuses.body.statuses.find((row) => row.systemState === 'closed');
      if (closedStatus === undefined) throw new Error('Missing closed status');
      const macro = await createMacro(ada, {
        kind: 'macro',
        name: 'Reply and close',
        scope: 'shared',
        departmentId: billing,
        bodies: { en: 'Done', ar: '' },
        actions: [
          { type: 'set_status', statusId: closedStatus.id },
          { type: 'assign', assignee: { kind: 'self' } },
        ],
      });
      const response = await call<MacroRunResponse>(
        'POST',
        `${brandPath()}/tickets/${fresh.ticket.id}/macro-runs`,
        ada,
        {
          macroId: macro.id,
          actions: macro.actions,
          reply: { kind: 'public', bodyHtml: '<p>Done</p>', clientId: uuidv7() },
        },
      );
      expect(response.status).toBe(201);
      const events = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(outbox).where(sql`${outbox.payload}->>'ticketId' = ${fresh.ticket.id}`),
      );
      expect(
        events.filter(
          (row) =>
            row.event === 'ticket.status_changed' && row.payload.statusId === closedStatus.id,
        ),
      ).toHaveLength(1);
      expect(
        events.filter((row) => row.event === 'ticket.assigned').map((row) => row.payload),
      ).toEqual([expect.objectContaining({ assigneeId: ada.id, assignedBy: 'person' })]);
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

    it('snoozes by a preset the server resolves against the calendar (#368)', async () => {
      const later = await createMacro(ada, {
        kind: 'macro',
        name: 'Snooze it',
        scope: 'shared',
        departmentId: billing,
        bodies: { en: '', ar: '' },
        actions: [{ type: 'snooze', preset: 'in_1_hour' }],
      });
      const target = await createTicket(billing);

      const response = await call<MacroRunResponse>(
        'POST',
        `${brandPath()}/tickets/${target.ticket.id}/macro-runs`,
        ada,
        { macroId: later.id, actions: later.actions },
      );
      expect(response.status).toBe(201);
      expect(response.body.message).toBeNull();

      // The ticket is Snoozed about an hour ahead, and the person who applied
      // the macro is the one who snoozed it.
      const after = await call<TicketDetail>(
        'GET',
        `${brandPath()}/tickets/${target.ticket.id}`,
        ada,
      );
      expect(after.body.ticket.status.isSnoozed).toBe(true);
      const until = after.body.ticket.snoozedUntil;
      expect(until).not.toBeNull();
      const ahead = Date.parse(until ?? '') - Date.now();
      expect(ahead).toBeGreaterThan(55 * 60_000);
      expect(ahead).toBeLessThan(65 * 60_000);
      expect(after.body.ticket.snoozedBy).toBe(ada.id);

      // The activity is the snooze's own, beside the macro's one entry.
      const activity = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({
            action: ticketActivity.action,
            actorId: ticketActivity.actorId,
            to: ticketActivity.to,
          })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, target.ticket.id)),
      );
      expect(activity.filter((row) => row.action === 'ticket.macro_applied')).toHaveLength(1);
      expect(activity.find((row) => row.action === 'ticket.snoozed')).toMatchObject({
        actorId: ada.id,
        to: { snoozedUntil: until, resumeStatusId: expect.any(String) },
      });

      // And the wake timer's outbox row is the snooze's own.
      const snoozedEvents = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(
            sql`${outbox.event} = 'ticket.snoozed' AND ${outbox.payload}->>'ticketId' = ${target.ticket.id}`,
          ),
      );
      expect(snoozedEvents.map((row) => row.payload)).toEqual([
        expect.objectContaining({ ticketId: target.ticket.id, snoozedUntil: until }),
      ]);
    });

    it('resolves the time in the applying person’s profile zone, else the brand’s (#368)', async () => {
      const tomorrow = await createMacro(ada, {
        kind: 'macro',
        name: 'Snooze to tomorrow',
        scope: 'shared',
        departmentId: billing,
        bodies: { en: '', ar: '' },
        actions: [{ type: 'snooze', preset: 'next_business_day' }],
      });
      const localTime = (iso: string | null, timeZone: string): string =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(iso ?? ''));
      const applyAndRead = async (): Promise<string | null> => {
        const target = await createTicket(billing);
        const run = await call<MacroRunResponse>(
          'POST',
          `${brandPath()}/tickets/${target.ticket.id}/macro-runs`,
          ada,
          { macroId: tomorrow.id, actions: tomorrow.actions },
        );
        expect(run.status).toBe(201);
        const after = await call<TicketDetail>(
          'GET',
          `${brandPath()}/tickets/${target.ticket.id}`,
          ada,
        );
        return after.body.ticket.snoozedUntil ?? null;
      };
      const setZone = (timeZone: string | null) =>
        runtime.db.update(users).set({ timeZone }).where(eq(users.id, ada.id));

      // Billing has no hours of its own here, so the preset is 09:00 tomorrow in
      // the zone the person chose: 14 hours ahead of UTC, so not the brand's.
      await setZone('Pacific/Kiritimati');
      expect(localTime(await applyAndRead(), 'Pacific/Kiritimati')).toBe('09:00');

      // With no profile zone it is the brand's own, as the Snooze menu falls back.
      await setZone(null);
      const [brand] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select({ timezone: brands.timezone }).from(brands).where(eq(brands.id, seeded.brandId)),
      );
      expect(localTime(await applyAndRead(), brand?.timezone ?? 'UTC')).toBe('09:00');
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

  describe('shortcuts, fallbacks and use counts (M14-14)', () => {
    const fees = {
      kind: 'canned',
      name: 'Fees',
      scope: 'shared',
      bodies: { en: 'Hi {{contact.first_name|there}}, fees are shown at checkout.', ar: '' },
    };

    it('refuses a second item with a shortcut the brand’s shared item has, and names the reason', async () => {
      const first = await createMacro(ada, { ...fees, shortcut: 'Fees' });
      expect(first.shortcut).toBe('fees');

      const second = await call<Refusal>('POST', `${brandPath()}/macros`, ada, {
        ...fees,
        name: 'Fees again',
        shortcut: 'fees',
      });
      expect(second.status).toBe(409);
      expect(second.body.error.ticketing?.reason).toBe('shortcut-taken');

      // An agent’s personal item meets the brand’s shared shortcut too.
      const personal = await call<Refusal>('POST', `${brandPath()}/macros`, sam, {
        ...fees,
        name: 'My fees',
        scope: 'personal',
        shortcut: 'fees',
      });
      expect(personal.status).toBe(409);
    });

    it('lets two departments use one shortcut but not a department and the whole brand', async () => {
      await createMacro(ada, { ...fees, name: 'Hours S', departmentId: support, shortcut: 'hrs' });
      await createMacro(ada, { ...fees, name: 'Hours B', departmentId: billing, shortcut: 'hrs' });

      const clash = await call('POST', `${brandPath()}/macros`, ada, {
        ...fees,
        name: 'Hours all',
        shortcut: 'hrs',
      });
      expect(clash.status).toBe(409);
    });

    it('keeps the database index as the backstop for two saves at once', async () => {
      await createMacro(ada, { ...fees, name: 'Race', shortcut: 'race' });

      await expect(
        withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.insert(cannedResponses).values({
            brandId: seeded.brandId,
            kind: 'canned',
            name: 'Race too',
            bodies: { en: 'x' },
            shortcut: 'race',
          }),
        ),
      ).rejects.toThrow();
    });

    it('does not let a 409 reveal a shared item of a department the reader does not work in', async () => {
      // Sam works Support; this item is Billing's.
      await createMacro(ada, {
        ...fees,
        name: 'Billing hours',
        departmentId: billing,
        shortcut: 'bh',
      });

      const mine = await call('POST', `${brandPath()}/macros`, sam, {
        ...fees,
        name: 'My bh',
        scope: 'personal',
        shortcut: 'bh',
      });
      expect(mine.status).toBe(201);
    });

    it('lets a name change through on an item whose shortcut a wider item later took', async () => {
      const first = await createMacro(ada, {
        ...fees,
        name: 'Early',
        departmentId: support,
        shortcut: 'early',
      });
      // Cross-scope, which no unique index spans: written around the service.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.insert(cannedResponses).values({
          brandId: seeded.brandId,
          kind: 'canned',
          name: 'Wide',
          bodies: { en: 'x' },
          shortcut: 'early',
        }),
      );

      const rename = await call<Macro>('PATCH', `${brandPath()}/macros/${first.id}`, ada, {
        name: 'Early renamed',
      });
      expect(rename.status).toBe(200);

      const keep = await call('PATCH', `${brandPath()}/macros/${first.id}`, ada, {
        shortcut: 'early',
        name: 'Early again',
      });
      expect(keep.status).toBe(200);
    });

    it('serialises two saves of one word in different scopes: one wins, one is refused', async () => {
      const results = await Promise.all([
        call('POST', `${brandPath()}/macros`, ada, {
          ...fees,
          name: 'Race dept',
          departmentId: support,
          shortcut: 'dup',
        }),
        call('POST', `${brandPath()}/macros`, ada, { ...fees, name: 'Race all', shortcut: 'dup' }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    });

    it('refuses an unknown placeholder and an unclosed {{ on save, naming each', async () => {
      const typo = await call<{ error: { message?: string } }>(
        'POST',
        `${brandPath()}/macros`,
        ada,
        { ...fees, name: 'Typo', bodies: { en: 'Hi {{agent.nmae}}, see {{', ar: '' } },
      );
      expect(typo.status).toBe(400);
      expect(JSON.stringify(typo.body)).toContain('{{agent.nmae}}');
      expect(JSON.stringify(typo.body)).toContain('Unclosed');

      const created = await createMacro(ada, { ...fees, name: 'Fine' });
      const patch = await call('PATCH', `${brandPath()}/macros/${created.id}`, ada, {
        bodies: { en: '{{nope}}', ar: '' },
      });
      expect(patch.status).toBe(400);
    });

    it('renders a fallback for a value the contact has not got', async () => {
      const contact = await call<ContactDetail>('POST', `${brandPath()}/contacts`, ada, {
        name: '',
        identities: [{ kind: 'email', value: 'anon.fees@example.com' }],
      });
      const ticket = await createTicket(support, contact.body.id);
      const macro = await createMacro(ada, { ...fees, name: 'Fallback' });

      const rendered = await call<RenderedMacro>(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}/macros/${macro.id}/render`,
        ada,
      );
      expect(rendered.body.text).toBe('Hi there, fees are shown at checkout.');
    });

    it('counts a use when the item is applied, and only then', async () => {
      const ticket = await createTicket(support);
      const macro = await createMacro(sam, { ...fees, name: 'Counted', scope: 'personal' });
      expect(macro.useCount).toBe(0);

      await call(
        'GET',
        `${brandPath()}/tickets/${ticket.ticket.id}/macros/${macro.id}/render`,
        sam,
      );
      for (let index = 0; index < 2; index += 1) {
        const run = await call(
          'POST',
          `${brandPath()}/tickets/${ticket.ticket.id}/macro-runs`,
          sam,
          {
            macroId: macro.id,
            actions: [],
            reply: { kind: 'public', bodyHtml: '<p>Hi</p>', clientId: uuidv7() },
          },
        );
        expect(run.status).toBe(201);
      }

      const list = await call<MacroList>('GET', `${brandPath()}/macros`, sam);
      expect(list.body.macros.find((row) => row.id === macro.id)?.useCount).toBe(2);
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
