import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  createDb,
  type Db,
  type DbHandle,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcImportAssets,
  hcMedia,
  hcSections,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  type HelpCenterPublishDuePayload,
  helpCenterPublishDueJob,
  helpCenterPublishDueSweepJob,
} from '@helpdock/jobs';
import {
  HC_ARTICLE_CHANGED_EVENT,
  type HcArticle,
  type HcCategory,
  type HcMedia,
  type HcMediaPresignResponse,
  type HcSection,
  type HcStructure,
  hcImportAssetPath,
  hcMediaPath,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { RefreshStore } from '../auth/session/refresh-store.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import {
  createObjectPurgeHandler,
  OBJECT_PURGE_EVENT,
  objectPurgePayloadSchema,
} from '../media/object-purge.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { FakeStorage, silentJobLogger } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { HelpCenterContentService } from './content.service.js';
import { HelpCenterRepository } from './help-center.repository.js';
import { markImportedHcMediaFailed } from './import-media-failure.js';
import { hcMediaKey } from './media.service.js';
import { createHcMediaProcessor } from './media-process.job.js';
import { publishDue } from './publish.js';
import { createHelpCenterKnowledgeProcessor, hourOf } from './publish-due.job.js';
import { STAFF_COOKIE } from './site/staff-access.js';

/**
 * M5-01, M5-02 and M5-09 against a real Postgres, over real sessions.
 *
 * 1. **Who may do what**: every role reads, only an Admin or a Team Leader
 *    changes anything (DOMAIN-RULES §1.2).
 * 2. **The tree**: slugs, limits on deleting a parent with children, and a drag
 *    that moves an article to another section.
 * 3. **The editor**: sanitised autosave, a working copy apart from what
 *    visitors read, publishing, scheduling, archiving, and the Activity panel.
 * 4. **The read service** answers in the reader's language or the brand's
 *    default, and — the M5 exit criterion — an article toggled from public to
 *    internal never comes back from a public query: not by slug, not in the
 *    tree, not in the sitemap, and "changed since" says so without its slug.
 * 5. **Internal-only mode** empties every public read and restores it.
 * 6. **Article images** go through the pipeline and are served by redirect.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M5 help center integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: { readonly code: string; readonly helpCenter?: { readonly reason: string } };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe.skipIf(!hasDocker)('the help center content (M5-01, M5-02, M5-09)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: FakeStorage;
  let bucket: string;
  let content: HelpCenterContentService;

  let ada: Person;
  let tia: Person;
  let sam: Person;
  let vic: Person;

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
    method: Method,
    url: string,
    who: Person | null,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }> =>
    app
      .inject({
        method,
        url,
        headers: {
          ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
        headers: response.headers,
      }));

  const hc = (suffix: string) => `/api/brands/${seeded.brandId}/help-center${suffix}`;

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

  const ok = async <T>(method: Method, url: string, who: Person, payload?: unknown): Promise<T> => {
    const response = await call<T>(method, url, who, payload);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return response.body;
  };

  const newCategory = (name: string) =>
    ok<HcCategory>('POST', hc('/categories'), ada, { names: { en: name, ar: '' } });
  const newSection = (categoryId: string, name: string) =>
    ok<HcSection>('POST', hc('/sections'), ada, { categoryId, names: { en: name, ar: '' } });
  const newArticle = (sectionId: string, title: string, locale: 'en' | 'ar' = 'en') =>
    ok<HcArticle>('POST', hc('/articles'), tia, { sectionId, locale, title });
  const save = (articleId: string, locale: 'en' | 'ar', title: string, bodyHtml: string) =>
    ok<HcArticle>('PUT', hc(`/articles/${articleId}/versions/${locale}`), tia, {
      title,
      description: `${title}, briefly`,
      bodyHtml,
    });
  const setStatus = (articleId: string, locale: 'en' | 'ar', body: unknown) =>
    call<HcArticle & Refusal>(
      'PUT',
      hc(`/articles/${articleId}/versions/${locale}/status`),
      tia,
      body,
    );
  const setVisibility = (articleId: string, locale: 'en' | 'ar', visibility: string) =>
    ok<HcArticle>('PUT', hc(`/articles/${articleId}/versions/${locale}/visibility`), tia, {
      visibility,
    });

  const eventsFor = async (articleId: string) =>
    owner.db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.event, HC_ARTICLE_CHANGED_EVENT),
          sql`${outbox.payload}->>'articleId' = ${articleId}`,
        ),
      )
      .orderBy(outbox.createdAt, outbox.id);

  const publicRead = (slug: string, locale: 'en' | 'ar' = 'en') =>
    content.articleBySlug({ brandId: seeded.brandId, audience: 'public', locale, slug });
  const internalRead = (slug: string, locale: 'en' | 'ar' = 'en') =>
    content.articleBySlug({ brandId: seeded.brandId, audience: 'internal', locale, slug });
  const publicSlugsInTree = async (locale: 'en' | 'ar' = 'en') =>
    (await content.tree({ brandId: seeded.brandId, audience: 'public', locale })).flatMap(
      (category) =>
        category.sections.flatMap((section) => section.articles.map((article) => article.slug)),
    );

  let returns: HcCategory;
  let refunds: HcSection;
  let exchanges: HcSection;

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });

    bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-hc-'));
    storage = new FakeStorage(bucket);
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime, objectStorage: storage });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    content = new HelpCenterContentService(runtime.db);

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    ada.token = await signIn(seeded.email, seeded.password);
    tia = await addPerson(runtime.db, 'Tia Leader');
    sam = await addPerson(runtime.db, 'Sam Agent');
    vic = await addPerson(runtime.db, 'Vic Viewer');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: tia.id, brandId: seeded.brandId, role: 'team_leader' },
        { userId: sam.id, brandId: seeded.brandId, role: 'agent' },
        { userId: vic.id, brandId: seeded.brandId, role: 'viewer' },
      ]),
    );
    tia.token = await signIn(tia.email, STAFF_PASSWORD);
    sam.token = await signIn(sam.email, STAFF_PASSWORD);
    vic.token = await signIn(vic.email, STAFF_PASSWORD);

    returns = await newCategory('Returns & refunds');
    refunds = await newSection(returns.id, 'Refunds');
    exchanges = await newSection(returns.id, 'Exchanges');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    if (bucket !== undefined) {
      await rm(bucket, { recursive: true, force: true });
    }
  });

  describe('who may do what', () => {
    it('lets every role read the structure', async () => {
      for (const who of [ada, tia, sam, vic]) {
        expect((await call('GET', hc('/structure'), who)).status).toBe(200);
      }
    });

    it('refuses an Agent and a Viewer every change', async () => {
      for (const who of [sam, vic]) {
        const response = await call('POST', hc('/categories'), who, { names: { en: 'X', ar: '' } });
        expect(response.status).toBe(403);
        expect((await call('PUT', hc('/settings'), who, { access: 'public' })).status).toBe(403);
      }
    });

    it('refuses a request without a session', async () => {
      expect((await call('GET', hc('/structure'), null)).status).toBe(401);
    });
  });

  describe('the tree', () => {
    it('derives slugs, suffixes a collision, and refuses one somebody typed', async () => {
      const first = await newCategory('Orders');
      const second = await newCategory('Orders');
      expect([first.slug, second.slug]).toEqual(['orders', 'orders-2']);

      const typed = await call<Refusal>('PATCH', hc(`/categories/${second.id}`), ada, {
        slug: 'orders',
      });
      expect(typed.status).toBe(409);
      expect(typed.body.error.helpCenter?.reason).toBe('slug-taken');

      const arabic = await ok<HcCategory>('POST', hc('/categories'), ada, {
        names: { en: '', ar: 'الحساب' },
      });
      expect(arabic.slug).toBe('category');

      const renamed = await ok<HcCategory>('PATCH', hc(`/categories/${second.id}`), ada, {
        names: { en: 'Order history', ar: 'سجل الطلبات' },
        slug: 'order-history',
      });
      expect(renamed).toMatchObject({ slug: 'order-history', names: { ar: 'سجل الطلبات' } });

      for (const category of [first, second, arabic]) {
        expect((await call('DELETE', hc(`/categories/${category.id}`), ada)).status).toBe(204);
      }
    });

    it('refuses to delete a category or section that still has something in it', async () => {
      const category = await call<Refusal>('DELETE', hc(`/categories/${returns.id}`), ada);
      expect(category.status).toBe(409);
      expect(category.body.error.helpCenter?.reason).toBe('not-empty');

      const spare = await newSection(returns.id, 'Spare');
      const article = await newArticle(spare.id, 'Temporary');
      const section = await call<Refusal>('DELETE', hc(`/sections/${spare.id}`), ada);
      expect(section.body.error.helpCenter?.reason).toBe('not-empty');

      expect((await call('DELETE', hc(`/articles/${article.id}`), tia)).status).toBe(204);
      expect((await call('DELETE', hc(`/sections/${spare.id}`), ada)).status).toBe(204);
    });

    it('orders the children of a parent and moves one dragged in from elsewhere', async () => {
      const first = await newArticle(refunds.id, 'Refund timelines for cards');
      const second = await newArticle(exchanges.id, 'Exchanging a gift');

      const structure = await ok<HcStructure>('POST', hc('/articles/reorder'), tia, {
        parentId: refunds.id,
        ids: [second.id, first.id],
      });
      const inRefunds = structure.articles
        .filter((article) => article.sectionId === refunds.id)
        .sort((a, b) => a.position - b.position)
        .map((article) => article.id);
      expect(inRefunds.slice(0, 2)).toEqual([second.id, first.id]);
      expect((await eventsFor(second.id)).map((row) => row.payload.change)).toEqual(['moved']);

      const sections = await ok<HcStructure>('POST', hc('/sections/reorder'), ada, {
        parentId: returns.id,
        ids: [exchanges.id, refunds.id],
      });
      expect(
        sections.sections
          .filter((section) => section.categoryId === returns.id)
          .sort((a, b) => a.position - b.position)
          .map((section) => section.id),
      ).toEqual([exchanges.id, refunds.id]);

      const wrongParent = await call('POST', hc('/categories/reorder'), ada, {
        parentId: returns.id,
        ids: [returns.id],
      });
      expect(wrongParent.status).toBe(400);
      const unknown = await call('POST', hc('/articles/reorder'), ada, {
        parentId: refunds.id,
        ids: [uuidv7()],
      });
      expect(unknown.status).toBe(404);

      for (const article of [first, second]) {
        await call('DELETE', hc(`/articles/${article.id}`), tia);
      }
    });
  });

  describe('the editor', () => {
    it('sanitises what it saves and keeps the working copy apart from what visitors read', async () => {
      const article = await newArticle(refunds.id, 'Refund timelines');
      const saved = await save(
        article.id,
        'en',
        'Refund timelines',
        '<h2 id="how-long">How long</h2><p>Three to five days.</p><script>alert(1)</script>',
      );
      const english = saved.versions.find((version) => version.locale === 'en');
      expect(english?.bodyHtml).toBe('<h2 id="how-long">How long</h2><p>Three to five days.</p>');
      expect(english).toMatchObject({ status: 'draft', hasUnpublishedChanges: false });
      expect((await publicRead(article.slug)).state).toBe('not_found');

      const published = await setStatus(article.id, 'en', { status: 'published' });
      expect(published.body.versions[0]).toMatchObject({
        status: 'published',
        publishedByName: 'Tia Leader',
      });

      const edited = await save(article.id, 'en', 'Refund timelines', '<p>Being rewritten</p>');
      expect(edited.versions[0]?.hasUnpublishedChanges).toBe(true);
      const read = await publicRead(article.slug);
      expect(read.state === 'found' && read.article.bodyHtml).toBe(
        '<h2 id="how-long">How long</h2><p>Three to five days.</p>',
      );

      // Autosave writes one "Edited" per person and language, not one per save.
      await save(article.id, 'en', 'Refund timelines', '<p>Being rewritten again</p>');
      const activity = (await ok<HcArticle>('GET', hc(`/articles/${article.id}`), vic)).activity;
      expect(activity.map((entry) => entry.action)).toEqual(['published', 'created']);
      expect(activity[0]).toMatchObject({ actorName: 'Tia Leader', locale: 'en' });
    });

    it('refuses to delete an article that was published, and schedules only in the future', async () => {
      const article = await newArticle(refunds.id, 'Partial refunds for bundles');
      await setStatus(article.id, 'en', { status: 'published' });

      const deleted = await call<Refusal>('DELETE', hc(`/articles/${article.id}`), tia);
      expect(deleted.status).toBe(409);
      expect(deleted.body.error.helpCenter?.reason).toBe('was-published');

      const past = await setStatus(article.id, 'en', {
        status: 'scheduled',
        scheduledAt: '2020-01-01T00:00:00Z',
      });
      expect(past.status).toBe(400);
      expect(past.body.error.helpCenter?.reason).toBe('schedule-in-past');

      const missing = await setStatus(article.id, 'ar', { status: 'published' });
      expect(missing.status).toBe(404);
    });

    it('publishes a scheduled version when its time comes, as nobody', async () => {
      const article = await newArticle(refunds.id, 'Refunds before 2025');
      const at = new Date(Date.now() + 60 * 60_000);
      const scheduled = await setStatus(article.id, 'en', {
        status: 'scheduled',
        scheduledAt: at.toISOString(),
      });
      expect(scheduled.body.versions[0]).toMatchObject({
        status: 'scheduled',
        scheduledAt: at.toISOString(),
      });
      const [event] = await eventsFor(article.id);
      expect(event?.payload).toMatchObject({ change: 'scheduled', scheduledAt: at.toISOString() });

      const early = await withSystem(runtime.db, seeded.brandId, (tx) =>
        publishDue(tx, new HelpCenterRepository(), {
          actor: { type: 'system', id: 'test' },
          now: new Date(),
        }),
      );
      expect(early).toBe(0);

      const processor = createHelpCenterKnowledgeProcessor({
        db: runtime.db,
        log: silentJobLogger,
        queue: { add: async () => undefined },
        now: () => new Date(at.getTime() + 1_000),
      });
      const payload: HelpCenterPublishDuePayload = {
        brandId: seeded.brandId,
        tick: at.toISOString(),
      };
      await processor({ name: helpCenterPublishDueJob.name, id: 'job-1', data: payload } as Job);

      const after = await ok<HcArticle>('GET', hc(`/articles/${article.id}`), tia);
      expect(after.versions[0]).toMatchObject({ status: 'published', scheduledAt: null });
      expect(after.activity[0]).toMatchObject({ action: 'published', actorName: null });
    });

    it('sweeps every active brand hourly', async () => {
      const added: HelpCenterPublishDuePayload[] = [];
      const now = new Date('2026-10-01T06:42:00Z');
      const processor = createHelpCenterKnowledgeProcessor({
        db: runtime.db,
        log: silentJobLogger,
        queue: {
          add: async (payload) => {
            added.push(payload);
          },
        },
        now: () => now,
      });
      await processor({ name: helpCenterPublishDueSweepJob.name, id: 's', data: {} } as Job);

      expect(added).toContainEqual({ brandId: seeded.brandId, tick: hourOf(now) });
      await expect(processor({ name: 'nope', id: 'x', data: {} } as Job)).rejects.toThrow(
        /No consumer/,
      );
    });
  });

  describe('the read service', () => {
    it('answers in the reader’s language, or the brand’s default with a flag', async () => {
      const article = await newArticle(refunds.id, 'Store credit or money back');
      await save(article.id, 'en', 'Store credit or money back', '<p>English</p>');
      await setStatus(article.id, 'en', { status: 'published' });

      const fallback = await publicRead(article.slug, 'ar');
      expect(fallback).toMatchObject({
        state: 'found',
        article: {
          locale: 'en',
          fallback: true,
          locales: ['en'],
          section: { id: refunds.id, name: 'Refunds' },
          category: { id: returns.id, name: 'Returns & refunds' },
        },
      });

      await save(article.id, 'ar', 'رصيد المتجر أو استرداد المبلغ', '<p dir="rtl">عربي</p>');
      await setStatus(article.id, 'ar', { status: 'published' });
      expect(await publicRead(article.slug, 'ar')).toMatchObject({
        state: 'found',
        article: { locale: 'ar', fallback: false, locales: ['ar', 'en'] },
      });

      // An Arabic version staff made internal is not an Arabic version to a
      // visitor, who gets the public English one instead.
      await setVisibility(article.id, 'ar', 'internal');
      expect(await publicRead(article.slug, 'ar')).toMatchObject({
        state: 'found',
        article: { locale: 'en', fallback: true, locales: ['en'] },
      });
      expect(await internalRead(article.slug, 'ar')).toMatchObject({
        state: 'found',
        article: { locale: 'ar', visibility: 'internal' },
      });
    });

    it('never answers a public query with an article toggled from public to internal', async () => {
      const article = await newArticle(exchanges.id, 'Refund exceptions: who approves what');
      await save(article.id, 'en', 'Refund exceptions', '<p>Only a Team Leader approves.</p>');
      await setStatus(article.id, 'en', { status: 'published' });
      const before = new Date();

      expect((await publicRead(article.slug)).state).toBe('found');
      expect(await publicSlugsInTree()).toContain(article.slug);
      expect((await content.sitemap(seeded.brandId)).map((entry) => entry.slug)).toContain(
        article.slug,
      );

      await setVisibility(article.id, 'en', 'internal');

      expect(await publicRead(article.slug)).toEqual({ state: 'not_found' });
      expect(await publicRead(article.slug, 'ar')).toEqual({ state: 'not_found' });
      expect(await publicSlugsInTree()).not.toContain(article.slug);
      expect(await publicSlugsInTree('ar')).not.toContain(article.slug);
      expect((await content.sitemap(seeded.brandId)).map((entry) => entry.slug)).not.toContain(
        article.slug,
      );
      const changed = await content.changedSince({
        brandId: seeded.brandId,
        audience: 'public',
        since: before,
      });
      expect(changed.find((row) => row.articleId === article.id)).toMatchObject({
        visible: false,
        slug: null,
      });

      // Staff still read it, and the change was announced in the same transaction.
      expect((await internalRead(article.slug)).state).toBe('found');
      expect((await eventsFor(article.id)).map((row) => row.payload.change)).toEqual([
        'published',
        'visibility',
      ]);
    });

    it('answers 410-worthy "gone" for an archived article, and "not found" for a draft', async () => {
      const article = await newArticle(refunds.id, 'Old return window');
      expect((await publicRead(article.slug)).state).toBe('not_found');
      await setStatus(article.id, 'en', { status: 'published' });
      await setStatus(article.id, 'en', { status: 'archived' });

      expect(await publicRead(article.slug)).toEqual({ state: 'gone' });
      expect(await internalRead(article.slug)).toEqual({ state: 'gone' });

      await setVisibility(article.id, 'en', 'internal');
      // "It existed" is itself something a visitor may not learn of an internal article.
      expect(await publicRead(article.slug)).toEqual({ state: 'not_found' });

      await setStatus(article.id, 'en', { status: 'draft' });
      expect(await internalRead(article.slug)).toEqual({ state: 'not_found' });
      expect((await eventsFor(article.id)).map((row) => row.payload.change)).toEqual([
        'published',
        'archived',
        'visibility',
        'unpublished',
      ]);
    });

    it('re-announces every language when an article moves or changes address', async () => {
      const article = await newArticle(refunds.id, 'Moving article');
      await setStatus(article.id, 'en', { status: 'published' });
      const since = new Date();

      const moved = await ok<HcArticle>('PATCH', hc(`/articles/${article.id}`), tia, {
        sectionId: exchanges.id,
        slug: 'moved-article',
      });
      expect(moved).toMatchObject({ sectionId: exchanges.id, slug: 'moved-article' });
      expect(
        (await content.changedSince({ brandId: seeded.brandId, audience: 'public', since })).find(
          (row) => row.articleId === article.id,
        ),
      ).toMatchObject({ visible: true, slug: 'moved-article' });
      expect((await eventsFor(article.id)).map((row) => row.payload.change)).toEqual([
        'published',
        'moved',
        'slug',
      ]);
      expect((await publicRead('moved-article')).state).toBe('found');
    });

    it('keeps another brand’s articles out of every read', async () => {
      const otherBrand = uuidv7();
      await runtime.db
        .insert(brands)
        .values({ id: otherBrand, name: 'Globex', prefix: `GLX${otherBrand.slice(-4)}` });
      await withSystem(runtime.db, otherBrand, async (tx) => {
        const [category] = await tx
          .insert(hcCategories)
          .values({ brandId: otherBrand, slug: 'other', names: { en: 'Other' } })
          .returning();
        const [section] = await tx
          .insert(hcSections)
          .values({
            brandId: otherBrand,
            categoryId: category?.id ?? '',
            slug: 'other',
            names: { en: 'Other' },
          })
          .returning();
        const [article] = await tx
          .insert(hcArticles)
          .values({ brandId: otherBrand, sectionId: section?.id ?? '', slug: 'globex-secret' })
          .returning();
        await tx.insert(hcArticleVersions).values({
          brandId: otherBrand,
          articleId: article?.id ?? '',
          locale: 'en',
          title: 'Globex',
          status: 'published',
          publishedTitle: 'Globex',
          publishedAt: new Date(),
        });
      });

      expect((await publicRead('globex-secret')).state).toBe('not_found');
      expect(
        (
          await content.articleBySlug({
            brandId: otherBrand,
            audience: 'public',
            locale: 'en',
            slug: 'globex-secret',
          })
        ).state,
      ).toBe('found');
      expect((await content.sitemap(otherBrand)).map((entry) => entry.slug)).toEqual([
        'globex-secret',
      ]);
    });
  });

  describe('internal-only mode', () => {
    it('empties every public read, and switching back restores each article’s own choice', async () => {
      const article = await newArticle(refunds.id, 'Where is my refund');
      await setStatus(article.id, 'en', { status: 'published' });
      expect((await publicRead(article.slug)).state).toBe('found');

      const set = await ok('PUT', hc('/settings'), tia, { access: 'internal_only' });
      expect(set).toEqual({ access: 'internal_only' });
      expect(await ok('GET', hc('/settings'), sam)).toEqual({ access: 'internal_only' });

      expect((await publicRead(article.slug)).state).toBe('not_found');
      expect(await content.sitemap(seeded.brandId)).toEqual([]);
      expect(
        await content.tree({ brandId: seeded.brandId, audience: 'public', locale: 'en' }),
      ).toEqual([]);
      expect((await internalRead(article.slug)).state).toBe('found');
      const [announced] = await owner.db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(eq(outbox.event, 'help_center.access_changed'));
      expect(announced?.payload).toEqual({ access: 'internal_only' });

      await ok('PUT', hc('/settings'), tia, { access: 'public' });
      expect((await publicRead(article.slug)).state).toBe('found');
    });
  });

  describe('article images', () => {
    async function importingFile() {
      const bytes = Buffer.from('%PDF-1.4\nOriginal historical manual\n%%EOF');
      const mediaId = uuidv7();
      const key = hcMediaKey(seeded.brandId, mediaId, 'original');
      await owner.db.insert(hcMedia).values({
        id: mediaId,
        brandId: seeded.brandId,
        s3Key: key,
        originalName: 'original-manual.pdf',
        mime: 'application/pdf',
        size: bytes.length,
        kind: 'file',
        status: 'processing',
        importedByRunId: uuidv7(),
      });
      const [asset] = await owner.db
        .insert(hcImportAssets)
        .values({
          brandId: seeded.brandId,
          source: 'file',
          sourceAccountKey: 'a'.repeat(64),
          parentExternalId: `article:${mediaId}`,
          assetExternalId: 'original-manual',
          locale: 'en',
          usage: 'download',
          payloadHash: 'b'.repeat(64),
          contentHash: createHash('sha256').update(bytes).digest('hex'),
          mediaId,
        })
        .returning({ id: hcImportAssets.id });
      if (!asset) throw new Error('Missing importing-file asset');
      await storage.put(key, bytes);
      return { mediaId, assetId: asset.id, key, bytes };
    }

    async function purgeImportedOriginal(key: string) {
      const events = await owner.db
        .select()
        .from(outbox)
        .where(and(eq(outbox.brandId, seeded.brandId), eq(outbox.event, OBJECT_PURGE_EVENT)));
      const event = events.find((entry) => {
        const parsed = objectPurgePayloadSchema.safeParse(entry.payload);
        return parsed.success && parsed.data.keys.includes(key);
      });
      if (!event) throw new Error('Missing committed source cleanup');
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        createObjectPurgeHandler(storage)({
          brandId: seeded.brandId,
          outboxId: event.id,
          event: event.event,
          payload: event.payload,
          tx,
          log: silentJobLogger,
        }),
      );
    }

    async function fileArticle(locale: 'en' | 'ar') {
      const file = await importingFile();
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        createHcMediaProcessor(storage).run({
          payload: { brandId: seeded.brandId, mediaId: file.mediaId },
          tx,
          log: silentJobLogger,
        }),
      );
      const target = hcImportAssetPath(seeded.brandId, file.assetId);
      expect((await call('GET', target, null)).status).toBe(404);
      const title = locale === 'ar' ? 'الملف الأصلي' : 'Original file';
      const article = await newArticle(refunds.id, title, locale);
      await save(article.id, locale, title, `<p><a href="${target}">original-manual.pdf</a></p>`);
      await owner.db
        .update(hcImportAssets)
        .set({ articleId: article.id, locale })
        .where(eq(hcImportAssets.id, file.assetId));
      return { ...file, target, article, title };
    }

    it.each(['en', 'ar'] as const)(
      'authorizes %s article files against live publication, readership, locale and actual links',
      async (locale) => {
        const file = await fileArticle(locale);
        expect((await call('GET', file.target, null)).status).toBe(404);
        expect((await setStatus(file.article.id, locale, { status: 'published' })).status).toBe(
          200,
        );
        const downloaded = await call('GET', file.target, null);
        expect(downloaded.status).toBe(302);
        expect(downloaded.headers['cache-control']).toBe('private, no-store');
        expect(downloaded.headers.location).toContain('https://bucket.test/');
        expect(storage.presignedDownloads.at(-1)).toMatchObject({
          key: file.key,
          inline: false,
          contentType: 'application/pdf',
          fileName: 'original-manual.pdf',
        });
        await setVisibility(file.article.id, locale, 'internal');
        expect((await call('GET', file.target, null)).status).toBe(404);
        await setVisibility(file.article.id, locale, 'public');
        const wrongLocale = locale === 'en' ? 'ar' : 'en';
        await owner.db
          .update(hcImportAssets)
          .set({ locale: wrongLocale })
          .where(eq(hcImportAssets.id, file.assetId));
        expect((await call('GET', file.target, null)).status).toBe(404);
        await owner.db
          .update(hcImportAssets)
          .set({ locale })
          .where(eq(hcImportAssets.id, file.assetId));
        await save(
          file.article.id,
          locale,
          file.title,
          `<pre>&lt;a href="${file.target}"&gt;Example&lt;/a&gt;</pre>`,
        );
        expect((await call('GET', file.target, null)).status).toBe(302);
        await setStatus(file.article.id, locale, { status: 'published' });
        expect((await call('GET', file.target, null)).status).toBe(404);
      },
    );

    it('uses the help-center staff session for private previews and refuses it immediately after refresh-family revocation', async () => {
      const file = await fileArticle('en');
      const staff = { ...tia, token: await signIn(tia.email, STAFF_PASSWORD) };
      const pass = await ok<{ url: string }>('POST', hc('/staff-pass'), staff, {
        preview: { articleId: file.article.id, locale: 'en' },
      });
      const entryUrl = new URL(pass.url);
      const entry = await call('GET', `${entryUrl.pathname}${entryUrl.search}`, null);
      const header = entry.headers['set-cookie'];
      const cookies =
        typeof header === 'string'
          ? [header]
          : Array.isArray(header)
            ? header.filter((value): value is string => typeof value === 'string')
            : [];
      const cookie = cookies.find((value) => value.startsWith(`${STAFF_COOKIE}=`))?.split(';')[0];
      if (!cookie) throw new Error('Missing live help-center staff cookie');
      expect(cookies.find((value) => value.startsWith(`${STAFF_COOKIE}=`))).toContain(
        `Path=/hc/${seeded.brandId}`,
      );
      const fallbackTarget = `/hc/${seeded.brandId}/_hd/assets/${file.assetId}`;
      const landing = entry.headers.location;
      if (typeof landing !== 'string') throw new Error('Missing staff preview redirect');
      const preview = await app.inject({ method: 'GET', url: landing, headers: { cookie } });
      expect(preview.statusCode).toBe(200);
      expect(preview.body).toContain(`href="${fallbackTarget}"`);
      expect((await call('GET', fallbackTarget, null)).status).toBe(404);
      expect((await call('GET', fallbackTarget, null, undefined, { cookie })).status).toBe(302);
      expect((await call('GET', file.target, null, undefined, { cookie })).status).toBe(302);
      expect(
        (await call('GET', file.target, null, undefined, { cookie: `${cookie}tampered` })).status,
      ).toBe(404);
      const familyId = decodeJwt(staff.token).fam;
      if (typeof familyId !== 'string') throw new Error('Missing staff refresh family');
      await new RefreshStore(runtime.redis).revokeFamily(familyId);
      expect((await call('GET', file.target, null, undefined, { cookie })).status).toBe(404);
      expect((await call('GET', fallbackTarget, null, undefined, { cookie })).status).toBe(404);
    });

    it('records exhausted importing-media processing without rewriting native uploads or an already-recorded failure', async () => {
      const file = await importingFile();
      const payload = { brandId: seeded.brandId, mediaId: file.mediaId };
      await markImportedHcMediaFailed(runtime.db, payload);
      const [row] = await owner.db.select().from(hcMedia).where(eq(hcMedia.id, file.mediaId));
      expect(row).toMatchObject({ status: 'rejected', rejectReason: 'processing_failed' });
      const before = await owner.db.execute(
        sql`SELECT xmin::text AS revision FROM hc_media WHERE id = ${file.mediaId}`,
      );
      await markImportedHcMediaFailed(runtime.db, payload);
      expect(
        await owner.db.execute(
          sql`SELECT xmin::text AS revision FROM hc_media WHERE id = ${file.mediaId}`,
        ),
      ).toEqual(before);
      const native = uuidv7();
      await owner.db.insert(hcMedia).values({
        id: native,
        brandId: seeded.brandId,
        s3Key: hcMediaKey(seeded.brandId, native, 'original'),
        originalName: 'native.png',
        mime: 'image/png',
        size: 123,
        status: 'processing',
      });
      await markImportedHcMediaFailed(runtime.db, { brandId: seeded.brandId, mediaId: native });
      expect((await owner.db.select().from(hcMedia).where(eq(hcMedia.id, native)))[0]?.status).toBe(
        'processing',
      );
    });

    it.each(['clean', 'infected', 'error', 'skipped'] as const)(
      'handles imported article files with a %s scanner verdict without turning failures into ready downloads',
      async (verdict) => {
        const file = await importingFile();
        const scanner = verdict === 'skipped' ? undefined : { scan: async () => verdict };
        const operation = () =>
          withSystem(runtime.db, seeded.brandId, (tx) =>
            createHcMediaProcessor(storage, scanner).run({
              payload: { brandId: seeded.brandId, mediaId: file.mediaId },
              tx,
              log: silentJobLogger,
            }),
          );
        if (verdict === 'error')
          await expect(operation()).rejects.toMatchObject({ name: 'HcFileScanUnavailable' });
        else
          expect(await operation()).toEqual(
            verdict === 'infected'
              ? { status: 'rejected', reason: 'infected' }
              : { status: 'ready' },
          );
        const [row] = await owner.db.select().from(hcMedia).where(eq(hcMedia.id, file.mediaId));
        expect(row).toMatchObject({
          status:
            verdict === 'error' ? 'processing' : verdict === 'infected' ? 'rejected' : 'ready',
          scanStatus:
            verdict === 'clean' ? 'clean' : verdict === 'infected' ? 'infected' : 'skipped',
          webpKey: null,
        });
        expect(await storage.read(file.key)).toEqual(file.bytes);
        if (verdict === 'infected') {
          await purgeImportedOriginal(file.key);
          expect(await storage.head(file.key)).toBeUndefined();
        }
        expect((await call('GET', hcMediaPath(seeded.brandId, file.mediaId), null)).status).toBe(
          404,
        );
      },
    );

    it('rejects changed private bytes even when source size and MIME still match, and keeps files out of image confirmation routes', async () => {
      const file = await importingFile();
      expect((await call('POST', hc(`/media/${file.mediaId}/confirm`), tia)).status).toBe(404);
      const changed = Buffer.from(file.bytes);
      changed[20] = 88;
      await storage.put(file.key, changed);
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          createHcMediaProcessor(storage).run({
            payload: { brandId: seeded.brandId, mediaId: file.mediaId },
            tx,
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'rejected', reason: 'integrity_mismatch' });
      expect(await storage.read(file.key)).toEqual(changed);
      await purgeImportedOriginal(file.key);
      expect(await storage.head(file.key)).toBeUndefined();
    });

    it('rejects an imported image whose stored bytes differ from the staged source digest', async () => {
      const file = await importingFile();
      const png = await sharp({
        create: { width: 12, height: 8, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      await owner.db
        .update(hcMedia)
        .set({ kind: 'image', mime: 'image/png', size: png.length })
        .where(eq(hcMedia.id, file.mediaId));
      await storage.put(file.key, png);
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          createHcMediaProcessor(storage).run({
            payload: { brandId: seeded.brandId, mediaId: file.mediaId },
            tx,
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'rejected', reason: 'integrity_mismatch' });
      const [row] = await owner.db.select().from(hcMedia).where(eq(hcMedia.id, file.mediaId));
      expect(row).toMatchObject({ status: 'rejected', webpKey: null });
      expect((await call('GET', hcMediaPath(seeded.brandId, file.mediaId), null)).status).toBe(404);
    });

    it('can retry imported image conversion after a rolled-back ready state without losing its original bytes', async () => {
      const file = await importingFile();
      const png = await sharp({
        create: { width: 12, height: 8, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      await owner.db
        .update(hcMedia)
        .set({ kind: 'image', mime: 'image/png', size: png.length })
        .where(eq(hcMedia.id, file.mediaId));
      await owner.db
        .update(hcImportAssets)
        .set({ contentHash: createHash('sha256').update(png).digest('hex') })
        .where(eq(hcImportAssets.id, file.assetId));
      await storage.put(file.key, png);
      const process = createHcMediaProcessor(storage);
      const rollback = new Error('fixture.transaction-rolled-back');
      await expect(
        withSystem(runtime.db, seeded.brandId, async (tx) => {
          expect(
            await process.run({
              tx,
              payload: { brandId: seeded.brandId, mediaId: file.mediaId },
              log: silentJobLogger,
            }),
          ).toEqual({ status: 'ready' });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await storage.read(file.key)).toEqual(png);
      expect(
        (await owner.db.select().from(hcMedia).where(eq(hcMedia.id, file.mediaId)))[0]?.status,
      ).toBe('processing');
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          process.run({
            tx,
            payload: { brandId: seeded.brandId, mediaId: file.mediaId },
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'ready' });
      expect(await storage.read(file.key)).toEqual(png);
      await purgeImportedOriginal(file.key);
      expect(await storage.head(file.key)).toBeUndefined();
      expect(await storage.head(hcMediaKey(seeded.brandId, file.mediaId, 'webp'))).toBeDefined();
      expect(
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          process.run({
            tx,
            payload: { brandId: seeded.brandId, mediaId: file.mediaId },
            log: silentJobLogger,
          }),
        ),
      ).toEqual({ status: 'skipped' });
    });

    it('converts an upload to WebP and serves it by redirect', async () => {
      const png = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#0f766e' },
      })
        .png()
        .toBuffer();
      const presigned = await ok<HcMediaPresignResponse>('POST', hc('/media/presign'), tia, {
        fileName: 'refund-email.png',
        mime: 'image/png',
        size: png.length,
      });
      await storage.put(hcMediaKey(seeded.brandId, presigned.mediaId, 'original'), png);

      const confirmed = await ok<HcMedia>('POST', hc(`/media/${presigned.mediaId}/confirm`), tia);
      expect(confirmed.status).toBe('processing');
      const again = await ok<HcMedia>('POST', hc(`/media/${presigned.mediaId}/confirm`), tia);
      expect(again.status).toBe('processing');
      const uploaded = await owner.db
        .select()
        .from(outbox)
        .where(eq(outbox.event, 'help_center.media_uploaded'));
      expect(uploaded).toHaveLength(1);

      const outcome = await withSystem(runtime.db, seeded.brandId, (tx) =>
        createHcMediaProcessor(storage).run({
          payload: { brandId: seeded.brandId, mediaId: presigned.mediaId },
          tx,
          log: silentJobLogger,
        }),
      );
      expect(outcome).toEqual({ status: 'ready' });
      const ready = await ok<HcMedia>('GET', hc(`/media/${presigned.mediaId}`), sam);
      expect(ready).toMatchObject({
        status: 'ready',
        width: 40,
        height: 20,
        src: hcMediaPath(seeded.brandId, presigned.mediaId),
      });
      const webp = await storage.read(hcMediaKey(seeded.brandId, presigned.mediaId, 'webp'));
      expect((await sharp(webp).metadata()).format).toBe('webp');

      const redirect = await call('GET', hcMediaPath(seeded.brandId, presigned.mediaId), null);
      expect(redirect.status).toBe(302);
      expect(String(redirect.headers.location)).toContain('webp');

      const unknown = await call('GET', hcMediaPath(seeded.brandId, uuidv7()), null);
      expect(unknown.status).toBe(404);
    });

    it('rejects bytes that are not the image they claim to be, and a missing upload', async () => {
      const presigned = await ok<HcMediaPresignResponse>('POST', hc('/media/presign'), tia, {
        fileName: 'fake.png',
        mime: 'image/png',
        size: 12,
      });
      await storage.put(
        hcMediaKey(seeded.brandId, presigned.mediaId, 'original'),
        Buffer.from('not an image'),
      );
      await ok('POST', hc(`/media/${presigned.mediaId}/confirm`), tia);
      const outcome = await withSystem(runtime.db, seeded.brandId, (tx) =>
        createHcMediaProcessor(storage).run({
          payload: { brandId: seeded.brandId, mediaId: presigned.mediaId },
          tx,
          log: silentJobLogger,
        }),
      );
      expect(outcome).toEqual({ status: 'rejected', reason: 'mime_mismatch' });

      const missing = await ok<HcMediaPresignResponse>('POST', hc('/media/presign'), tia, {
        fileName: 'gone.png',
        mime: 'image/png',
        size: 10,
      });
      const confirmed = await ok<HcMedia>('POST', hc(`/media/${missing.mediaId}/confirm`), tia);
      expect(confirmed).toMatchObject({ status: 'rejected', rejectReason: 'object_missing' });

      const skipped = await withSystem(runtime.db, seeded.brandId, (tx) =>
        createHcMediaProcessor(storage).run({
          payload: { brandId: seeded.brandId, mediaId: missing.mediaId },
          tx,
          log: silentJobLogger,
        }),
      );
      expect(skipped).toEqual({ status: 'skipped' });
    });
  });
});
