import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  businessHours,
  cannedResponses,
  createDb,
  type DbHandle,
  departments,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcSections,
  mailboxes,
  setupChecklistDismissals,
  slaPolicies,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  widgetSettings,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type { SetupChecklist, SetupChecklistStepId, TicketDetail } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M14-13 against a real Postgres, over real sessions.
 *
 * 1. **Each step ticks from the brand's own rows**, and un-ticks when the row
 *    goes: nothing about the checklist is stored but who hid it.
 * 2. **A ticket counts only when a customer made it**: a manual ticket and an
 *    imported one leave step 9 undone.
 * 3. **Another brand's rows tick nothing**, and an Agent or a Team Leader is
 *    refused (D-31).
 * 4. **Hiding is per person and brand**, and a role granted again shows the
 *    checklist again.
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
    'Skipping the M14-13 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('setup checklist', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let departmentId: string;
  let otherBrandId: string;
  /** The install admin: an Admin of the seeded brand. */
  let ada: Person;
  let agent: Person;
  let leader: Person;

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

  const checklistPath = (brandId = seeded.brandId): string =>
    `/api/brands/${brandId}/setup-checklist`;
  const read = async (who: Person = ada): Promise<SetupChecklist> => {
    const response = await call<SetupChecklist>('GET', checklistPath(), who);
    expect(response.status).toBe(200);

    return response.body;
  };
  const doneSteps = async (who: Person = ada): Promise<SetupChecklistStepId[]> =>
    (await read(who)).steps.filter((step) => step.done).map((step) => step.id);

  const inBrand = <T>(brandId: string, work: Parameters<typeof withSystem<T>>[2]): Promise<T> =>
    withSystem(runtime.db, brandId, work);

  const addPerson = async (who: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${who}-${id}@helpdock.test`;
    await runtime.db.insert(users).values({
      id,
      email,
      name: who,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });

    return { id, email, token: '' };
  };

  const createManualTicket = async (): Promise<string> => {
    const response = await call<TicketDetail>(
      'POST',
      `/api/brands/${seeded.brandId}/tickets`,
      ada,
      {
        subject: 'Refund for order 42',
        bodyHtml: '<p>Where is my refund?</p>',
        departmentId,
      },
    );
    expect(response.status).toBe(201);

    return response.body.ticket.id;
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
    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });

    const [department] = await inBrand(seeded.brandId, (tx) =>
      tx
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.brandId, seeded.brandId))
        .limit(1),
    );
    departmentId = department?.id ?? '';

    const [other] = await runtime.db
      .insert(brands)
      .values({ name: 'Globex', prefix: 'GLX' })
      .returning({ id: brands.id });
    otherBrandId = other?.id ?? '';

    agent = await addPerson('agent');
    leader = await addPerson('leader');
    await inBrand(seeded.brandId, async (tx) => {
      await tx.insert(userBrandRoles).values([
        { userId: agent.id, brandId: seeded.brandId, role: 'agent' },
        { userId: leader.id, brandId: seeded.brandId, role: 'team_leader' },
      ]);
    });
    for (const person of [agent, leader]) {
      person.token = await signInForTest(app, { email: person.email, password: STAFF_PASSWORD });
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('who may read it (D-31)', () => {
    it('is the Admin’s, and an Agent and a Team Leader are refused both routes', async () => {
      for (const person of [agent, leader]) {
        expect((await call('GET', checklistPath(), person)).status).toBe(403);
        expect((await call('POST', `${checklistPath()}/dismiss`, person)).status).toBe(403);
      }
    });

    it('refuses an Admin of one brand the checklist of another', async () => {
      const response = await call('GET', checklistPath(otherBrandId), ada);

      expect([403, 404]).toContain(response.status);
    });
  });

  describe('the steps', () => {
    it('start undone for a brand with a department, the Admin and two colleagues', async () => {
      const checklist = await read();

      // The Agent and the Team Leader added above are the "teammate" step.
      expect(checklist.steps.filter((step) => step.done).map((step) => step.id)).toEqual([
        'teammate',
      ]);
      expect(checklist.total).toBe(9);
      expect(checklist.complete).toBe(false);
      expect(checklist.dismissed).toBe(false);
    });

    it('tick a channel from a mailbox, and from a widget origin', async () => {
      await inBrand(seeded.brandId, (tx) =>
        tx.insert(mailboxes).values({
          brandId: seeded.brandId,
          address: 'help@example.com',
          displayName: 'Help',
          departmentId,
          method: 'inbound_parse',
        }),
      );
      expect(await doneSteps()).toContain('channel');

      await inBrand(seeded.brandId, (tx) =>
        tx.delete(mailboxes).where(eq(mailboxes.brandId, seeded.brandId)),
      );
      expect(await doneSteps()).not.toContain('channel');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .insert(widgetSettings)
          .values({ brandId: seeded.brandId, allowedOrigins: ['https://shop.example.com'] }),
      );
      expect(await doneSteps()).toContain('channel');

      await inBrand(seeded.brandId, (tx) => tx.update(widgetSettings).set({ allowedOrigins: [] }));
      expect(await doneSteps()).not.toContain('channel');

      await inBrand(seeded.brandId, (tx) =>
        tx.insert(mailboxes).values({
          brandId: seeded.brandId,
          address: 'support@example.com',
          displayName: 'Support',
          departmentId,
          method: 'inbound_parse',
        }),
      );
      expect(await doneSteps()).toContain('channel');
    });

    it('tick business hours, an SLA policy and a saved reply from their rows', async () => {
      await inBrand(seeded.brandId, async (tx) => {
        await tx.insert(businessHours).values({
          brandId: seeded.brandId,
          weekly: [[], [{ start: '09:00', end: '17:00' }], [], [], [], [], []],
        });
        await tx.insert(slaPolicies).values({
          brandId: seeded.brandId,
          name: 'Standard',
          conditions: [],
          targets: {},
          escalation: [],
        });
        await tx.insert(cannedResponses).values({
          brandId: seeded.brandId,
          kind: 'macro',
          name: 'Refund',
        });
      });

      expect(await doneSteps()).toEqual(
        expect.arrayContaining(['businessHours', 'slaPolicy', 'reply']),
      );
    });

    it('tick assignment only for a department that is not manual', async () => {
      expect(await doneSteps()).not.toContain('assignment');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(departments)
          .set({ assignmentMode: 'round_robin' })
          .where(eq(departments.id, departmentId)),
      );
      expect(await doneSteps()).toContain('assignment');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(departments)
          .set({ assignmentMode: 'manual' })
          .where(eq(departments.id, departmentId)),
      );
      expect(await doneSteps()).not.toContain('assignment');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(departments)
          .set({ assignmentMode: 'skill_based' })
          .where(eq(departments.id, departmentId)),
      );
      expect(await doneSteps()).toContain('assignment');
    });

    it('tick an article only once a public version is published', async () => {
      const article = await inBrand(seeded.brandId, async (tx) => {
        const [category] = await tx
          .insert(hcCategories)
          .values({ brandId: seeded.brandId, slug: 'start', names: { en: 'Start' } })
          .returning({ id: hcCategories.id });
        const [section] = await tx
          .insert(hcSections)
          .values({
            brandId: seeded.brandId,
            categoryId: category?.id ?? '',
            slug: 'first',
            names: { en: 'First' },
          })
          .returning({ id: hcSections.id });
        const [created] = await tx
          .insert(hcArticles)
          .values({ brandId: seeded.brandId, sectionId: section?.id ?? '', slug: 'hello' })
          .returning({ id: hcArticles.id });
        await tx.insert(hcArticleVersions).values({
          brandId: seeded.brandId,
          articleId: created?.id ?? '',
          locale: 'en',
          title: 'Hello',
          status: 'draft',
        });
        return created?.id ?? '';
      });
      expect(await doneSteps()).not.toContain('article');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(hcArticleVersions)
          .set({ status: 'published', visibility: 'internal' })
          .where(eq(hcArticleVersions.articleId, article)),
      );
      expect(await doneSteps()).not.toContain('article');

      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(hcArticleVersions)
          .set({ visibility: 'public' })
          .where(eq(hcArticleVersions.articleId, article)),
      );
      expect(await doneSteps()).toContain('article');
    });

    it('tick the AI provider from the install’s default, and not for a provider that is gone', async () => {
      expect(await doneSteps()).not.toContain('aiProvider');

      const provider = await call('PUT', '/api/install/ai/providers/openai', ada, {
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: null,
        auth: { type: 'apiKey', apiKey: 'sk-test' },
      });
      expect(provider.status).toBe(200);
      expect(await doneSteps()).not.toContain('aiProvider');

      const model = await call('PUT', '/api/install/ai/default-model', ada, {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
      });
      expect(model.status).toBe(200);
      expect(await doneSteps()).toContain('aiProvider');
    });
  });

  describe('the first ticket', () => {
    it('is not a ticket an agent typed in', async () => {
      await createManualTicket();

      expect(await doneSteps()).not.toContain('firstTicket');
    });

    it('is not a ticket that was imported, whatever channel it names', async () => {
      const id = await createManualTicket();
      await inBrand(seeded.brandId, (tx) =>
        tx
          .update(tickets)
          .set({ channel: 'email', importedAt: new Date() })
          .where(eq(tickets.id, id)),
      );

      expect(await doneSteps()).not.toContain('firstTicket');
    });

    it('is a ticket that arrived through a channel', async () => {
      const id = await createManualTicket();
      await inBrand(seeded.brandId, (tx) =>
        tx.update(tickets).set({ channel: 'email' }).where(eq(tickets.id, id)),
      );

      expect(await doneSteps()).toContain('firstTicket');
    });
  });

  describe('when every required step is done', () => {
    it('is complete with the optional step done too, and 9 of 9 are counted', async () => {
      const checklist = await read();

      expect(checklist.complete).toBe(true);
      expect(checklist.doneCount).toBe(9);
    });

    it('stays complete without the optional step', async () => {
      await call('PUT', '/api/install/ai/default-model', ada, {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
      });
      await call('PUT', '/api/install/ai/providers/openai', ada, {
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: null,
        auth: { type: 'apiKey', apiKey: 'sk-test' },
      });
      await runtime.settings.set('ai.defaultProvider', '', { updatedBy: ada.id });
      await runtime.settings.set('ai.defaultModel', '', { updatedBy: ada.id });

      const checklist = await read();

      expect(checklist.steps.find((step) => step.id === 'aiProvider')?.done).toBe(false);
      expect(checklist.complete).toBe(true);
      expect(checklist.doneCount).toBe(8);
    });
  });

  describe('another brand', () => {
    it('ticks nothing in this one, and this one’s rows tick nothing there', async () => {
      const before = await read();
      await inBrand(otherBrandId, async (tx) => {
        await tx.delete(widgetSettings).where(eq(widgetSettings.brandId, otherBrandId));
        await tx
          .insert(widgetSettings)
          .values({ brandId: otherBrandId, allowedOrigins: ['https://x.example'] });
        await tx.insert(slaPolicies).values({
          brandId: otherBrandId,
          name: 'Other',
          conditions: [],
          targets: {},
          escalation: [],
        });
      });

      expect(await read()).toEqual(before);

      const none = await inBrand(otherBrandId, (tx) =>
        tx
          .select({ brandId: slaPolicies.brandId })
          .from(slaPolicies)
          .where(eq(slaPolicies.brandId, seeded.brandId)),
      );
      expect(none).toEqual([]);
    });
  });

  describe('hiding it', () => {
    const dismissals = (userId: string) =>
      withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: 'all',
          principalType: 'staff',
          principalId: userId,
        },
        (tx) =>
          tx
            .select({ userId: setupChecklistDismissals.userId })
            .from(setupChecklistDismissals)
            .where(and(eq(setupChecklistDismissals.userId, userId))),
      );

    it('is per person: the Admin hides it and a second Admin still sees it', async () => {
      const bea = await addPerson('bea');
      await inBrand(seeded.brandId, (tx) =>
        tx
          .insert(userBrandRoles)
          .values({ userId: bea.id, brandId: seeded.brandId, role: 'admin' }),
      );
      bea.token = await signInForTest(app, { email: bea.email, password: STAFF_PASSWORD });

      const hidden = await call<SetupChecklist>('POST', `${checklistPath()}/dismiss`, ada);

      expect(hidden.status).toBe(200);
      expect(hidden.body.dismissed).toBe(true);
      expect((await read(ada)).dismissed).toBe(true);
      expect((await read(bea)).dismissed).toBe(false);
      expect(await dismissals(ada.id)).toHaveLength(1);
    });

    it('can be done twice without a second row', async () => {
      expect((await call('POST', `${checklistPath()}/dismiss`, ada)).status).toBe(200);
      expect(await dismissals(ada.id)).toHaveLength(1);
    });

    it('is per brand: it does not hide the checklist of the same person elsewhere', async () => {
      await inBrand(otherBrandId, (tx) =>
        tx.insert(userBrandRoles).values({ userId: ada.id, brandId: otherBrandId, role: 'admin' }),
      );
      // A session carries the roles it was made with; this one is made after the grant.
      const fresh = {
        ...ada,
        token: await signInForTest(app, { email: seeded.email, password: seeded.password }),
      };
      const elsewhere = await call<SetupChecklist>('GET', checklistPath(otherBrandId), fresh);

      expect(elsewhere.status).toBe(200);
      expect(elsewhere.body.dismissed).toBe(false);
    });

    it('comes back when the role is removed and granted again', async () => {
      await inBrand(seeded.brandId, async (tx) => {
        await tx
          .delete(userBrandRoles)
          .where(
            and(eq(userBrandRoles.userId, ada.id), eq(userBrandRoles.brandId, seeded.brandId)),
          );
        await tx
          .insert(userBrandRoles)
          .values({ userId: ada.id, brandId: seeded.brandId, role: 'admin' });
      });

      expect((await read(ada)).dismissed).toBe(false);
    });
  });
});
