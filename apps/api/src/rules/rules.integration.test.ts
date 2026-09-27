import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  tags,
  teams,
  ticketActivity,
  ticketMessages,
  ticketStatuses,
  tickets,
  ticketTags,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  workflowRuns,
} from '@helpdock/db';
import { type RulesEvaluatePayload, silentLogger } from '@helpdock/jobs';
import type {
  RuleDraftInput,
  RuleTestRunResult,
  Ticket,
  TicketDetail,
  WorkflowRule,
  WorkflowRuleList,
  WorkflowRunList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { evaluateEventRules, runScheduledRules } from './engine.js';
import { createRulesEngineDeps } from './engine-deps.js';
import type { CannedResponseRenderer } from './ports.js';
import { createRulesSourceHandler } from './rules-jobs.js';

/**
 * M3-03, M3-04 and M3-05 against a real Postgres, over real sessions.
 *
 * The chain is driven the way the worker drives it — outbox row, the rules
 * handler, `rules.evaluate`, the engine — by {@link drain}, which stands in
 * for the relay and the two BullMQ hops so the test can wait for "nothing
 * left" deterministically. What it proves:
 *
 * 1. **M3's exit criterion**: "on create, if subject contains X, assign to
 *    team Y and reply with canned Z" runs and is logged — with a test double
 *    for M3-06's canned responses.
 * 2. **M3's other exit criterion**: a rule loop is prevented. Two rules that
 *    reassign each other are stopped by the depth guard at the cycle, and the
 *    loop ends.
 * 3. **Time-based rules** act on a ticket once per stay in its status.
 * 4. **The test run changes nothing**, and a ticket the reader cannot see is
 *    not found.
 * 5. **Who may do what**: `ticketing:manage`, and changing rules needs a
 *    brand-wide scope; the log is department-scoped.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'a rules password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M3-03 rules integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

/** M3-06's `render`, doubled: one canned response, in both languages. */
const REFUND_RECEIVED = uuidv7();
const cannedDouble: CannedResponseRenderer = {
  render: (id, { locale }) =>
    Promise.resolve(
      id === REFUND_RECEIVED
        ? {
            bodyHtml: locale === 'ar' ? '<p>تم استلام طلب الاسترداد</p>' : '<p>Refund received</p>',
          }
        : null,
    ),
};

describe.skipIf(!hasDocker)('workflow rules', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** In Support. */
  let billingTeam: string;
  let returnsTeam: string;
  /** In Billing: the rule of the exit criterion moves tickets there. */
  let refundsDesk: string;
  let refundTag: string;
  let awaitingStatus: string;

  let ada: Person;
  /** A Team Leader of Support only. */
  let tess: Person;
  /** An Agent of Support. */
  let sam: Person;

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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  const inBrand = <T>(fn: Parameters<typeof withSystem<T>>[2]): Promise<T> =>
    withSystem(runtime.db, seeded.brandId, fn);

  const engine = () => createRulesEngineDeps({ log: silentLogger, cannedResponses: cannedDouble });

  /**
   * The relay and the two hops after it, until the outbox is empty: every
   * unpublished row is marked published, handed to the rules handler as the
   * dispatcher would hand it, and each `rules.evaluate` it asks for is run in a
   * brand transaction of its own, as the rules worker runs it. Bounded, so a
   * loop the guard failed to stop fails the test instead of hanging it.
   */
  const drain = async (): Promise<number> => {
    let evaluations = 0;
    for (let round = 0; round < 20; round += 1) {
      const rows = await inBrand(async (tx) => {
        const pending = await tx
          .select()
          .from(outbox)
          .where(isNull(outbox.publishedAt))
          .orderBy(asc(outbox.id));
        if (pending.length > 0) {
          await tx
            .update(outbox)
            .set({ publishedAt: new Date() })
            .where(isNull(outbox.publishedAt));
        }
        return pending;
      });
      if (rows.length === 0) {
        return evaluations;
      }

      const jobs: RulesEvaluatePayload[] = [];
      const handler = createRulesSourceHandler({
        add: async (payload) => {
          jobs.push(payload);
        },
      });
      for (const row of rows) {
        await inBrand((tx) =>
          handler({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          }),
        );
      }
      for (const job of jobs) {
        await inBrand((tx) => evaluateEventRules(engine(), tx, job));
        evaluations += 1;
      }
    }
    throw new Error('the outbox never drained: a rule loop was not stopped');
  };

  const saveRule = async (draft: RuleDraftInput): Promise<WorkflowRule> => {
    const response = await call<WorkflowRule>('POST', `${brandPath()}/rules`, ada, draft);
    expect(response.status).toBe(201);
    return response.body;
  };

  const disableAll = async (): Promise<void> => {
    const list = await call<WorkflowRuleList>('GET', `${brandPath()}/rules`, ada);
    for (const rule of list.body.rules.filter((candidate) => candidate.enabled)) {
      await call('PATCH', `${brandPath()}/rules/${rule.id}`, ada, { enabled: false });
    }
  };

  const createTicket = async (subject: string, departmentId = support): Promise<Ticket> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject,
      bodyHtml: '<p>Hello</p>',
      departmentId,
    });
    expect(response.status).toBe(201);
    return response.body.ticket;
  };

  const ticketRow = (ticketId: string) =>
    inBrand(async (tx) => {
      const [row] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
      return row;
    });

  const runsOf = (ticketId: string) =>
    inBrand((tx) =>
      tx
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.ticketId, ticketId))
        .orderBy(asc(workflowRuns.createdAt), asc(workflowRuns.id)),
    );

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
    tess = await addPerson(runtime.db, 'tess');
    sam = await addPerson(runtime.db, 'sam');

    await inBrand(async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      const madeTeams = await tx
        .insert(teams)
        .values([
          { brandId: seeded.brandId, departmentId: support, name: 'Billing' },
          { brandId: seeded.brandId, departmentId: support, name: 'Returns' },
          { brandId: seeded.brandId, departmentId: billing, name: 'Refunds desk' },
        ])
        .returning({ id: teams.id, name: teams.name });
      billingTeam = madeTeams.find((row) => row.name === 'Billing')?.id ?? '';
      returnsTeam = madeTeams.find((row) => row.name === 'Returns')?.id ?? '';
      refundsDesk = madeTeams.find((row) => row.name === 'Refunds desk')?.id ?? '';

      const [tag] = await tx
        .insert(tags)
        .values({ brandId: seeded.brandId, name: 'refund' })
        .returning({ id: tags.id });
      refundTag = tag?.id ?? '';

      const [awaiting] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemKey, 'awaiting_customer'));
      awaitingStatus = awaiting?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: tess.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: [support] },
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    tess.token = await signIn(tess.email, PASSWORD);
    sam.token = await signIn(sam.email, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('runs and logs "on create, if subject contains refund, assign to a team and reply with a canned response" (M3 exit criterion)', async () => {
    const rule = await saveRule({
      name: 'Refunds to Billing',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'any',
            conditions: [
              { field: 'subject', operator: 'contains', values: ['refund'] },
              { field: 'subject', operator: 'contains', values: ['استرداد'] },
            ],
          },
        ],
      },
      actions: [
        { type: 'assign_team', teamId: refundsDesk },
        { type: 'send_canned', cannedResponseId: REFUND_RECEIVED },
        { type: 'add_tag', tagId: refundTag },
      ],
    });

    const ticket = await createTicket('Refund not received after 10 days');
    const other = await createTicket('Where is my parcel?');
    await drain();

    // Assigned: the team, and with it the team's department.
    const row = await ticketRow(ticket.id);
    expect(row).toMatchObject({ teamId: refundsDesk, departmentId: billing });
    expect((await ticketRow(other.id))?.teamId).toBeNull();

    // Replied with the canned response, as a public message the system wrote.
    const messages = await inBrand((tx) =>
      tx
        .select()
        .from(ticketMessages)
        .where(
          and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.authorType, 'system')),
        ),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: 'public',
      authorId: `rule:${rule.id}`,
      bodyText: 'Refund received',
    });

    // The reply's event says it does not count as a response (DOMAIN-RULES §3.1),
    // which is what M3-02's clocks read, and carries the chain.
    const replied = await inBrand((tx) =>
      tx.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.event, 'ticket.replied')),
    );
    expect(replied.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({
        ticketId: ticket.id,
        countsAsResponse: false,
        ruleChain: [rule.id],
      }),
    );

    // Every change is in the activity log as the rule.
    const activity = await inBrand((tx) =>
      tx
        .select({ action: ticketActivity.action, via: ticketActivity.via })
        .from(ticketActivity)
        .where(
          and(
            eq(ticketActivity.ticketId, ticket.id),
            eq(ticketActivity.actorId, `rule:${rule.id}`),
          ),
        ),
    );
    expect(activity.map((entry) => entry.action).sort()).toEqual([
      'ticket.replied',
      'ticket.tags.changed',
      'ticket.updated',
    ]);
    expect(activity.every((entry) => entry.via === 'rule')).toBe(true);
    const tagged = await inBrand((tx) =>
      tx.select().from(ticketTags).where(eq(ticketTags.ticketId, ticket.id)),
    );
    expect(tagged.map((entry) => entry.tagId)).toEqual([refundTag]);

    // And it is logged: applied on the refund ticket, skipped on the other.
    const log = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, ada);
    expect(log.status).toBe(200);
    const applied = log.body.runs.find((run) => run.ticketId === ticket.id);
    expect(applied).toMatchObject({
      ruleName: 'Refunds to Billing',
      trigger: 'ticket_created',
      result: 'applied',
      depth: 1,
      chain: [],
      ticketReference: `${row?.prefix}-${row?.number}`,
    });
    expect(applied?.actions.map((outcome) => outcome.effect)).toEqual([
      'changed',
      'changed',
      'changed',
    ]);
    const skipped = log.body.runs.find((run) => run.ticketId === other.id);
    expect(skipped?.result).toBe('skipped');
    // The stored log never carries the ticket's text.
    expect(skipped?.failedGroup?.conditions[0]?.actual).toBeNull();

    const listed = await call<WorkflowRuleList>('GET', `${brandPath()}/rules`, ada);
    expect(listed.body.rules.find((entry) => entry.id === rule.id)).toMatchObject({
      appliedLast30Days: 1,
      position: 1,
    });

    // A redelivered event is evaluated once more by nobody: the job id and the
    // receipt are the outbox row's, and the rule itself is idempotent anyway.
    await drain();
    expect((await runsOf(ticket.id)).filter((run) => run.result === 'applied')).toHaveLength(1);

    await disableAll();
  });

  it('stops two rules that reassign each other at the cycle, and the loop ends (M3 exit criterion)', async () => {
    const invoices = await saveRule({
      name: 'Invoices to Returns',
      kind: 'event',
      trigger: 'assigned',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [
              { field: 'subject', operator: 'contains', values: ['invoice'] },
              { field: 'team', operator: 'is_not', values: [returnsTeam] },
            ],
          },
        ],
      },
      actions: [{ type: 'assign_team', teamId: returnsTeam }],
    });
    const back = await saveRule({
      name: 'Returns back to Billing',
      kind: 'event',
      trigger: 'assigned',
      conditions: {
        match: 'all',
        groups: [
          { match: 'all', conditions: [{ field: 'team', operator: 'is', values: [returnsTeam] }] },
        ],
      },
      actions: [{ type: 'assign_team', teamId: billingTeam }],
    });

    const ticket = await createTicket('Invoice copy needed');
    await drain();

    // A person assigns it, which starts the chain.
    const moved = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
      assigneeId: sam.id,
    });
    expect(moved.status).toBe(200);
    await drain();

    const runs = (await runsOf(ticket.id)).filter((run) => run.result !== 'skipped');
    expect(runs.map((run) => [run.ruleId, run.result, run.depth, run.stopReason])).toEqual([
      [invoices.id, 'applied', 1, null],
      [back.id, 'applied', 2, null],
      [invoices.id, 'stopped', 3, 'cycle'],
    ]);
    expect(runs[2]?.chain).toEqual([invoices.id, back.id]);
    // What the first two steps did is kept.
    expect((await ticketRow(ticket.id))?.teamId).toBe(billingTeam);

    const log = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs?result=stopped`, ada);
    expect(log.body.runs[0]).toMatchObject({
      ruleName: 'Invoices to Returns',
      stopReason: 'cycle',
      depth: 3,
      chain: [
        { ruleId: invoices.id, ruleName: 'Invoices to Returns' },
        { ruleId: back.id, ruleName: 'Returns back to Billing' },
      ],
    });

    await disableAll();
  });

  it('acts on a ticket once per stay in the status a time-based rule matches (M3-04)', async () => {
    const waitingThreeDays = {
      match: 'all' as const,
      groups: [
        {
          match: 'all' as const,
          conditions: [
            { field: 'status' as const, operator: 'is' as const, values: [awaitingStatus] },
            {
              field: 'time_in_status' as const,
              operator: 'more_than' as const,
              duration: { amount: 3, unit: 'days' as const },
            },
          ],
        },
      ],
    };
    const tagger = await saveRule({
      name: 'Tag after 3 days awaiting customer',
      kind: 'scheduled',
      intervalMinutes: 15,
      conditions: waitingThreeDays,
      actions: [{ type: 'set_priority', priority: 'high' }],
    });

    const stale = await createTicket('Waiting since last week');
    const fresh = await createTicket('Waiting since yesterday');
    for (const ticket of [stale, fresh]) {
      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: awaitingStatus });
    }
    await drain();
    // The trigger stamps `status_changed_at` on every status change; the
    // clock is moved back by hand rather than by waiting four days.
    const waitedFor = (ticketId: string, days: number) =>
      inBrand((tx) =>
        tx
          .update(tickets)
          .set({ statusChangedAt: sql`now() - make_interval(days => ${days})` })
          .where(eq(tickets.id, ticketId)),
      );
    const dueAgain = () =>
      inBrand((tx) => tx.execute(sql`UPDATE workflow_rules SET last_scheduled_run_at = NULL`));
    const tick = () =>
      inBrand((tx) => runScheduledRules(engine(), tx, { brandId: seeded.brandId }));

    await waitedFor(stale.id, 4);
    await waitedFor(fresh.id, 2);

    expect(await tick()).toEqual({ applied: 1, failed: 0 });
    expect((await ticketRow(stale.id))?.priority).toBe('high');
    expect((await ticketRow(fresh.id))?.priority).toBe('medium');

    // Not due again for fifteen minutes; and when it is, the same stay in the
    // status is not acted on twice.
    expect(await tick()).toEqual({ applied: 0, failed: 0 });
    await dueAgain();
    expect(await tick()).toEqual({ applied: 0, failed: 0 });

    // A new stay — a customer replied and the agent set it back — is a new match.
    await waitedFor(stale.id, 5);
    await dueAgain();
    expect(await tick()).toEqual({ applied: 1, failed: 0 });
    expect(
      (await runsOf(stale.id)).filter((run) => run.ruleId === tagger.id).map((run) => run.trigger),
    ).toEqual(['schedule', 'schedule']);

    await disableAll();

    // The artboard's own example: close after three days, through the same
    // transitions an agent's close takes, as rule 1 of a chain.
    const closer = await saveRule({
      name: 'Close after 3 days awaiting customer',
      kind: 'scheduled',
      intervalMinutes: 60,
      conditions: waitingThreeDays,
      actions: [{ type: 'close' }],
    });
    expect(await tick()).toEqual({ applied: 1, failed: 0 });

    const state = await inBrand(async (tx) => {
      const [row] = await tx
        .select({ state: ticketStatuses.systemState })
        .from(tickets)
        .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
        .where(eq(tickets.id, stale.id));
      return row?.state;
    });
    expect(state).toBe('closed');
    expect((await ticketRow(fresh.id))?.closedAt).toBeNull();

    const closedEvents = await inBrand((tx) =>
      tx.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.event, 'ticket.closed')),
    );
    expect(closedEvents.map((entry) => entry.payload)).toContainEqual(
      expect.objectContaining({ ticketId: stale.id, ruleChain: [closer.id] }),
    );

    await drain();
    await disableAll();
  });

  it('test-runs a draft against a ticket without changing, sending or logging anything (M3-05)', async () => {
    const ticket = await createTicket('Refund for order 88412');
    await drain();
    const row = await ticketRow(ticket.id);
    const reference = `${row?.prefix}-${row?.number}`;

    const counts = () =>
      inBrand(async (tx) => ({
        outbox: (await tx.select({ total: count() }).from(outbox))[0]?.total,
        runs: (await tx.select({ total: count() }).from(workflowRuns))[0]?.total,
        audit: (await tx.select({ total: count() }).from(auditLog))[0]?.total,
      }));
    const before = await counts();

    const response = await call<RuleTestRunResult>('POST', `${brandPath()}/rules/test-run`, ada, {
      ticket: reference,
      rule: {
        name: 'Draft',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: {
          match: 'all',
          groups: [
            {
              match: 'any',
              conditions: [
                { field: 'subject', operator: 'contains', values: ['refund'] },
                { field: 'subject', operator: 'contains', values: ['invoice'] },
              ],
            },
          ],
        },
        actions: [
          { type: 'assign_team', teamId: billingTeam },
          { type: 'send_canned', cannedResponseId: REFUND_RECEIVED },
        ],
      },
    });

    expect(response.status).toBe(200);
    const outcome = response.body.outcome;
    if (outcome === null) {
      throw new Error('the test run did not find the ticket');
    }
    expect(outcome.wouldRun).toBe(true);
    expect(outcome.ticket).toMatchObject({ reference, subject: 'Refund for order 88412' });
    expect(outcome.groups[0]?.conditions.map((trace) => trace.outcome)).toEqual([
      'matched',
      'not_needed',
    ]);
    // The reader can see the ticket, so the test run shows what it found.
    expect(outcome.groups[0]?.conditions[0]?.actual).toEqual(['Refund for order 88412']);
    expect(outcome.actions.map((outcome) => outcome.effect)).toEqual(['changed', 'changed']);
    // The disabled loop rules from the previous test are not offered as follow-ons.
    expect(outcome.followOns).toEqual([]);

    expect(await counts()).toEqual(before);
    expect((await ticketRow(ticket.id))?.teamId).toBeNull();

    const missing = await call<RuleTestRunResult>('POST', `${brandPath()}/rules/test-run`, ada, {
      ticket: 'HD-999999',
      rule: {
        name: 'Draft',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: { match: 'all', groups: [] },
        actions: [{ type: 'escalate' }],
      },
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ outcome: null });
  });

  it('keeps changing rules to ticketing:manage holders whose scope is the whole brand', async () => {
    const draft: RuleDraftInput = {
      name: 'Anything',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'set_priority', priority: 'high' }],
      enabled: false,
    };

    expect((await call('GET', `${brandPath()}/rules`, sam)).status).toBe(403);
    expect((await call('POST', `${brandPath()}/rules`, sam, draft)).status).toBe(403);
    // A Team Leader of Support reads the rules, but a rule acts on every
    // department, so they may not change one.
    expect((await call('GET', `${brandPath()}/rules`, tess)).status).toBe(200);
    expect((await call('POST', `${brandPath()}/rules`, tess, draft)).status).toBe(403);

    // The log is department-scoped: a run on a Billing ticket is not Tess's to read.
    await saveRule({ ...draft, name: 'Billing priority', enabled: true });
    const inBilling = await createTicket('Card declined', billing);
    await drain();
    const all = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, ada);
    expect(all.body.runs.some((run) => run.ticketId === inBilling.id)).toBe(true);
    const led = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, tess);
    expect(led.status).toBe(200);
    expect(led.body.runs.length).toBeGreaterThan(0);
    expect(led.body.runs.some((run) => run.ticketId === inBilling.id)).toBe(false);

    await disableAll();
  });

  it('refuses a rule that names another brand’s ids, and reorders a whole list only', async () => {
    const foreign = await call('POST', `${brandPath()}/rules`, ada, {
      name: 'Foreign',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'set_status', statusId: uuidv7() }],
    });
    expect(foreign.status).toBe(400);

    const events = await call<WorkflowRuleList>('GET', `${brandPath()}/rules?kind=event`, ada);
    const ids = events.body.rules.map((rule) => rule.id);
    const reversed = await call<WorkflowRuleList>('POST', `${brandPath()}/rules/reorder`, ada, {
      kind: 'event',
      ruleIds: [...ids].reverse(),
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.rules.map((rule) => rule.id)).toEqual([...ids].reverse());

    const partial = await call('POST', `${brandPath()}/rules/reorder`, ada, {
      kind: 'event',
      ruleIds: ids.slice(1),
    });
    expect(partial.status).toBe(400);

    const [first] = ids;
    const removed = await call('DELETE', `${brandPath()}/rules/${first}`, ada);
    expect(removed.status).toBe(204);
    expect((await call('DELETE', `${brandPath()}/rules/${first}`, ada)).status).toBe(404);
  });
});
