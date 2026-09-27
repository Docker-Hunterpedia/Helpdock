import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  createDb,
  type Db,
  type DbHandle,
  hcArticleFeedback,
  hcArticleViews,
  hcSearchDocuments,
  hcSearchLog,
  outbox,
  ticketActivity,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { createOutboxDispatcher, helpCenterSearchReindexJob } from '@helpdock/jobs';
import type {
  HcArticle,
  HcCategory,
  HcInsights,
  HcSection,
  WidgetArticle,
  WidgetArticleSearch,
  WidgetConfig,
  WidgetSession,
  WidgetStartResponse,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, gt, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { runBrandRetention } from '../../retention/retention.job.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { FakeStorage, silentJobLogger } from '../../testing/media.js';
import { HelpCenterFeedbackService } from '../feedback/feedback.service.js';
import { HelpCenterSearchService } from './search.service.js';
import { createSearchKnowledgeProcessor, registerSearchEventHandlers } from './search-events.js';

/**
 * M5-05, M5-08 and M5-10 against a real Postgres, over real sessions.
 *
 * 1. **Search** in English and Arabic, weighted title over body, typos, the
 *    search log with its zero results, and the language fallback.
 * 2. **Visibility**: an internal article never matches a public search — not
 *    before the subscriber has run, not after — while staff find it.
 * 3. **Propagation**: unpublishing and archiving leave the index through the
 *    subscriber, and the hourly reconcile rebuilds a lost index.
 * 4. **Views and votes** dedupe per visitor per day and per version.
 * 5. **Insights** over HTTP, and the retention of the search log.
 * 6. **The widget's routes**: search, one article, the popular list, and
 *    "Still need help?" on the ticket.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;
const SHOP = 'https://shop.example.com';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M5 search and feedback integration tests: Docker is not available.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

type Method = 'GET' | 'POST' | 'PUT';

describe.skipIf(!hasDocker)(
  'help center search, feedback and the widget (M5-05, M5-08, M5-10)',
  () => {
    let postgres: StartedPostgreSqlContainer;
    let redisContainer: StartedRedisContainer;
    let runtime: Runtime;
    let app: ApiApp;
    let owner: DbHandle;
    let seeded: SeededInstall;
    let bucket: string;
    let search: HelpCenterSearchService;
    let feedback: HelpCenterFeedbackService;
    let ada: Person;
    let tia: Person;
    let sam: Person;

    let refunds: HcSection;
    let refundTimelines: HcArticle;
    let cancelling: HcArticle;
    let chargebacks: HcArticle;
    let exchanges: HcArticle;

    const dispatcher = createOutboxDispatcher();
    registerSearchEventHandlers(dispatcher);
    const dispatched = new Set<string>();

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
      headers: Record<string, string>,
      payload?: unknown,
    ): Promise<{ status: number; body: T }> =>
      app
        .inject({
          method,
          url,
          headers: {
            ...headers,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
        })
        .then((response) => ({
          status: response.statusCode,
          body: (response.body === '' ? undefined : response.json()) as T,
        }));

    const staff = <T>(method: Method, url: string, who: Person, payload?: unknown) =>
      call<T>(method, url, { authorization: `Bearer ${who.token}` }, payload);

    const ok = async <T>(
      method: Method,
      url: string,
      who: Person,
      payload?: unknown,
    ): Promise<T> => {
      const response = await staff<T>(method, url, who, payload);
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      return response.body;
    };

    const hc = (suffix: string) => `/api/brands/${seeded.brandId}/help-center${suffix}`;
    const widgetUrl = (suffix: string) => `/api/widget/${seeded.brandId}${suffix}`;
    const asVisitor = (secret: string) => ({ origin: SHOP, authorization: `Visitor ${secret}` });

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

    const write = async (
      sectionId: string,
      locale: 'en' | 'ar',
      title: string,
      body: string,
      into?: HcArticle,
    ): Promise<HcArticle> => {
      const article =
        into ?? (await ok<HcArticle>('POST', hc('/articles'), tia, { sectionId, locale, title }));
      await ok('PUT', hc(`/articles/${article.id}/versions/${locale}`), tia, {
        title,
        description: '',
        bodyHtml: `<p>${body}</p>`,
      });
      await ok('PUT', hc(`/articles/${article.id}/versions/${locale}/status`), tia, {
        status: 'published',
      });
      return article;
    };

    /**
     * The relay's job, done by hand: every `help_center.*` outbox row the search
     * subscriber handles, dispatched once each in its brand's system
     * transaction, as `outbox.event` does in the worker.
     */
    const runSubscriber = async (): Promise<void> => {
      const rows = await owner.db
        .select()
        .from(outbox)
        .where(like(outbox.event, 'help_center.%'))
        .orderBy(outbox.id);
      for (const row of rows) {
        if (dispatched.has(row.id) || !dispatcher.events.includes(row.event)) {
          continue;
        }
        dispatched.add(row.id);
        if (row.event === 'settings.changed') {
          continue;
        }
        await withSystemJob(runtime.db, row.brandId, row.id, (tx) =>
          dispatcher.dispatch({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload as Record<string, unknown>,
            tx,
            log: silentJobLogger,
          }),
        );
      }
    };

    const find = (
      q: string,
      options: Partial<Parameters<HelpCenterSearchService['search']>[0]> = {},
    ) =>
      search.search({
        brandId: seeded.brandId,
        audience: 'public',
        locale: 'en',
        q,
        limit: 10,
        offset: 0,
        source: 'help_center',
        ...options,
      });
    const titles = async (...args: Parameters<typeof find>) =>
      (await find(...args)).hits.map((hit) => hit.title);

    const newVisitor = async (): Promise<string> => {
      const response = await call<WidgetSession>(
        'POST',
        widgetUrl('/session'),
        { origin: SHOP },
        {},
      );
      expect(response.status).toBe(200);
      const secret = response.body.visitorSecret;
      if (secret === null) {
        throw new Error('a new visitor was not issued a secret');
      }
      return secret;
    };

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

      bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-hc-search-'));
      runtime = await createRuntime({
        env: envFor(),
        logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
      });
      app = await createApiApp({ runtime, objectStorage: new FakeStorage(bucket) });
      seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
      search = new HelpCenterSearchService(runtime.db);
      feedback = new HelpCenterFeedbackService(runtime.db);

      ada = { id: seeded.userId, email: seeded.email, token: '' };
      ada.token = await signIn(seeded.email, seeded.password);
      tia = await addPerson(runtime.db, 'Tia Leader');
      sam = await addPerson(runtime.db, 'Sam Agent');
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.insert(userBrandRoles).values([
          { userId: tia.id, brandId: seeded.brandId, role: 'team_leader' },
          { userId: sam.id, brandId: seeded.brandId, role: 'agent' },
        ]),
      );
      tia.token = await signIn(tia.email, STAFF_PASSWORD);
      sam.token = await signIn(sam.email, STAFF_PASSWORD);
      await ok('PUT', `/api/brands/${seeded.brandId}/widget/access`, ada, {
        allowedOrigins: [SHOP],
        captchaEnabled: false,
        captchaProvider: 'turnstile',
        captchaSiteKey: '',
      });

      const returns = await ok<HcCategory>('POST', hc('/categories'), ada, {
        names: { en: 'Returns & refunds', ar: 'الإرجاع والاسترداد' },
      });
      refunds = await ok<HcSection>('POST', hc('/sections'), ada, {
        categoryId: returns.id,
        names: { en: 'Refunds', ar: 'الاسترداد' },
      });
      refundTimelines = await write(
        refunds.id,
        'en',
        'Refund timelines',
        'We issue your refund as soon as the return reaches our warehouse. Card refunds land in three to five business days.',
      );
      await write(
        refunds.id,
        'ar',
        'مواعيد استرداد المبلغ',
        'بعد أن نستلم المنتج المُرجَع ونفحصه، نُصدر المبلغ المسترد إلى وسيلة الدفع الأصلية.',
        refundTimelines,
      );
      cancelling = await write(
        refunds.id,
        'en',
        'Cancelling an order',
        'You can cancel before we ship. A cancelled order is refunded the same day.',
      );
      chargebacks = await write(
        refunds.id,
        'en',
        'Handling chargeback notices',
        'Escalate every chargeback notice to the payments team within one business day.',
      );
      await ok('PUT', hc(`/articles/${chargebacks.id}/versions/en/visibility`), tia, {
        visibility: 'internal',
      });
      exchanges = await write(
        refunds.id,
        'en',
        'Exchanging a gift',
        'Use the gift receipt number instead of the order number.',
      );
      await runSubscriber();
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

    describe('search in English and Arabic (M5-05)', () => {
      it('finds an article by a word of its title, above one that only mentions it', async () => {
        const result = await find('refund');

        expect(result.hits.map((hit) => hit.title)).toEqual([
          'Refund timelines',
          'Cancelling an order',
        ]);
        expect(result.total).toBe(2);
        expect(result.hits[0]).toMatchObject({
          articleId: refundTimelines.id,
          slug: refundTimelines.slug,
          locale: 'en',
          sectionTitle: 'Refunds',
        });
      });

      it('cuts a plain-text snippet around the match', async () => {
        const [hit] = (await find('warehouse')).hits;

        expect(hit?.snippet).toContain('warehouse');
        expect(hit?.snippet).not.toMatch(/[<>]/);
      });

      it('stems English and matches the word being typed as a prefix', async () => {
        expect(await titles('refunded')).toContain('Cancelling an order');
        expect(await titles('timel')).toEqual(['Refund timelines']);
      });

      it('searches Arabic with the arabic configuration, diacritics or not', async () => {
        const arabic = { locale: 'ar' as const };

        expect(await titles('استرداد', arabic)).toContain('مواعيد استرداد المبلغ');
        expect(await titles('المُرجَع', arabic)).toContain('مواعيد استرداد المبلغ');
        expect((await find('استرداد', arabic)).hits[0]).toMatchObject({
          locale: 'ar',
          sectionTitle: 'الاسترداد',
        });
      });

      it('falls back to the default language for an article with no Arabic version', async () => {
        const [hit] = (await find('gift receipt', { locale: 'ar' })).hits;

        expect(hit).toMatchObject({ title: 'Exchanging a gift', locale: 'en' });
      });

      it('finds a title through a typo, on trigrams', async () => {
        expect(await titles('refnd timelnes')).toEqual(['Refund timelines']);
        expect(await titles('cancelin')).toEqual(['Cancelling an order']);
      });

      it('pages the ranking and says how many there were', async () => {
        const second = await find('refund', { limit: 1, offset: 1 });

        expect(second.hits.map((hit) => hit.title)).toEqual(['Cancelling an order']);
        expect(second.total).toBe(2);
      });

      it('logs a search with its hit count, a zero included, and not a suggestion or a later page', async () => {
        const logged = () =>
          withSystem(runtime.db, seeded.brandId, (tx) =>
            tx.select().from(hcSearchLog).where(eq(hcSearchLog.brandId, seeded.brandId)),
          );
        const found = await find('Refund  Timelines', { source: 'widget' });
        const nothing = await find('klarna');
        const before = (await logged()).length;
        const suggestion = await find('refund', { log: false });
        const secondPage = await find('refund', { offset: 1 });

        const rows = await logged();
        const byId = new Map(rows.map((row) => [row.id, row]));
        // "Cancelling an order" matches one of the two words, below the article that has both.
        expect(found.hits.map((hit) => hit.title)).toEqual([
          'Refund timelines',
          'Cancelling an order',
        ]);
        expect(byId.get(found.searchId ?? '')).toMatchObject({
          query: 'refund timelines',
          source: 'widget',
          hits: 2,
          locale: 'en',
        });
        expect(byId.get(nothing.searchId ?? '')).toMatchObject({ query: 'klarna', hits: 0 });
        expect(rows).toHaveLength(before);
        expect([suggestion.searchId, secondPage.searchId]).toEqual([null, null]);
      });

      it('answers nothing, and logs nothing, for a query with no word in it', async () => {
        expect(await find('?!')).toEqual({ hits: [], total: 0, searchId: null });
      });
    });

    describe('visibility (DOMAIN-RULES §5)', () => {
      it('never matches an internal article for the public audience, and lets staff find it', async () => {
        expect(await titles('chargeback')).toEqual([]);
        expect(await titles('chargebak')).toEqual([]);
        expect(await titles('chargeback', { audience: 'internal' })).toEqual([
          'Handling chargeback notices',
        ]);
      });

      it('stops matching a version made internal at once, before the subscriber has run', async () => {
        await ok('PUT', hc(`/articles/${exchanges.id}/versions/en/visibility`), tia, {
          visibility: 'internal',
        });

        expect(await titles('gift receipt')).toEqual([]);

        await ok('PUT', hc(`/articles/${exchanges.id}/versions/en/visibility`), tia, {
          visibility: 'public',
        });
        await runSubscriber();
        expect(await titles('gift receipt')).toEqual(['Exchanging a gift']);
      });

      it('matches nothing public while the help center is internal-only', async () => {
        await ok('PUT', hc('/settings'), tia, { access: 'internal_only' });
        await runSubscriber();

        expect(await titles('refund')).toEqual([]);
        expect(await titles('refund', { audience: 'internal' })).toContain('Refund timelines');

        await ok('PUT', hc('/settings'), tia, { access: 'public' });
        await runSubscriber();
        expect(await titles('refund')).toContain('Refund timelines');
      });
    });

    describe('keeping the index current', () => {
      const indexedLocales = async (articleId: string) =>
        (
          await withSystem(runtime.db, seeded.brandId, (tx) =>
            tx
              .select({ locale: hcSearchDocuments.locale })
              .from(hcSearchDocuments)
              .where(eq(hcSearchDocuments.articleId, articleId)),
          )
        ).map((row) => row.locale);

      it('removes an unpublished article from the index through its event, well inside 60 seconds', async () => {
        const temporary = await write(
          refunds.id,
          'en',
          'Seasonal returns',
          'Holiday returns window.',
        );
        await runSubscriber();
        expect(await titles('seasonal')).toEqual(['Seasonal returns']);

        const started = Date.now();
        await ok('PUT', hc(`/articles/${temporary.id}/versions/en/status`), tia, {
          status: 'draft',
        });
        await runSubscriber();

        expect(Date.now() - started).toBeLessThan(60_000);
        expect(await indexedLocales(temporary.id)).toEqual([]);
        expect(await titles('seasonal')).toEqual([]);
      });

      it('re-indexes a republished article with its new text', async () => {
        await ok('PUT', hc(`/articles/${cancelling.id}/versions/en`), tia, {
          title: 'Cancelling an order',
          description: '',
          bodyHtml: '<p>Cancel from the order page before it leaves the warehouse.</p>',
        });
        await ok('PUT', hc(`/articles/${cancelling.id}/versions/en/status`), tia, {
          status: 'published',
        });
        await runSubscriber();

        expect((await titles('order page'))[0]).toBe('Cancelling an order');
        expect(await titles('leaves the warehouse')).toContain('Cancelling an order');
      });

      it('rebuilds a lost index in the hourly reconcile, and changes nothing on a second run', async () => {
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.delete(hcSearchDocuments).where(eq(hcSearchDocuments.brandId, seeded.brandId)),
        );
        expect(await titles('refund')).toEqual([]);

        const process = createSearchKnowledgeProcessor({
          db: runtime.db,
          log: silentJobLogger,
          queue: { add: async () => {} },
        });
        const job = (tick: string) =>
          ({
            id: `reindex-${tick}`,
            name: helpCenterSearchReindexJob.name,
            data: { brandId: seeded.brandId, tick },
            attemptsMade: 0,
          }) as unknown as Job;
        await process(job('2026-10-01T06:00:00.000Z'));

        expect(await titles('refund')).toContain('Refund timelines');
        expect(await indexedLocales(refundTimelines.id)).toEqual(
          expect.arrayContaining(['en', 'ar']),
        );
        const before = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.select().from(hcSearchDocuments).where(eq(hcSearchDocuments.brandId, seeded.brandId)),
        );
        await process(job('2026-10-01T07:00:00.000Z'));
        const after = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.select().from(hcSearchDocuments).where(eq(hcSearchDocuments.brandId, seeded.brandId)),
        );
        expect(after.map((row) => row.indexedAt)).toEqual(before.map((row) => row.indexedAt));
      });
    });

    describe('views and votes (M5-08)', () => {
      const viewsOf = (articleId: string) =>
        withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.select().from(hcArticleViews).where(eq(hcArticleViews.articleId, articleId)),
        );

      it('counts one view per visitor per article per day', async () => {
        const ref = { brandId: seeded.brandId, articleId: exchanges.id, locale: 'en' as const };
        await feedback.recordView({ ...ref, visitorKey: 'cookie-1' });
        await feedback.recordView({ ...ref, visitorKey: 'cookie-1' });
        await feedback.recordView({ ...ref, visitorKey: 'cookie-2' });
        const tomorrow = new HelpCenterFeedbackService(
          runtime.db,
          () => new Date(Date.now() + 86_400_000),
        );
        await tomorrow.recordView({ ...ref, visitorKey: 'cookie-1' });

        const rows = await viewsOf(exchanges.id);
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((row) => row.visitorHash)).size).toBe(2);
      });

      it('ignores a view of an article that is not published', async () => {
        await feedback.recordView({
          brandId: seeded.brandId,
          articleId: exchanges.id,
          locale: 'ar',
          visitorKey: 'cookie-3',
        });

        expect((await viewsOf(exchanges.id)).filter((row) => row.locale === 'ar')).toEqual([]);
      });

      it('keeps one vote per visitor per version; a second replaces the first, comment included', async () => {
        const ref = {
          brandId: seeded.brandId,
          articleId: refundTimelines.id,
          locale: 'en' as const,
        };
        await feedback.recordVote({ ...ref, visitorKey: 'cookie-1', helpful: true });
        await feedback.recordVote({
          ...ref,
          visitorKey: 'cookie-1',
          helpful: false,
          comment: 'It did not say what to do with Apple Pay.',
        });
        await feedback.recordVote({ ...ref, visitorKey: 'cookie-2', helpful: true });
        await feedback.recordVote({ ...ref, locale: 'ar', visitorKey: 'cookie-1', helpful: true });

        const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select()
            .from(hcArticleFeedback)
            .where(eq(hcArticleFeedback.articleId, refundTimelines.id)),
        );
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.locale === 'en' && !row.helpful)).toMatchObject({
          comment: 'It did not say what to do with Apple Pay.',
        });
      });

      it('lists the most viewed readable articles first, never an internal one', async () => {
        const popular = await feedback.popular({
          brandId: seeded.brandId,
          audience: 'public',
          locale: 'en',
          limit: 10,
        });

        expect(popular[0]).toMatchObject({ articleId: exchanges.id, sectionTitle: 'Refunds' });
        expect(popular.map((article) => article.articleId)).not.toContain(chargebacks.id);
        expect(
          (
            await feedback.popular({
              brandId: seeded.brandId,
              audience: 'internal',
              locale: 'en',
              limit: 10,
            })
          ).map((article) => article.articleId),
        ).toContain(chargebacks.id);
      });
    });

    describe('the Insights tab (M5-08)', () => {
      it('reads top searches, searches with no results and article stats', async () => {
        const insights = await ok<HcInsights>('GET', hc('/insights?days=30'), sam);

        expect(insights.days).toBe(30);
        // "refund" is the query every section of this file started from.
        expect(insights.topSearches[0]).toMatchObject({ query: 'refund', locale: 'en' });
        expect(insights.topSearches[0]?.searches).toBeGreaterThan(1);
        expect(insights.topSearches.length).toBeLessThanOrEqual(10);
        expect(insights.zeroResultSearches).toEqual(
          expect.arrayContaining([expect.objectContaining({ query: 'klarna', searches: 1 })]),
        );
        expect(insights.articles.find((row) => row.articleId === refundTimelines.id)).toEqual({
          articleId: refundTimelines.id,
          title: 'Refund timelines',
          views: 0,
          helpful: 2,
          votes: 3,
          comments: 1,
        });
        // Two visitors today and one of them again tomorrow, from the views test.
        expect(insights.articles[0]).toMatchObject({ articleId: exchanges.id, views: 3 });
      });

      it('narrows to one language and sorts by the least helpful', async () => {
        const arabic = await ok<HcInsights>(
          'GET',
          hc('/insights?locale=ar&sort=least_helpful'),
          ada,
        );

        expect(arabic.locale).toBe('ar');
        expect(arabic.topSearches.every((row) => row.locale === 'ar')).toBe(true);
        expect(arabic.articles).toEqual([
          expect.objectContaining({ articleId: refundTimelines.id, votes: 1, helpful: 1 }),
        ]);

        const least = await ok<HcInsights>('GET', hc('/insights?sort=least_helpful'), ada);
        expect(least.articles[0]?.articleId).toBe(refundTimelines.id);
      });

      it('refuses a period it does not offer, and a request without a session', async () => {
        expect((await staff('GET', hc('/insights?days=12'), ada)).status).toBe(400);
        expect((await call('GET', hc('/insights'), {})).status).toBe(401);
      });
    });

    describe('the widget (M5-10)', () => {
      let secret: string;

      beforeAll(async () => {
        secret = await newVisitor();
      });

      it('lists popular public articles in the config', async () => {
        const config = await call<WidgetConfig>('GET', widgetUrl('/config?locale=en'), {
          origin: SHOP,
        });

        expect(config.status).toBe(200);
        expect(config.body.popularArticles[0]).toMatchObject({
          id: exchanges.id,
          title: 'Exchanging a gift',
          section: 'Refunds',
          url: null,
        });
        expect(config.body.popularArticles.map((article) => article.id)).not.toContain(
          chargebacks.id,
        );
      });

      it('searches public articles for a visitor and logs the search as the widget’s', async () => {
        const found = await call<WidgetArticleSearch>(
          'GET',
          widgetUrl('/articles?q=refund&locale=en'),
          asVisitor(secret),
        );
        const internal = await call<WidgetArticleSearch>(
          'GET',
          widgetUrl('/articles?q=chargeback&locale=en'),
          asVisitor(secret),
        );
        const suggestion = await call<WidgetArticleSearch>(
          'GET',
          widgetUrl('/articles?q=refund&locale=en&purpose=suggest'),
          asVisitor(secret),
        );

        expect(found.status).toBe(200);
        expect(found.body.articles[0]).toMatchObject({ id: refundTimelines.id, url: null });
        expect(found.body.searchId).toEqual(expect.any(String));
        expect(internal.body.articles).toEqual([]);
        expect(suggestion.body.searchId).toBeNull();
      });

      it('refuses a search without the visitor’s credential or from another origin', async () => {
        expect(
          (await call('GET', widgetUrl('/articles?q=refund&locale=en'), { origin: SHOP })).status,
        ).toBe(401);
        expect(
          (
            await call('GET', widgetUrl('/articles?q=refund&locale=en'), {
              ...asVisitor(secret),
              origin: 'https://evil.example.com',
            })
          ).status,
        ).toBe(403);
      });

      it('opens an article, counts the view once and marks the search as opened', async () => {
        const found = await call<WidgetArticleSearch>(
          'GET',
          widgetUrl('/articles?q=cancel&locale=en'),
          asVisitor(secret),
        );
        const url = widgetUrl(
          `/articles/${cancelling.id}?locale=en&searchId=${found.body.searchId}`,
        );
        const article = await call<WidgetArticle>('GET', url, asVisitor(secret));
        await call<WidgetArticle>('GET', url, asVisitor(secret));

        expect(article.status).toBe(200);
        expect(article.body).toMatchObject({
          id: cancelling.id,
          title: 'Cancelling an order',
          locale: 'en',
          section: 'Refunds',
          readingMinutes: 1,
        });
        expect(article.body.bodyHtml).toContain('order page');
        const views = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.select().from(hcArticleViews).where(eq(hcArticleViews.articleId, cancelling.id)),
        );
        expect(views).toHaveLength(1);
        const [logged] = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select()
            .from(hcSearchLog)
            .where(eq(hcSearchLog.id, found.body.searchId ?? '')),
        );
        expect(logged?.openedAt).not.toBeNull();
      });

      it('answers an Arabic reader in Arabic, and the default language when there is none', async () => {
        const arabic = await call<WidgetArticle>(
          'GET',
          widgetUrl(`/articles/${refundTimelines.id}?locale=ar`),
          asVisitor(secret),
        );
        const fallback = await call<WidgetArticle>(
          'GET',
          widgetUrl(`/articles/${cancelling.id}?locale=ar`),
          asVisitor(secret),
        );

        expect(arabic.body).toMatchObject({ locale: 'ar', title: 'مواعيد استرداد المبلغ' });
        expect(fallback.body).toMatchObject({ locale: 'en', title: 'Cancelling an order' });
      });

      it('answers not_found for an internal article, as for one that does not exist', async () => {
        for (const id of [chargebacks.id, uuidv7()]) {
          const response = await call<{ error: { widget: { reason: string } } }>(
            'GET',
            widgetUrl(`/articles/${id}?locale=en`),
            asVisitor(secret),
          );
          expect(response.status).toBe(404);
          expect(response.body.error.widget.reason).toBe('not_found');
        }
      });

      it('records "Still need help?" on the ticket for a public article, and nothing for an internal one', async () => {
        const startWith = (articleId: string) =>
          call<WidgetStartResponse>('POST', widgetUrl('/conversations'), asVisitor(secret), {
            clientId: uuidv7(),
            text: 'I still need help',
            articleId,
          });
        const fromPublic = await startWith(refundTimelines.id);
        const fromInternal = await startWith(chargebacks.id);
        expect(fromPublic.status).toBe(201);
        expect(fromInternal.status).toBe(201);

        const lines = await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx
            .select()
            .from(ticketActivity)
            .where(eq(ticketActivity.action, 'ticket.source_article')),
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          ticketId: fromPublic.body.conversation.id,
          to: { articleId: refundTimelines.id, title: 'Refund timelines', locale: 'en' },
        });
      });
    });

    describe('retention (DOMAIN-RULES §11)', () => {
      it('deletes the search log and the view rows past the brand’s window', async () => {
        const later = new Date(Date.now() + 200 * 86_400_000);
        const counts = await runBrandRetention({
          db: runtime.db,
          brandId: seeded.brandId,
          jobId: 'retention-test',
          now: later,
        });

        expect(counts.searchLog).toBeGreaterThan(0);
        const left = await withSystem(runtime.db, seeded.brandId, async (tx) => ({
          log: await tx.select().from(hcSearchLog).where(eq(hcSearchLog.brandId, seeded.brandId)),
          views: await tx
            .select()
            .from(hcArticleViews)
            .where(
              and(eq(hcArticleViews.brandId, seeded.brandId), gt(hcArticleViews.day, '2000-01-01')),
            ),
        }));
        expect(left).toEqual({ log: [], views: [] });
      });
    });
  },
);
