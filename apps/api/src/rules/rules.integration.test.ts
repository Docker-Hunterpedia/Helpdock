import { readFileSync } from 'node:fs';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type Db,
  type DbHandle,
  departments,
  mailboxes,
  outbox,
  tags,
  teams,
  ticketActivity,
  ticketMessages,
  ticketSlaClocks,
  ticketStatuses,
  tickets,
  ticketTags,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  workflowRuns,
} from '@helpdock/db';
import { type RulesEvaluatePayload, silentLogger, ticketUnsnoozeJobId } from '@helpdock/jobs';
import type {
  Macro,
  RuleBuilderOptions,
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
import { EmailRepository } from '../email/email.repository.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { wakeStatusFor, wakeTicket, writeWokeActivity } from '../tickets/snooze/snooze-wake.js';
import { createTicketSnoozedHandler } from '../tickets/snooze/snooze-worker.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import { applyTriageActions } from './actions.js';
import { evaluateEventRules, runScheduledRules } from './engine.js';
import { createRulesEngineDeps } from './engine-deps.js';
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
 *    team Y and reply with canned Z" runs and is logged — with a real M3-06
 *    canned response, saved through its route and rendered by
 *    `CannedResponsesService` in the engine's transaction.
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

const hasDocker = await dockerAvailable();

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
  /** M3-06's shared canned response "Refund received", in both languages. */
  let refundReceived: string;

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

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

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

  const engine = () => createRulesEngineDeps({ log: silentLogger });

  /**
   * The relay and the two hops after it, until the outbox is empty: every
   * unpublished row is marked published, handed to the rules handler as the
   * dispatcher would hand it, and each `rules.evaluate` it asks for is run in a
   * brand transaction of its own, as the rules worker runs it. Bounded, so a
   * loop the guard failed to stop fails the test instead of hanging it.
   */
  const drain = async (deps: ReturnType<typeof engine> = engine()): Promise<number> => {
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
        await inBrand((tx) => evaluateEventRules(deps, tx, job));
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

    const canned = await call<Macro>('POST', `${brandPath()}/macros`, ada, {
      kind: 'canned',
      name: 'Refund received',
      scope: 'shared',
      bodies: {
        en: 'Refund received · {{ticket.number}}',
        ar: 'تم استلام طلب الاسترداد · {{ticket.number}}',
      },
    });
    expect(canned.status).toBe(201);
    refundReceived = canned.body.id;
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
        { type: 'send_canned', cannedResponseId: refundReceived },
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
      bodyText: `Refund received · ${row?.prefix}-${row?.number}`,
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

  it('offers and sends shared canned responses only, never somebody’s personal one (M3-06 seam)', async () => {
    const personal = await call<Macro>('POST', `${brandPath()}/macros`, ada, {
      kind: 'canned',
      name: 'My own thanks',
      scope: 'personal',
      bodies: { en: 'Thanks from me', ar: '' },
    });
    expect(personal.status).toBe(201);

    const options = await call<RuleBuilderOptions>('GET', `${brandPath()}/rules/options`, ada);
    expect(options.status).toBe(200);
    expect(options.body.cannedResponses).toEqual([{ id: refundReceived, name: 'Refund received' }]);

    // The worker reads as nobody, so the personal one is not in the brand as
    // the engine sees it: the reply is recorded as not carried out.
    await saveRule({
      name: 'Personal thanks',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'subject', operator: 'contains', values: ['thanks'] }],
          },
        ],
      },
      actions: [{ type: 'send_canned', cannedResponseId: personal.body.id }],
    });
    const ticket = await createTicket('Many thanks');
    await drain();

    const log = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, ada);
    const run = log.body.runs.find((entry) => entry.ticketId === ticket.id);
    expect(run?.actions.map((outcome) => outcome.effect)).toEqual(['unavailable']);
    const replies = await inBrand((tx) =>
      tx
        .select()
        .from(ticketMessages)
        .where(
          and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.authorType, 'system')),
        ),
    );
    expect(replies).toEqual([]);

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

  it('tells the agent a rule assigns, as `ticket.assigned` by a rule (M3-07 seam)', async () => {
    await saveRule({
      name: 'Chargebacks to Sam',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'subject', operator: 'contains', values: ['chargeback'] }],
          },
        ],
      },
      actions: [{ type: 'assign_agent', userId: sam.id }],
    });

    const ticket = await createTicket('Chargeback on order 7');
    await drain();

    expect((await ticketRow(ticket.id))?.assigneeId).toBe(sam.id);
    const assigned = await inBrand((tx) =>
      tx
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(
          and(
            eq(outbox.event, 'ticket.assigned'),
            sql`${outbox.payload}->>'ticketId' = ${ticket.id}`,
          ),
        ),
    );
    expect(assigned.map((row) => row.payload)).toEqual([
      {
        ticketId: ticket.id,
        departmentId: support,
        assigneeId: sam.id,
        assignedBy: 'rule',
        actorId: null,
      },
    ]);

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
    const longAgo = new Date(Date.now() - 10 * 86_400_000);
    await inBrand((tx) =>
      tx.update(tickets).set({ statusChangedAt: longAgo }).where(eq(tickets.id, stale.id)),
    );
    for (const ticket of [stale, fresh]) {
      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: awaitingStatus });
    }
    await drain();
    // A person's status move, which runs M3-02's lifecycle hooks, still stamps it.
    expect((await ticketRow(stale.id))?.statusChangedAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
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

  it('closes through an empty required-to-close field and records what it went without (M14-17)', async () => {
    const gate = await call<{ key: string }>('POST', `${brandPath()}/custom-fields`, ada, {
      target: 'ticket',
      key: 'rule_closure_code',
      label: 'Rule closure code',
      type: 'text',
      requiredToClose: true,
    });
    expect(gate.status).toBe(201);

    try {
      const rule = await saveRule({
        name: 'Close stale awaiting tickets',
        kind: 'scheduled',
        intervalMinutes: 15,
        conditions: {
          match: 'all',
          groups: [
            {
              match: 'all',
              conditions: [
                // The subject narrows this rule to this test's ticket: the file
                // leaves earlier awaiting tickets behind, and a rule that also
                // matched them would close them here.
                { field: 'subject', operator: 'contains', values: ['Rule-gated close'] },
                { field: 'status', operator: 'is', values: [awaitingStatus] },
                {
                  field: 'time_in_status',
                  operator: 'more_than',
                  duration: { amount: 1, unit: 'days' },
                },
              ],
            },
          ],
        },
        actions: [{ type: 'close' }],
      });

      const ticket = await createTicket('Rule-gated close M14-17');
      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        statusId: awaitingStatus,
      });
      await drain();
      await inBrand((tx) =>
        tx
          .update(tickets)
          .set({ statusChangedAt: sql`now() - make_interval(days => 3)` })
          .where(eq(tickets.id, ticket.id)),
      );
      const tick = () =>
        inBrand((tx) => runScheduledRules(engine(), tx, { brandId: seeded.brandId }));
      await inBrand((tx) =>
        tx.execute(sql`UPDATE workflow_rules SET last_scheduled_run_at = NULL`),
      );

      // The refusal is a person's; a rule closes and the activity says what it went without.
      expect(await tick()).toEqual({ applied: 1, failed: 0 });
      expect((await ticketRow(ticket.id))?.closedAt).not.toBeNull();

      const [closed] = await inBrand((tx) =>
        tx
          .select({ to: ticketActivity.to })
          .from(ticketActivity)
          .where(
            and(eq(ticketActivity.ticketId, ticket.id), eq(ticketActivity.action, 'ticket.closed')),
          ),
      );
      expect(closed?.to).toMatchObject({
        closedWithout: expect.arrayContaining([gate.body.key]),
      });

      await disableAll();
      await inBrand((tx) => tx.execute(sql`DELETE FROM workflow_runs WHERE rule_id = ${rule.id}`));
    } finally {
      const list = await call<{ fields: { id: string; key: string }[] }>(
        'GET',
        `${brandPath()}/custom-fields?target=ticket`,
        ada,
      );
      const id = list.body.fields.find((field) => field.key === 'rule_closure_code')?.id;
      if (id !== undefined) {
        await call('DELETE', `${brandPath()}/custom-fields/${id}`, ada);
      }
    }
  });

  it('waits from import arrival before time-based actions, including broad candidate scans and delta timestamps', async () => {
    const rule = await saveRule({
      name: 'Reminder for old pending history',
      kind: 'scheduled',
      intervalMinutes: 15,
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [
              { field: 'status', operator: 'is', values: [awaitingStatus] },
              {
                field: 'time_in_status',
                operator: 'more_than',
                duration: { amount: 3, unit: 'days' },
              },
            ],
          },
        ],
      },
      actions: [{ type: 'set_priority', priority: 'high' }],
    });
    const ticket = await createTicket('Imported pending since 2021');
    await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { statusId: awaitingStatus });
    await drain();
    await inBrand((tx) =>
      tx
        .update(tickets)
        .set({
          statusChangedAt: new Date('2021-01-01'),
          importedAt: new Date(),
          importSource: 'zendesk',
        })
        .where(eq(tickets.id, ticket.id)),
    );
    const tick = () =>
      inBrand((tx) => runScheduledRules(engine(), tx, { brandId: seeded.brandId }));
    const due = () =>
      inBrand((tx) => tx.execute(sql`UPDATE workflow_rules SET last_scheduled_run_at = NULL`));
    expect(await tick()).toEqual({ applied: 0, failed: 0 });
    expect((await ticketRow(ticket.id))?.priority).toBe('medium');
    // An OR condition cannot narrow changedBefore in SQL: facts must use the arrival baseline too.
    await inBrand((tx) =>
      tx.execute(
        sql`UPDATE workflow_rules SET conditions = ${JSON.stringify({
          match: 'any',
          groups: [
            {
              match: 'all',
              conditions: [
                {
                  field: 'time_in_status',
                  operator: 'more_than',
                  duration: { amount: 3, unit: 'days' },
                },
              ],
            },
            {
              match: 'all',
              conditions: [{ field: 'priority', operator: 'is', values: ['urgent'] }],
            },
          ],
        })}::jsonb WHERE id=${rule.id}`,
      ),
    );
    await due();
    expect(await tick()).toEqual({ applied: 0, failed: 0 });
    await inBrand((tx) =>
      tx
        .update(tickets)
        .set({ importedAt: sql`now() - interval '4 days'` })
        .where(eq(tickets.id, ticket.id)),
    );
    await due();
    expect(await tick()).toEqual({ applied: 1, failed: 0 });
    // A delta correcting an ancient source timestamp must not create a new reminder match.
    await inBrand((tx) =>
      tx
        .update(tickets)
        .set({ statusChangedAt: new Date('2022-01-01') })
        .where(eq(tickets.id, ticket.id)),
    );
    await due();
    expect(await tick()).toEqual({ applied: 0, failed: 0 });
    expect(
      (await runsOf(ticket.id)).filter((run) => run.ruleId === rule.id && run.result === 'applied'),
    ).toHaveLength(1);
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
          { type: 'send_canned', cannedResponseId: refundReceived },
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

  it('refuses a rule that sets the Snoozed status, and offers it only as a condition value (M14-02)', async () => {
    const [snoozed] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemKey, 'snoozed')),
    );
    const base = {
      name: 'Snooze by rule',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: { match: 'all', groups: [] },
    };

    const refused = await call<{ error: { message: string } }>(
      'POST',
      `${brandPath()}/rules`,
      ada,
      {
        ...base,
        actions: [{ type: 'set_status', statusId: snoozed?.id }],
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Snoozed');

    const options = await call<{ statuses: { id: string; isSnoozed?: boolean }[] }>(
      'GET',
      `${brandPath()}/rules/options`,
      ada,
    );
    expect(options.body.statuses.find((status) => status.id === snoozed?.id)?.isSnoozed).toBe(true);
  });

  it('snoozes with a rule, by a preset the server resolves like the menu’s (#368)', async () => {
    await saveRule({
      name: 'Snooze new tickets an hour',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: { match: 'all', groups: [] },
      actions: [{ type: 'snooze', preset: 'in_1_hour' }],
    });

    const ticket = await createTicket('Snooze me for a while');
    await drain();

    // The ticket is Snoozed, an hour ahead by the server's clock, with nobody
    // as the person who snoozed it — a rule is nobody — and the status before
    // the snooze remembered for the wake.
    const [snoozed] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemKey, 'snoozed')),
    );
    const row = await ticketRow(ticket.id);
    expect(row?.statusId).toBe(snoozed?.id);
    const until = row?.snoozedUntil;
    expect(until).not.toBeNull();
    const ahead = (until?.getTime() ?? 0) - Date.now();
    expect(ahead).toBeGreaterThan(55 * 60_000);
    expect(ahead).toBeLessThan(65 * 60_000);
    expect(row?.snoozedBy).toBeNull();
    expect(row?.snoozeResumeStatusId).not.toBeNull();

    // The run log carries the action like any other's, with what it did.
    const run = (await runsOf(ticket.id)).find(
      (candidate) => candidate.ruleName === 'Snooze new tickets an hour',
    );
    expect(run?.result).toBe('applied');
    expect(run?.details).toMatchObject({
      actions: [{ action: { type: 'snooze', preset: 'in_1_hour' }, effect: 'changed' }],
    });

    // The activity and the outbox row are a person's snooze's, as §2.2 asks.
    const activity = await inBrand((tx) =>
      tx
        .select()
        .from(ticketActivity)
        .where(
          and(eq(ticketActivity.ticketId, ticket.id), eq(ticketActivity.action, 'ticket.snoozed')),
        ),
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorType: 'system',
      actorId: `rule:${run?.ruleId}`,
      via: 'rule',
    });
    const snoozedEvent = await inBrand((tx) =>
      tx
        .select()
        .from(outbox)
        .where(and(eq(outbox.brandId, seeded.brandId), eq(outbox.event, 'ticket.snoozed'))),
    );
    const mine = snoozedEvent.find(
      (candidate) => (candidate.payload as { ticketId?: string }).ticketId === ticket.id,
    );
    expect(mine?.payload).toMatchObject({ ticketId: ticket.id, version: row?.snoozeVersion });

    // Its consumer plans the same delayed wake timer a person's snooze plans.
    const planned: { jobId: string; fireAt: Date }[] = [];
    await inBrand((tx) =>
      createTicketSnoozedHandler({
        snoozeTimers: {
          upsert: async (timer) => {
            planned.push({ jobId: timer.jobId, fireAt: timer.fireAt });
          },
          remove: async () => {},
        },
      })({
        outboxId: mine?.id ?? '',
        brandId: seeded.brandId,
        event: 'ticket.snoozed',
        payload: mine?.payload ?? {},
        tx,
        log: silentLogger,
      }),
    );
    expect(planned).toEqual([
      {
        jobId: ticketUnsnoozeJobId({ ticketId: ticket.id, version: row?.snoozeVersion ?? 0 }),
        fireAt: until,
      },
    ]);

    await disableAll();
  });

  describe('a snooze that ends by itself is never undone by a rule (#368)', () => {
    const resnoozeRule = (
      trigger: 'ticket_created' | 'ticket_updated' | 'customer_replied',
      name: string,
    ) =>
      saveRule({
        name,
        kind: 'event',
        trigger,
        conditions: { match: 'all', groups: [] },
        actions: [{ type: 'snooze', preset: 'in_1_hour' }],
      });

    /** A ticket asleep by a person's `PATCH`, with the outbox empty and no rule running. */
    const sleepingTicket = async (subject: string): Promise<Ticket> => {
      await disableAll();
      const ticket = await createTicket(subject);
      const slept = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        snoozedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
      expect(slept.status).toBe(200);
      await drain();
      return ticket;
    };

    const isAsleep = async (ticketId: string): Promise<boolean> => {
      const row = await ticketRow(ticketId);
      return row?.snoozedUntil !== null;
    };

    it.each(['time', 'sla'] as const)(
      'refuses to snooze on the run a %s wake starts, and says why in the log',
      async (cause) => {
        const ticket = await sleepingTicket(`Woken by ${cause}`);
        await resnoozeRule('ticket_updated', `Snooze on update after ${cause}`);

        const asleep = await ticketRow(ticket.id);
        await inBrand((tx) => {
          /* c8 ignore next 3 -- the ticket was snoozed above. */
          if (asleep === undefined) {
            throw new Error('the ticket is gone');
          }
          return wakeTicket(tx, { ticket: asleep, cause, now: new Date() });
        });
        await drain();

        expect(await isAsleep(ticket.id)).toBe(false);
        const run = (await runsOf(ticket.id)).find(
          (candidate) => candidate.ruleName === `Snooze on update after ${cause}`,
        );
        expect(run?.result).toBe('applied');
        expect(run?.details).toMatchObject({
          actions: [
            {
              action: { type: 'snooze', preset: 'in_1_hour' },
              effect: 'unavailable',
              reason: 'woken',
            },
          ],
        });
        await disableAll();
      },
    );

    /** What every channel does for a customer's reply to a snoozed ticket, in one transaction. */
    const customerWritesBack = async (ticketId: string, wakes: boolean): Promise<void> => {
      await inBrand(async (tx) => {
        const row = (await tx.select().from(tickets).where(eq(tickets.id, ticketId)))[0];
        /* c8 ignore next 3 -- the ticket was created above. */
        if (row === undefined) {
          throw new Error('the ticket is gone');
        }
        if (wakes) {
          const open = await wakeStatusFor(tx, row.snoozeResumeStatusId);
          await tx
            .update(tickets)
            .set({ statusId: open?.id ?? row.statusId })
            .where(eq(tickets.id, ticketId));
          await writeWokeActivity(tx, {
            brandId: seeded.brandId,
            ticket: row,
            actor: { actorType: 'system', actorId: 'test', via: 'system' },
            reason: 'customer_reply',
            statusId: open?.id ?? row.statusId,
          });
        }
        const [message] = await tx
          .insert(ticketMessages)
          .values({
            brandId: seeded.brandId,
            ticketId,
            departmentId: row.departmentId,
            seq: 99,
            kind: 'public',
            authorType: 'contact',
            authorId: row.contactId ?? uuidv7(),
            bodyHtml: '<p>Any news?</p>',
            bodyText: 'Any news?',
            channel: row.channel,
          })
          .returning();
        await enqueueTicketEvent(tx, seeded.brandId, TICKET_EVENTS.replied, {
          ticketId,
          departmentId: row.departmentId,
          messageId: message?.id ?? uuidv7(),
          seq: 99,
          kind: 'public',
        });
      });
    };

    it('refuses to snooze on the run a customer reply wakes the ticket for', async () => {
      const ticket = await sleepingTicket('Woken by the customer');
      await resnoozeRule('customer_replied', 'Snooze on reply');

      await customerWritesBack(ticket.id, true);
      await drain();

      expect(await isAsleep(ticket.id)).toBe(false);
      const run = (await runsOf(ticket.id)).find(
        (candidate) => candidate.ruleName === 'Snooze on reply',
      );
      expect(run?.details).toMatchObject({
        actions: [{ effect: 'unavailable', reason: 'woken' }],
      });
      await disableAll();
    });

    it.each([
      ['under 5 minutes', 60_000],
      ['over 90 days', 91 * 24 * 3_600_000],
    ])('refuses a preset that resolves to %s, as PATCH does', async (_name, ahead) => {
      await disableAll();
      await resnoozeRule('ticket_created', 'Snooze out of bounds');
      const ticket = await createTicket('A preset the bounds refuse');
      await drain({
        ...engine(),
        snooze: {
          at: async (_tx, _brand, _department, _preset, now) => new Date(now.getTime() + ahead),
        },
      });

      expect(await isAsleep(ticket.id)).toBe(false);
      const run = (await runsOf(ticket.id)).find(
        (candidate) => candidate.ruleName === 'Snooze out of bounds',
      );
      expect(run?.details).toMatchObject({ actions: [{ effect: 'unavailable' }] });
      await disableAll();
    });

    it('keeps the mark through an AI triage that applies, so the chain cannot re-snooze either', async () => {
      const ticket = await sleepingTicket('Woken, then triaged');
      await resnoozeRule('ticket_updated', 'Snooze after triage');
      const asleep = await ticketRow(ticket.id);
      await inBrand((tx) => {
        /* c8 ignore next 3 -- the ticket was snoozed above. */
        if (asleep === undefined) {
          throw new Error('the ticket is gone');
        }
        return wakeTicket(tx, { ticket: asleep, cause: 'time', now: new Date() });
      });
      await drain();
      expect(await isAsleep(ticket.id)).toBe(false);

      // The triage job's apply, as the worker runs it for a rule started by the wake.
      await inBrand(async (tx) => {
        const deps = engine();
        const target = await deps.tickets.findTicket(tx, ticket.id);
        /* c8 ignore next 3 -- the ticket exists. */
        if (target === undefined) {
          throw new Error('the ticket is gone');
        }
        await applyTriageActions(
          deps,
          {
            tx,
            brandId: seeded.brandId,
            ruleId: uuidv7(),
            runId: uuidv7(),
            chain: [uuidv7()],
            now: new Date(),
            wokeBy: 'time',
          },
          target,
          [{ type: 'set_priority', priority: 'urgent' }],
        );
      });
      await drain();

      expect(await isAsleep(ticket.id)).toBe(false);
      const run = (await runsOf(ticket.id)).find(
        (candidate) => candidate.ruleName === 'Snooze after triage',
      );
      expect(run?.details).toMatchObject({ actions: [{ effect: 'unavailable', reason: 'woken' }] });
      await disableAll();
    });

    it('still snoozes on a reply that woke nothing', async () => {
      await disableAll();
      const ticket = await createTicket('Not asleep when the customer wrote');
      await drain();
      await resnoozeRule('customer_replied', 'Snooze on plain reply');

      await customerWritesBack(ticket.id, false);
      await drain();

      expect(await isAsleep(ticket.id)).toBe(true);
      await disableAll();
    });
  });

  it('test-runs a snooze on a closed ticket as not carried out (#368)', async () => {
    const [closed] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemKey, 'closed')),
    );
    const ticket = await createTicket('Closed before it could be snoozed');
    const moved = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
      statusId: closed?.id,
    });
    expect(moved.status).toBe(200);

    const outcome = await call<RuleTestRunResult>('POST', `${brandPath()}/rules/test-run`, ada, {
      rule: {
        name: 'Snooze the closed ones',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: { match: 'all', groups: [] },
        actions: [{ type: 'snooze', preset: 'in_1_hour' }],
      },
      ticket: String(ticket.number),
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.outcome?.actions).toEqual([
      { action: { type: 'snooze', preset: 'in_1_hour' }, effect: 'unavailable' },
    ]);
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

  it('meets the first-response clock with a canned reply only when it counts as a response (M3-02)', async () => {
    const target = { firstResponseMinutes: 60, resolutionMinutes: 480 };
    const policy = await call<{ id: string }>('POST', `${brandPath()}/sla-policies`, ada, {
      name: 'Every ticket',
      conditions: [],
      timeMode: 'calendar',
      targets: { low: target, medium: target, high: target, urgent: target },
      escalation: [],
    });
    expect(policy.status).toBe(201);

    const replyOn = (word: string, countsAsResponse: boolean): RuleDraftInput => ({
      name: `Reply on ${word}`,
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [{ field: 'subject', operator: 'contains', values: [word] }],
          },
        ],
      },
      actions: [{ type: 'send_canned', cannedResponseId: refundReceived, countsAsResponse }],
    });
    await saveRule(replyOn('counted', true));
    await saveRule(replyOn('courtesy', false));

    const counted = await createTicket('A counted reply');
    const courtesy = await createTicket('A courtesy reply');
    await drain();

    const firstResponse = async (ticketId: string) => {
      const [clock] = await inBrand((tx) =>
        tx
          .select()
          .from(ticketSlaClocks)
          .where(
            and(
              eq(ticketSlaClocks.ticketId, ticketId),
              eq(ticketSlaClocks.kind, 'first_response'),
              eq(ticketSlaClocks.isCurrent, true),
            ),
          ),
      );
      if (clock === undefined) {
        throw new Error(`no first-response clock on ${ticketId}`);
      }
      return clock;
    };
    expect((await firstResponse(counted.id)).satisfiedAt).not.toBeNull();
    expect((await firstResponse(courtesy.id)).satisfiedAt).toBeNull();

    await disableAll();
    expect(
      (await call('DELETE', `${brandPath()}/sla-policies/${policy.body.id}`, ada)).status,
    ).toBe(204);
  });

  it('reads M3-01’s business hours, in the engine and in the test run', async () => {
    // Open all day on one weekday three days from today, in UTC: today is
    // outside, whatever the hour the suite runs at.
    const openDay = (new Date().getUTCDay() + 3) % 7;
    const weekly = Array.from({ length: 7 }, (_, day) =>
      day === openDay ? [{ start: '00:00', end: '24:00' }] : [],
    );
    const hours = await call('PUT', `${brandPath()}/business-hours`, ada, {
      brand: { timezone: 'UTC', weekly },
      departments: [],
    });
    expect(hours.status).toBe(200);

    const outsideHours: RuleDraftInput = {
      name: 'Out of hours',
      kind: 'event',
      trigger: 'ticket_created',
      conditions: {
        match: 'all',
        groups: [
          {
            match: 'all',
            conditions: [
              { field: 'subject', operator: 'contains', values: ['overnight'] },
              { field: 'business_hours', operator: 'is', values: ['outside'] },
            ],
          },
        ],
      },
      actions: [{ type: 'add_tag', tagId: refundTag }],
    };
    await saveRule(outsideHours);
    const ticket = await createTicket('An overnight question');
    await drain();
    expect((await runsOf(ticket.id)).map((run) => run.result)).toEqual(['applied']);

    const row = await ticketRow(ticket.id);
    const testRun = (value: 'inside' | 'outside') =>
      call<RuleTestRunResult>('POST', `${brandPath()}/rules/test-run`, ada, {
        ticket: `${row?.prefix}-${row?.number}`,
        rule: {
          ...outsideHours,
          conditions: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [{ field: 'business_hours', operator: 'is', values: [value] }],
              },
            ],
          },
        },
      });
    expect((await testRun('outside')).body.outcome?.wouldRun).toBe(true);
    expect((await testRun('inside')).body.outcome?.wouldRun).toBe(false);

    await disableAll();
  });
  describe('mailbox arrival (M14-26)', () => {
    let supportBox: string;
    let billingBox: string;

    /** What email intake keeps on the ticket from M14-08's arrival record. */
    const arriveAt = (ticketId: string, mailboxId: string, address: string) =>
      inBrand((tx) =>
        tx
          .update(tickets)
          .set({ arrivalMailboxId: mailboxId, arrivalToAddress: address.toLowerCase() })
          .where(eq(tickets.id, ticketId)),
      );

    const listIds = async (who: Person, query: string): Promise<string[]> => {
      const response = await call<{ tickets: Ticket[] }>(
        'GET',
        `${brandPath()}/tickets?${query}`,
        who,
      );
      expect(response.status).toBe(200);
      return response.body.tickets.map((ticket) => ticket.id);
    };

    beforeAll(async () => {
      await inBrand(async (tx) => {
        const rows = await tx
          .insert(mailboxes)
          .values([
            {
              brandId: seeded.brandId,
              address: 'support@acme.test',
              displayName: 'Acme Support',
              departmentId: support,
              method: 'inbound_parse',
            },
            {
              brandId: seeded.brandId,
              address: 'billing@acme.test',
              displayName: 'Acme Billing',
              departmentId: billing,
              method: 'inbound_parse',
            },
          ])
          .returning({ id: mailboxes.id, address: mailboxes.address });
        supportBox = rows.find((row) => row.address === 'support@acme.test')?.id ?? '';
        billingBox = rows.find((row) => row.address === 'billing@acme.test')?.id ?? '';
      });
    });

    it('matches conditions on the mailbox and the address written to, and never a ticket with no mailbox arrival', async () => {
      await disableAll();
      await saveRule({
        name: 'Refund mailbox',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: {
          match: 'all',
          groups: [
            {
              match: 'all',
              conditions: [
                { field: 'mailbox', operator: 'is', values: [supportBox] },
                { field: 'to_address', operator: 'contains', values: ['refunds@'] },
              ],
            },
          ],
        },
        actions: [{ type: 'add_tag', tagId: refundTag }],
      });
      await saveRule({
        name: 'Not the billing mailbox',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: {
          match: 'all',
          groups: [
            {
              match: 'all',
              conditions: [{ field: 'mailbox', operator: 'is_not', values: [billingBox] }],
            },
          ],
        },
        actions: [{ type: 'set_priority', priority: 'high' }],
      });

      const written = await createTicket('Wrote to the refunds alias');
      const other = await createTicket('Wrote to the main address');
      const legacy = await createTicket('Filed before M14');
      await arriveAt(written.id, supportBox, 'refunds@acme.test');
      await arriveAt(other.id, supportBox, 'support@acme.test');
      // The legacy ticket has no mailbox arrival: its creation row says it was typed in by staff.
      await drain();

      const tagged = (ticketId: string) =>
        inBrand((tx) => tx.select().from(ticketTags).where(eq(ticketTags.ticketId, ticketId)));
      expect((await tagged(written.id)).map((row) => row.tagId)).toEqual([refundTag]);
      expect(await tagged(other.id)).toEqual([]);
      expect(await tagged(legacy.id)).toEqual([]);

      // "Is not" does not claim a ticket that never had a mailbox to differ from.
      expect((await ticketRow(written.id))?.priority).toBe('high');
      expect((await ticketRow(legacy.id))?.priority).toBe('medium');
      const legacyRuns = await runsOf(legacy.id);
      expect(legacyRuns.length).toBeGreaterThan(0);
      expect(legacyRuns.every((run) => run.result === 'skipped')).toBe(true);

      // The test run answers the same, and the options list the mailboxes for the builder.
      const options = await call<RuleBuilderOptions>('GET', `${brandPath()}/rules/options`, ada);
      expect(options.body.mailboxes.map((mailbox) => mailbox.address).sort()).toEqual([
        'billing@acme.test',
        'support@acme.test',
      ]);
      await disableAll();
    });

    it('filters the list by mailbox and by the address written to, and only within the reader’s departments', async () => {
      const first = await createTicket('Arrived at support');
      const second = await createTicket('Arrived at support, other alias');
      const billed = await createTicket('Arrived at billing', billing);
      await arriveAt(first.id, supportBox, 'support@acme.test');
      await arriveAt(second.id, supportBox, 'help@acme.test');
      await arriveAt(billed.id, billingBox, 'billing@acme.test');

      const bySupport = await listIds(ada, `mailboxId=${supportBox}`);
      expect(bySupport).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(bySupport).not.toContain(billed.id);

      expect(await listIds(ada, `mailboxId=${supportBox}&mailboxId=${billingBox}`)).toEqual(
        expect.arrayContaining([first.id, second.id, billed.id]),
      );
      expect(await listIds(ada, 'toAddress=HELP@acme.test')).toEqual([second.id]);
      expect(await listIds(ada, `mailboxId=${supportBox}&toAddress=help@acme.test`)).toEqual([
        second.id,
      ]);
      expect(await listIds(ada, `mailboxId=${billingBox}&toAddress=help@acme.test`)).toEqual([]);

      // Sam works Support only: the filter narrows what he may see, never widens it.
      expect(await listIds(sam, `mailboxId=${billingBox}`)).toEqual([]);
      expect(await listIds(sam, `mailboxId=${supportBox}`)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
      expect(await listIds(sam, `mailboxId=${supportBox}`)).not.toContain(billed.id);

      // A view saves the filter and resolves it.
      const view = await call<{
        id: string;
        filters: { mailboxId?: string[]; toAddress?: string };
      }>('POST', `${brandPath()}/views`, ada, {
        name: 'Help alias',
        visibility: { kind: 'personal' },
        filters: { toAddress: 'help@acme.test' },
      });
      expect(view.status).toBe(201);
      expect(view.body.filters.toAddress).toBe('help@acme.test');

      const boxes = await call<{ mailboxes: { address: string }[] }>(
        'GET',
        `${brandPath()}/ticket-mailboxes`,
        sam,
      );
      expect(boxes.status).toBe(200);
      expect(boxes.body.mailboxes.map((mailbox) => mailbox.address)).toContain('support@acme.test');
    });

    it('keeps a ticket in the mailbox view after it moves to another department (M14-26 regression)', async () => {
      const bea = await addPerson(runtime.db, 'bea');
      await inBrand((tx) =>
        tx.insert(userBrandRoles).values({
          userId: bea.id,
          brandId: seeded.brandId,
          role: 'agent',
          departmentIds: [billing],
        }),
      );
      bea.token = await signIn(bea.email, PASSWORD);

      const moved = await createTicket('Arrived at support, then transferred', support);
      await arriveAt(moved.id, supportBox, 'support@acme.test');
      // Before the transfer a Billing-only Agent cannot see it.
      expect(await listIds(bea, `mailboxId=${supportBox}`)).not.toContain(moved.id);

      await inBrand((tx) =>
        tx
          .update(tickets)
          .set({ departmentId: billing, teamId: null })
          .where(eq(tickets.id, moved.id)),
      );

      // Regression: a transferred ticket stays in its mailbox view for whoever works it now.
      expect(await listIds(bea, `mailboxId=${supportBox}`)).toContain(moved.id);
      expect(await listIds(bea, 'toAddress=support@acme.test')).toContain(moved.id);
    });

    it('backfills the arrival columns of existing tickets from their arrival activity (migration 0076)', async () => {
      const migration = readFileSync(
        new URL(
          '../../../../packages/db/drizzle/0076_ticket_arrival_and_reply_mailbox.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const update = migration
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .find((statement) => statement.includes('UPDATE "tickets" AS t'));
      expect(update).toBeDefined();

      const arrived = await createTicket('Old email ticket');
      const typed = await createTicket('Old staff ticket');
      await inBrand((tx) =>
        tx
          .update(ticketActivity)
          .set({
            to: {
              arrival: {
                entry: 'mailbox',
                entryId: supportBox,
                address: 'Refunds@Acme.test',
                departmentId: support,
                reason: 'entry_department',
              },
            },
          })
          .where(
            and(
              eq(ticketActivity.ticketId, arrived.id),
              eq(ticketActivity.action, 'ticket.created'),
            ),
          ),
      );

      await inBrand((tx) => tx.execute(sql.raw(update ?? '')));

      expect(await ticketRow(arrived.id)).toMatchObject({
        arrivalMailboxId: supportBox,
        arrivalToAddress: 'refunds@acme.test',
      });
      expect(await ticketRow(typed.id)).toMatchObject({
        arrivalMailboxId: null,
        arrivalToAddress: null,
      });
    });

    it('falls back to the department sender when the ticket leaves the reply mailbox’s department', async () => {
      const ticket = await createTicket('Replies from support', support);
      await inBrand((tx) =>
        tx.update(tickets).set({ replyMailboxId: supportBox }).where(eq(tickets.id, ticket.id)),
      );
      const addressingOf = () =>
        inBrand((tx) => new EmailRepository().replyAddressing(tx, ticket.id));

      expect((await addressingOf())?.replyMailbox?.id).toBe(supportBox);

      await inBrand((tx) =>
        tx
          .update(tickets)
          .set({ departmentId: billing, teamId: null })
          .where(eq(tickets.id, ticket.id)),
      );
      expect((await addressingOf())?.replyMailbox).toBeNull();
    });

    it('sets the reply mailbox only to a mailbox of the ticket’s department, and says so when it cannot', async () => {
      await disableAll();
      await saveRule({
        name: 'Reply from the support mailbox',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: { match: 'all', groups: [] },
        actions: [{ type: 'set_reply_mailbox', mailboxId: supportBox }],
      });
      const inSupport = await createTicket('Support ticket', support);
      const inBilling = await createTicket('Billing ticket', billing);
      await drain();

      expect((await ticketRow(inSupport.id))?.replyMailboxId).toBe(supportBox);
      expect((await ticketRow(inBilling.id))?.replyMailboxId).toBeNull();

      const log = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, ada);
      const effects = (ticketId: string) =>
        log.body.runs
          .find((run) => run.ticketId === ticketId)
          ?.actions.map((outcome) => outcome.effect);
      expect(effects(inSupport.id)).toEqual(['changed']);
      expect(effects(inBilling.id)).toEqual(['unavailable']);

      const trail = await inBrand((tx) =>
        tx
          .select({ to: ticketActivity.to })
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.ticketId, inSupport.id),
              eq(ticketActivity.action, 'ticket.reply_mailbox.changed'),
            ),
          ),
      );
      expect(trail.map((entry) => entry.to)).toEqual([{ replyMailboxId: supportBox }]);

      // The mailbox is deleted: replies leave from the department's sender again.
      await inBrand((tx) => tx.delete(mailboxes).where(eq(mailboxes.id, supportBox)));
      expect((await ticketRow(inSupport.id))?.replyMailboxId).toBeNull();
      await disableAll();
    });

    it('marks a ticket as spam by rule, with the spam transition’s trail', async () => {
      await disableAll();
      await saveRule({
        name: 'Spam by subject',
        kind: 'event',
        trigger: 'ticket_created',
        conditions: {
          match: 'all',
          groups: [
            {
              match: 'all',
              conditions: [{ field: 'subject', operator: 'contains', values: ['lottery'] }],
            },
          ],
        },
        actions: [{ type: 'mark_spam' }, { type: 'add_tag', tagId: refundTag }],
      });
      const spam = await createTicket('You won the lottery');
      const fine = await createTicket('A real question');
      await drain();

      const statusOf = (ticketId: string) =>
        inBrand(async (tx) => {
          const [row] = await tx
            .select({ isSpam: ticketStatuses.isSpam })
            .from(tickets)
            .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
            .where(eq(tickets.id, ticketId));
          return row?.isSpam;
        });
      expect(await statusOf(spam.id)).toBe(true);
      expect(await statusOf(fine.id)).toBe(false);

      const actions = await inBrand((tx) =>
        tx
          .select({ action: ticketActivity.action, actorId: ticketActivity.actorId })
          .from(ticketActivity)
          .where(eq(ticketActivity.ticketId, spam.id)),
      );
      expect(actions.map((entry) => entry.action)).toContain('ticket.marked_spam');
      const events = await inBrand((tx) =>
        tx.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.event, 'ticket.spam')),
      );
      expect(events.map((entry) => entry.payload)).toContainEqual(
        expect.objectContaining({ ticketId: spam.id }),
      );

      const log = await call<WorkflowRunList>('GET', `${brandPath()}/rules/runs`, ada);
      expect(
        log.body.runs.find((run) => run.ticketId === spam.id)?.actions.map((o) => o.effect),
      ).toEqual(['changed', 'changed']);
      await disableAll();
    });
  });
});
