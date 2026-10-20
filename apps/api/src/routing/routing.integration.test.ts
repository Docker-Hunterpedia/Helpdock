import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  assignmentAgents,
  auditLog,
  blockedSenders,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  mailboxes,
  metaAccounts,
  notifications,
  outbox,
  slaPolicies,
  tags,
  teams,
  telegramBots,
  ticketActivity,
  ticketMessages,
  ticketSlaClocks,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  webFormSettings,
  withSystem,
  workflowRuns,
} from '@helpdock/db';
import type {
  RoutingOverview,
  RoutingTestRequest,
  RoutingTestResult,
  RuleDraftInput,
  WorkflowRule,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { withDryRun } from './read-only.js';

/**
 * M14-09 against a real Postgres and Redis, over real sessions: the Routing
 * overview and Test routing.
 *
 * What it proves:
 *
 * 1. **The dry run has no side effects.** Row counts of every table a real
 *    arrival writes (tickets, contacts, activity, messages, outbox, audit,
 *    notifications, SLA clocks, rule runs), the block list's counters and the
 *    rotation's "last picked" stamps are the same after a run as before it,
 *    and a second run picks the same person: the rotation's turn did not move.
 * 2. **The database refuses a write** made inside a dry run.
 * 3. **The walk follows the real rules**: the entry's department, the block
 *    list, an automated sender, the contact, rules in order with their
 *    conditions, AI triage queued, the SLA due time and the rotation's pick.
 * 4. **Who may do what**: `ticketing:manage`, and a Team Leader scoped to one
 *    department sees and tests only the doors that file into it.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'a routing password';
const CONTAINER_STARTUP_MS = 120_000;
const FIRST_RESPONSE_MINUTES = 240;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M14-09 routing integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('Routing and Test routing', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let redis: Redis;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  let refundsDesk: string;
  let refundTag: string;
  let billingMailbox: string;
  let supportMailbox: string;
  let bot: string;
  let whatsapp: string;
  let raniaContact: string;

  let ada: Person;
  /** A Team Leader of Support only. */
  let tess: Person;
  /** An Agent of Support: cannot use the routes. */
  let sam: Person;
  /** Billing's agents. */
  let omar: Person;
  let lina: Person;

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
    method: 'GET' | 'POST' | 'PATCH',
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

  const inBrand = <T>(fn: Parameters<typeof withSystem<T>>[2]): Promise<T> =>
    withSystem(runtime.db, seeded.brandId, fn);

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
      passwordHash: await new PasswordHasher(masterKey).hash(PASSWORD),
    });
    return { id, email, token: '' };
  };

  const online = (who: Person): Promise<{ arrived: boolean }> =>
    new PresenceStore(redis).join({
      brandId: seeded.brandId,
      userId: who.id,
      socketId: `socket-${who.id}`,
    });

  const offline = (who: Person): Promise<{ departed: boolean }> =>
    new PresenceStore(redis).leave({
      brandId: seeded.brandId,
      userId: who.id,
      socketId: `socket-${who.id}`,
    });

  const saveRule = async (draft: RuleDraftInput): Promise<WorkflowRule> => {
    const response = await call<WorkflowRule>('POST', `${brandPath()}/rules`, ada, draft);
    expect(response.status).toBe(201);
    return response.body;
  };

  const sample = (overrides: Partial<RoutingTestRequest> = {}): RoutingTestRequest => ({
    entry: 'mailbox',
    entryId: billingMailbox,
    from: 'rania@globex.com',
    fromName: 'Rania Saleh',
    subject: 'Please refund invoice 2207',
    message: 'I was charged twice.',
    language: 'en',
    ...overrides,
  });

  const test = (who: Person, body: unknown) =>
    call<RoutingTestResult>('POST', `${brandPath()}/routing/test`, who, body);

  /** A count for every table a real arrival writes, plus the values the dry run must not move. */
  const snapshot = () =>
    inBrand(async (tx) => {
      const count = async (table: PgTable) => {
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table);
        return row?.n ?? 0;
      };
      const [drops] = await tx
        .select({ n: sql<number>`coalesce(sum(${blockedSenders.droppedCount}), 0)::int` })
        .from(blockedSenders);
      const stamps = await tx
        .select({
          userId: assignmentAgents.userId,
          lastAssignedAt: assignmentAgents.lastAssignedAt,
        })
        .from(assignmentAgents)
        .orderBy(assignmentAgents.userId);

      return {
        tickets: await count(tickets),
        contacts: await count(contacts),
        identities: await count(contactIdentities),
        activity: await count(ticketActivity),
        messages: await count(ticketMessages),
        outbox: await count(outbox),
        audit: await count(auditLog),
        notifications: await count(notifications),
        clocks: await count(ticketSlaClocks),
        runs: await count(workflowRuns),
        drops: drops?.n ?? 0,
        stamps,
      };
    });

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    redis = new Redis(redisContainer.getConnectionUrl());

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    tess = await addPerson(runtime.db, 'tess');
    sam = await addPerson(runtime.db, 'sam');
    omar = await addPerson(runtime.db, 'omar');
    lina = await addPerson(runtime.db, 'lina');

    await inBrand(async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support', sortOrder: 1 },
          { brandId: seeded.brandId, name: 'Billing', sortOrder: 2, assignmentMode: 'round_robin' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      const [desk] = await tx
        .insert(teams)
        .values({ brandId: seeded.brandId, departmentId: billing, name: 'Refunds desk' })
        .returning({ id: teams.id });
      refundsDesk = desk?.id ?? '';
      const [tag] = await tx
        .insert(tags)
        .values({ brandId: seeded.brandId, name: 'refund' })
        .returning({ id: tags.id });
      refundTag = tag?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: tess.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [support] },
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: omar.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
        { userId: lina.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
      ]);

      const boxes = await tx
        .insert(mailboxes)
        .values([
          {
            brandId: seeded.brandId,
            address: 'billing@helpdock.test',
            displayName: 'Billing',
            departmentId: billing,
            method: 'inbound_parse',
            automatedAllowlist: ['noreply@status.example.com'],
          },
          {
            brandId: seeded.brandId,
            address: 'support@helpdock.test',
            displayName: 'Support',
            departmentId: support,
            method: 'inbound_parse',
          },
        ])
        .returning({ id: mailboxes.id, address: mailboxes.address });
      billingMailbox = boxes.find((row) => row.address.startsWith('billing'))?.id ?? '';
      supportMailbox = boxes.find((row) => row.address.startsWith('support'))?.id ?? '';

      const [telegram] = await tx
        .insert(telegramBots)
        .values({
          brandId: seeded.brandId,
          telegramId: Date.now(),
          username: 'helpdock_bot',
          displayName: 'Helpdock',
          departmentId: support,
          token: 'v1.sealed',
          tokenUpdatedAt: new Date(),
          webhookSecret: 'v1.sealed',
        })
        .returning({ id: telegramBots.id });
      bot = telegram?.id ?? '';

      const [account] = await tx
        .insert(metaAccounts)
        .values({
          brandId: seeded.brandId,
          platform: 'whatsapp',
          departmentId: billing,
          externalId: '106540352242922',
          displayName: 'Acme WhatsApp',
          accessToken: 'sealed',
          tokenKind: 'system_user',
          tokenUpdatedAt: new Date(),
        })
        .returning({ id: metaAccounts.id });
      whatsapp = account?.id ?? '';

      await tx.insert(webFormSettings).values({ brandId: seeded.brandId, enabled: true });

      const [contact] = await tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: 'Rania Saleh' })
        .returning({ id: contacts.id });
      raniaContact = contact?.id ?? '';
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId: raniaContact,
        kind: 'email',
        value: 'rania@globex.com',
        verified: true,
        source: 'email.inbound',
      });

      await tx.insert(blockedSenders).values({
        brandId: seeded.brandId,
        kind: 'email',
        value: 'spammer@bad.example',
        droppedCount: 3,
      });

      await tx.insert(slaPolicies).values({
        brandId: seeded.brandId,
        name: 'Standard',
        position: 0,
        conditions: [],
        timeMode: 'calendar',
        targets: Object.fromEntries(
          ['low', 'medium', 'high', 'urgent'].map((priority) => [
            priority,
            { firstResponseMinutes: FIRST_RESPONSE_MINUTES, resolutionMinutes: 2880 },
          ]),
        ),
        escalation: [],
      });
    });

    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    for (const person of [tess, sam, omar, lina]) {
      person.token = await signInForTest(app, { email: person.email, password: PASSWORD });
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    redis?.disconnect();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('explains the pipeline: doors, rules in order, triage, and each department’s mode', async () => {
    await saveRule({
      name: 'Refunds to the refund team',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'subject', operator: 'contains', values: ['refund'] }],
          },
        ],
      },
      actions: [
        { type: 'assign_team', teamId: refundsDesk },
        { type: 'add_tag', tagId: refundTag },
        { type: 'ai_triage', mode: 'suggest', fields: ['tags'] },
      ],
    });
    await saveRule({
      name: 'Disabled one',
      kind: 'event',
      trigger: 'ticket_created',
      enabled: false,
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'set_priority', priority: 'high' }],
    });
    await saveRule({
      name: 'Not about creation',
      kind: 'event',
      trigger: 'ticket_updated',
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'set_priority', priority: 'high' }],
    });
    await online(omar);

    const response = await call<RoutingOverview>('GET', `${brandPath()}/routing`, ada);

    expect(response.status).toBe(200);
    const doors = response.body.entryPoints.map((door) => [
      door.entry,
      door.label,
      door.department?.name ?? null,
      door.reason,
    ]);
    expect(doors).toEqual([
      ['mailbox', 'billing@helpdock.test', 'Billing', 'entry_department'],
      ['mailbox', 'support@helpdock.test', 'Support', 'entry_department'],
      ['widget', null, 'General', 'brand_first_department'],
      ['telegram_bot', '@helpdock_bot', 'Support', 'entry_department'],
      ['meta_account', 'Acme WhatsApp', 'Billing', 'entry_department'],
      ['web_form', null, 'General', 'brand_first_department'],
      ['api_key', null, null, 'named_by_api'],
    ]);
    expect(response.body.rules.map((rule) => [rule.name, rule.enabled])).toEqual([
      ['Refunds to the refund team', true],
      ['Disabled one', false],
    ]);
    expect(response.body.triageRules.map((rule) => rule.name)).toEqual([
      'Refunds to the refund team',
    ]);
    const billingMode = response.body.assignment.find((entry) => entry.department.id === billing);
    expect(billingMode).toMatchObject({ mode: 'round_robin', peopleInRotation: 2 });
    expect(response.body.assignment.find((entry) => entry.department.id === support)).toMatchObject(
      { mode: 'manual' },
    );
  });

  it('walks a real sample through the doors, the rules, the SLA and the rotation, and writes nothing', async () => {
    await online(omar);
    const before = await snapshot();

    const first = await test(ada, sample());
    const second = await test(ada, sample());

    expect(first.status).toBe(200);
    // The due time is "now plus the target", so two runs differ by their own milliseconds.
    expect({ ...second.body, sla: null }).toEqual({ ...first.body, sla: null });
    expect(second.body.assignment).toEqual(first.body.assignment);
    const result = first.body;
    expect(result.verdict).toBe('ticket');
    expect(result.entry).toMatchObject({
      entry: 'mailbox',
      label: 'billing@helpdock.test',
      channel: 'email',
      department: { name: 'Billing' },
      reason: 'entry_department',
    });
    expect(result.contact).toEqual({ kind: 'matched', name: 'Rania Saleh', matchedBy: 'email' });

    const [refund, disabledNeverListed] = result.rules;
    expect(disabledNeverListed).toBeUndefined();
    expect(refund).toMatchObject({ name: 'Refunds to the refund team', matched: true });
    expect(refund?.groups[0]?.conditions[0]).toMatchObject({
      outcome: 'matched',
      actual: ['Please refund invoice 2207'],
    });
    expect(refund?.actions.map((action) => [action.action.type, action.effect])).toEqual([
      ['assign_team', 'changed'],
      ['add_tag', 'changed'],
      ['ai_triage', 'changed'],
    ]);
    expect(result.triage).toBe('queued');
    expect(result.ticket).toMatchObject({
      department: { name: 'Billing' },
      team: { name: 'Refunds desk' },
      priority: 'medium',
      tagNames: ['refund'],
    });

    expect(result.sla?.policy?.name).toBe('Standard');
    const due = Date.parse(result.sla?.firstResponseDueAt ?? '');
    expect(Math.abs(due - (Date.now() + FIRST_RESPONSE_MINUTES * 60_000))).toBeLessThan(60_000);
    expect(result.assignment).toEqual({
      kind: 'picked',
      mode: 'round_robin',
      assignee: { id: omar.id, name: 'omar' },
    });

    expect(await snapshot()).toEqual(before);
  });

  it('shows a rule that does not match with the condition that failed', async () => {
    const response = await test(ada, sample({ subject: 'Where is my parcel?' }));

    const rule = response.body.rules[0];
    expect(rule).toMatchObject({ matched: false, actions: [] });
    expect(rule?.groups[0]?.conditions[0]).toMatchObject({ outcome: 'failed' });
    expect(response.body.triage).toBe('not_queued');
    expect(response.body.ticket).toMatchObject({ department: { name: 'Billing' }, team: null });
  });

  it('says a new contact would be created, with the name the sample gave', async () => {
    const response = await test(ada, sample({ from: 'new@client.example', fromName: 'Nadia' }));

    expect(response.body.contact).toEqual({ kind: 'new', name: 'Nadia' });
  });

  it('stops at a blocked sender and does not count the drop', async () => {
    const before = await snapshot();

    const response = await test(ada, sample({ from: 'SPAMMER@bad.example' }));

    expect(response.body).toMatchObject({
      verdict: 'blocked',
      contact: null,
      rules: [],
      ticket: null,
      sla: null,
      assignment: null,
    });
    expect((await snapshot()).drops).toBe(before.drops);
    expect(before.drops).toBe(3);
  });

  it('files no ticket for an automated sender unless the mailbox allow-lists it', async () => {
    const machine = await test(ada, sample({ from: 'noreply@shop.example' }));
    const allowed = await test(ada, sample({ from: 'noreply@status.example.com' }));

    expect(machine.body).toMatchObject({ verdict: 'automated', ticket: null });
    expect(allowed.body.verdict).toBe('ticket');
  });

  it('puts the widget in the brand’s first department and does not consult the block list', async () => {
    const response = await test(
      ada,
      sample({ entry: 'widget', entryId: null, from: 'spammer@bad.example', subject: 'Hello' }),
    );

    expect(response.body.verdict).toBe('ticket');
    expect(response.body.entry).toMatchObject({
      channel: 'chat',
      department: { name: 'General' },
      reason: 'brand_first_department',
    });
    expect(response.body.assignment).toEqual({ kind: 'manual' });
  });

  it('files an API request in the department it names', async () => {
    const response = await test(
      ada,
      sample({ entry: 'api_key', entryId: null, departmentId: billing }),
    );

    expect(response.body.entry).toMatchObject({
      channel: 'api',
      department: { name: 'Billing' },
      reason: 'named_by_api',
    });
  });

  it('knows a Telegram chat and a WhatsApp number by the identifier the channel uses', async () => {
    const telegram = await test(
      ada,
      sample({ entry: 'telegram_bot', entryId: bot, from: '700100200' }),
    );
    const meta = await test(
      ada,
      sample({ entry: 'meta_account', entryId: whatsapp, from: '+15551230000' }),
    );

    expect(telegram.body.entry.channel).toBe('telegram');
    expect(telegram.body.contact).toMatchObject({ kind: 'new' });
    expect(meta.body.entry).toMatchObject({ channel: 'whatsapp', department: { name: 'Billing' } });
  });

  it('says nobody is online when the people who could take it are away, and nobody eligible when none could', async () => {
    await offline(omar);
    const away = await test(ada, sample({ subject: 'Where is my parcel?' }));
    expect(away.body.assignment).toEqual({ kind: 'nobody_online', mode: 'round_robin' });

    await inBrand((tx) =>
      tx.insert(assignmentAgents).values([
        { brandId: seeded.brandId, departmentId: billing, userId: omar.id, inRotation: false },
        { brandId: seeded.brandId, departmentId: billing, userId: lina.id, inRotation: false },
      ]),
    );
    await online(omar);
    const nobody = await test(ada, sample({ subject: 'Where is my parcel?' }));
    expect(nobody.body.assignment).toEqual({ kind: 'nobody_eligible', mode: 'round_robin' });

    await inBrand((tx) => tx.delete(assignmentAgents));
  });

  it('refuses a write made inside a dry run, and leaves the transaction usable', async () => {
    const before = await snapshot();

    await inBrand(async (tx) => {
      await expect(
        withDryRun(tx, (savepoint) =>
          savepoint
            .insert(contacts)
            .values({ brandId: seeded.brandId, name: 'Written by a dry run' }),
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/read-only transaction/) },
      });

      const [ok] = await tx.select({ n: sql<number>`1` }).from(departments).limit(1);
      expect(ok?.n).toBe(1);
      await tx.insert(contacts).values({ brandId: seeded.brandId, name: 'Written after' });
    });

    expect((await snapshot()).contacts).toBe(before.contacts + 1);
  });

  it('shows a Team Leader only the doors that file into their departments', async () => {
    const overview = await call<RoutingOverview>('GET', `${brandPath()}/routing`, tess);

    expect(overview.status).toBe(200);
    expect(overview.body.entryPoints.map((door) => door.label)).toEqual([
      'support@helpdock.test',
      '@helpdock_bot',
      null,
    ]);
    expect(
      overview.body.entryPoints.every(
        (door) => door.department === null || door.department.name === 'Support',
      ),
    ).toBe(true);
    expect(overview.body.assignment.map((entry) => entry.department.name)).toEqual(['Support']);
  });

  it('answers a Team Leader’s test of another department’s door as an unknown door', async () => {
    const own = await test(tess, sample({ entryId: supportMailbox }));
    const other = await test(tess, sample());
    const unknown = await test(ada, sample({ entryId: uuidv7() }));

    expect(own.status).toBe(200);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(other.body).toMatchObject({
      error: { code: 'not_found', message: 'No such entry point' },
    });
    expect(unknown.body).toMatchObject({
      error: { code: 'not_found', message: 'No such entry point' },
    });
  });

  it('does not show the rotation of a department outside the Team Leader’s scope', async () => {
    const rule = await saveRule({
      name: 'Everything to Billing',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'assign_team', teamId: refundsDesk }],
    });

    const response = await test(tess, sample({ entryId: supportMailbox }));

    expect(response.body.ticket?.department.name).toBe('Billing');
    expect(response.body.assignment).toEqual({ kind: 'out_of_scope' });
    await call('PATCH', `${brandPath()}/rules/${rule.id}`, ada, { enabled: false });
  });

  it('is refused to an Agent, and to a request that names no usable door', async () => {
    const agent = await test(sam, sample());
    const overview = await call('GET', `${brandPath()}/routing`, sam);
    const noMailbox = await test(ada, { ...sample(), entryId: null });
    const apiWithoutDepartment = await test(ada, { entry: 'api_key', entryId: null });
    const apiWithUnknownDepartment = await test(
      ada,
      sample({ entry: 'api_key', entryId: null, departmentId: uuidv7() }),
    );

    expect(agent.status).toBe(403);
    expect(overview.status).toBe(403);
    expect(noMailbox.status).toBe(400);
    expect(apiWithoutDepartment.status).toBe(400);
    expect(apiWithUnknownDepartment.status).toBe(404);
  });
});
