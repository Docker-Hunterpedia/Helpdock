import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  brandDomains,
  createDb,
  type Db,
  type DbHandle,
  hcArticleFeedback,
  hcArticleViews,
  hcSearchLog,
  outbox,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_SITE_CHANGED_EVENT,
  type HcArticle,
  type HcCategory,
  type HcCustomCssResult,
  type HcSection,
  type HcSite,
  type HcStaffPassResponse,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';
import { FakeStorage } from '../../testing/media.js';
import { signInForTest } from '../../testing/staff-sign-in.js';
import { reindexArticles } from '../search/search-index.js';
import { createPageCacheHandler } from './cache-events.js';
import { generationKey, RedisPageCache } from './page-cache.js';
import { PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL, VISITOR_COOKIE } from './site.js';
import { STAFF_COOKIE } from './staff-access.js';

/**
 * M5-03, M5-04 and M5-06 against a real Postgres and Redis, through the api's
 * own routes:
 *
 * 1. **By host and by fallback path**: the brand's verified domain answers at
 *    the root, the install's host under `/hc/<brandId>`; caching headers, the
 *    ETag and a 304.
 * 2. **By audience**: a visitor gets a 404 for an internal article; staff,
 *    after the staff pass, read it privately; an internal-only help center
 *    walls a visitor with a 401.
 * 3. **The page cache**: a cached page survives until the article is
 *    unpublished and the page cache's handler runs on the event.
 * 4. **SEO**: the sitemap and robots.txt on the host.
 * 5. **Search, views and feedback** (M5-05, M5-08): the search page over
 *    the real index, by audience, with its empty state; a view opened from a
 *    search and a vote reach their tables.
 * 6. **Settings** (M5-06): the cards save, refuse what DESIGN §8 refuses,
 *    sanitise the custom CSS, are audited, announce `site_changed`, and reach
 *    the page.
 * 7. **M5's exit criteria** short of real TLS: an article in both languages on
 *    the brand's host, a sitemap Postgres parses as valid XML, search in both
 *    languages, and an article toggled from public to internal gone from the
 *    sitemap, public search and every public page the cache holds.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;
const HOST = 'help.acme.test';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M5 help center pages integration tests: Docker is not available.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

type Method = 'GET' | 'POST' | 'PUT';

describe.skipIf(!hasDocker)('the help center pages (M5-03, M5-04, M5-06)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let ada: Person;
  let sam: Person;
  let since: Date;

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

  const call = async <T>(
    method: Method,
    url: string,
    who: Person | null,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return {
      status: response.statusCode,
      body: (response.body === '' ? undefined : response.json()) as T,
    };
  };

  const ok = async <T>(method: Method, url: string, who: Person, payload?: unknown): Promise<T> => {
    const response = await call<T>(method, url, who, payload);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return response.body;
  };

  const hc = (suffix: string) => `/api/brands/${seeded.brandId}/help-center${suffix}`;

  /** A page as a browser on the brand's domain asks for it. */
  const page = (
    url: string,
    options: { cookies?: Record<string, string>; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host: HOST, ...options.headers },
      ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
    });

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

  const publishArticle = async (
    sectionId: string,
    title: string,
    body: string,
    visibility: 'public' | 'internal' = 'public',
  ): Promise<HcArticle> => {
    const article = await ok<HcArticle>('POST', hc('/articles'), ada, {
      sectionId,
      locale: 'en',
      title,
    });
    await ok('PUT', hc(`/articles/${article.id}/versions/en`), ada, {
      title,
      description: `${title}.`,
      bodyHtml: body,
    });
    if (visibility === 'internal') {
      await ok('PUT', hc(`/articles/${article.id}/versions/en/visibility`), ada, { visibility });
    }
    await ok('PUT', hc(`/articles/${article.id}/versions/en/status`), ada, { status: 'published' });
    return article;
  };

  /** What the worker's page cache subscription does with every help center event since `since`. */
  const deliverPageEvents = async (): Promise<number> => {
    const handler = createPageCacheHandler(new RedisPageCache(runtime.redis));
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(
        and(
          inArray(outbox.event, [
            HC_ARTICLE_CHANGED_EVENT,
            HC_ACCESS_CHANGED_EVENT,
            HC_SITE_CHANGED_EVENT,
          ]),
          gt(outbox.createdAt, since),
        ),
      );
    for (const row of rows) {
      await handler({
        outboxId: row.id,
        brandId: row.brandId,
        event: row.event,
        payload: row.payload as Record<string, unknown>,
        tx: undefined as never,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      });
    }
    since = new Date();
    return rows.length;
  };

  /** The staff pass, spent on the brand's domain: the staff cookie it sets. */
  const staffCookie = async (who: Person, body: Record<string, unknown> = {}): Promise<string> => {
    const pass = await ok<HcStaffPassResponse>('POST', hc('/staff-pass'), who, body);
    const url = new URL(pass.url);
    expect(url.host).toBe(HOST);
    const exchange = await page(`${url.pathname}${url.search}`);
    expect(exchange.statusCode).toBe(303);
    const cookie = exchange.cookies.find((candidate) => candidate.name === STAFF_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    return cookie?.value ?? '';
  };

  let refunds: HcSection;
  let publicArticle: HcArticle;
  let internalArticle: HcArticle;

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

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime, objectStorage: new FakeStorage('/tmp/helpdock-hc-site') });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    ada.token = await signIn(seeded.email, seeded.password);
    sam = await addPerson(runtime.db, 'Sam Agent');
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values({ userId: sam.id, brandId: seeded.brandId, role: 'agent' }),
    );
    sam.token = await signIn(sam.email, STAFF_PASSWORD);

    await owner.db.insert(brandDomains).values({
      brandId: seeded.brandId,
      domain: HOST,
      kind: 'helpcenter',
      verifiedAt: new Date(),
      isPrimary: true,
      txtToken: 'helpdock-verify=test',
    });

    const returns = await ok<HcCategory>('POST', hc('/categories'), ada, {
      names: { en: 'Returns & refunds', ar: 'الإرجاع والاسترداد' },
    });
    refunds = await ok<HcSection>('POST', hc('/sections'), ada, {
      categoryId: returns.id,
      names: { en: 'Refunds', ar: 'المبالغ المستردة' },
    });
    publicArticle = await publishArticle(
      refunds.id,
      'Refund timelines',
      '<p>Three to five days.</p>',
    );
    internalArticle = await publishArticle(
      refunds.id,
      'Approving large refunds',
      '<p>Team leads approve.</p>',
      'internal',
    );
    since = new Date();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('by host and by path', () => {
    it('answers the brand’s domain at the root, in the reader’s language', async () => {
      const root = await page('/', { headers: { 'accept-language': 'ar' } });
      const home = await page('/en');

      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe('/ar');
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(home.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
      expect(home.headers['content-security-policy']).toMatch(/style-src 'self' 'nonce-/);
      expect(home.body).toContain('<link rel="canonical" href="https://help.acme.test/en">');
      expect(home.body).toContain('Returns &amp; refunds');
    });

    it('answers 304 to a matching ETag', async () => {
      const first = await page(`/en/articles/${publicArticle.slug}`);
      const again = await page(`/en/articles/${publicArticle.slug}`, {
        headers: { 'if-none-match': String(first.headers.etag) },
      });

      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('Three to five days.');
      expect(again.statusCode).toBe(304);
    });

    it('serves a brand without a domain on the install’s host under its fallback path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/hc/${seeded.brandId}/ar`,
        headers: { host: 'support.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<html lang="ar" dir="rtl">');
      // Its links stay on the fallback; its canonical is the brand's domain, now that it has one.
      expect(response.body).toContain(`href="/hc/${seeded.brandId}/ar/categories/`);
      expect(response.body).toContain('<link rel="canonical" href="https://help.acme.test/ar">');
    });
  });

  describe('by audience', () => {
    it('answers a visitor 404 for an internal article, and staff read it privately after the pass', async () => {
      const visitor = await page(`/en/articles/${internalArticle.slug}`);
      expect(visitor.statusCode).toBe(404);
      expect(visitor.body).not.toContain('Approving large refunds');
      expect(visitor.headers['x-robots-tag']).toBe('noindex');

      const cookie = await staffCookie(sam, { path: `/en/articles/${internalArticle.slug}` });
      const staff = await page(`/en/articles/${internalArticle.slug}`, {
        cookies: { [STAFF_COOKIE]: cookie },
      });
      expect(staff.statusCode).toBe(200);
      expect(staff.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(staff.headers.etag).toBeUndefined();
      expect(staff.body).toContain('Approving large refunds');
      expect(staff.body).toContain('Sam Agent');

      // A cookie from another host, or a forged one, is a visitor.
      const forged = await page(`/en/articles/${internalArticle.slug}`, {
        cookies: { [STAFF_COOKIE]: `${cookie.slice(0, -4)}AAAA` },
      });
      expect(forged.statusCode).toBe(404);
    });

    it('lands the editor’s Preview on the working copy', async () => {
      const draft = await ok<HcArticle>('POST', hc('/articles'), ada, {
        sectionId: refunds.id,
        locale: 'en',
        title: 'A draft about exchanges',
      });
      const cookie = await staffCookie(ada, { preview: { articleId: draft.id, locale: 'en' } });
      const preview = await page(`/en/articles/${draft.slug}`, {
        cookies: { [STAFF_COOKIE]: cookie },
        headers: {},
      });
      const withFlag = await app.inject({
        method: 'GET',
        url: `/en/articles/${draft.slug}?preview=1`,
        headers: { host: HOST },
        cookies: { [STAFF_COOKIE]: cookie },
      });

      expect(preview.statusCode).toBe(404);
      expect(withFlag.statusCode).toBe(200);
      expect(withFlag.body).toContain('Draft preview');
      expect(withFlag.body).toContain('A draft about exchanges');
    });
  });

  describe('the page cache', () => {
    it('keeps a public page until the article is unpublished and the event is handled', async () => {
      const article = await publishArticle(refunds.id, 'Cached for now', '<p>Soon gone.</p>');
      await deliverPageEvents();
      expect((await page(`/en/articles/${article.slug}`)).statusCode).toBe(200);

      await ok('PUT', hc(`/articles/${article.id}/versions/en/status`), ada, { status: 'draft' });
      // Still the cached copy: nothing has told the cache yet.
      expect((await page(`/en/articles/${article.slug}`)).statusCode).toBe(200);

      expect(await deliverPageEvents()).toBeGreaterThan(0);
      const after = await page(`/en/articles/${article.slug}`);
      expect(after.statusCode).toBe(404);
      expect(after.body).not.toContain('Soon gone.');
    });
  });

  describe('SEO', () => {
    it('publishes the public articles in the sitemap and names it in robots.txt', async () => {
      const sitemap = await page('/sitemap.xml');
      const robots = await page('/robots.txt');

      expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
      expect(sitemap.body).toContain(
        `<loc>https://help.acme.test/en/articles/${publicArticle.slug}</loc>`,
      );
      expect(sitemap.body).not.toContain(internalArticle.slug);
      expect(robots.body).toContain('Sitemap: https://help.acme.test/sitemap.xml');
    });
  });

  describe('search, views and feedback (M5-05, M5-08)', () => {
    it('finds the public article for a visitor, the internal one for staff, and says when nothing matched', async () => {
      await withSystem(runtime.db, seeded.brandId, (tx) => reindexArticles(tx));

      const visitor = await page('/en/search?q=refunds');
      expect(visitor.statusCode).toBe(200);
      expect(visitor.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(visitor.body).toContain(`/en/articles/${publicArticle.slug}?sid=`);
      expect(visitor.body).not.toContain(internalArticle.slug);

      const cookie = await staffCookie(sam);
      const staff = await page('/en/search?q=refunds', { cookies: { [STAFF_COOKIE]: cookie } });
      expect(staff.body).toContain(`/en/articles/${internalArticle.slug}`);

      const nothing = await page('/en/search?q=warranty');
      expect(nothing.statusCode).toBe(200);
      expect(nothing.body).toContain('No results for “warranty”');
    });

    it('counts a view opened from a search, marks the search opened, and records a vote', async () => {
      const results = await page('/en/search?q=timelines');
      const searchId = /\?sid=([0-9a-f-]{36})/.exec(results.body)?.[1];
      expect(searchId).toBeDefined();

      const article = await page(`/en/articles/${publicArticle.slug}?sid=${String(searchId)}`, {
        headers: { 'user-agent': 'a reader' },
      });
      expect(article.statusCode).toBe(200);
      const vote = await app.inject({
        method: 'POST',
        url: '/_hd/feedback',
        headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          article: publicArticle.id,
          locale: 'en',
          slug: publicArticle.slug,
          helpful: 'yes',
        }).toString(),
      });
      expect(vote.statusCode).toBe(303);

      const [logged, views, votes] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        Promise.all([
          tx
            .select()
            .from(hcSearchLog)
            .where(eq(hcSearchLog.id, String(searchId))),
          tx.select().from(hcArticleViews).where(eq(hcArticleViews.articleId, publicArticle.id)),
          tx
            .select()
            .from(hcArticleFeedback)
            .where(eq(hcArticleFeedback.articleId, publicArticle.id)),
        ]),
      );
      expect(logged[0]?.openedAt).not.toBeNull();
      expect(views.length).toBeGreaterThan(0);
      expect(votes.map((row) => row.helpful)).toEqual([true]);
    });

    it('records a "No", then the note from the "What was missing?" step on the same vote (M9-04)', async () => {
      const post = (fields: Record<string, string>, cookie?: string) =>
        app.inject({
          method: 'POST',
          url: '/_hd/feedback',
          headers: {
            host: HOST,
            'content-type': 'application/x-www-form-urlencoded',
            ...(cookie === undefined ? {} : { cookie }),
          },
          payload: new URLSearchParams({
            article: publicArticle.id,
            locale: 'en',
            slug: publicArticle.slug,
            helpful: 'no',
            ...fields,
          }).toString(),
        });

      const first = await post({});
      expect(first.headers.location).toMatch(/\?feedback=no#hd-feedback-comment$/);
      const visitor = first.cookies.find((cookie) => cookie.name === VISITOR_COOKIE);
      expect(visitor).toBeDefined();
      const asking = await page(`/en/articles/${publicArticle.slug}?feedback=no`);
      expect(asking.body).toContain('name="comment"');

      const second = await post(
        { comment: '  Nothing about Apple Pay.  ' },
        `${VISITOR_COOKIE}=${String(visitor?.value)}`,
      );
      expect(second.headers.location).toMatch(/\?feedback=1#feedback$/);

      const votes = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(hcArticleFeedback)
          .where(
            and(
              eq(hcArticleFeedback.articleId, publicArticle.id),
              eq(hcArticleFeedback.helpful, false),
            ),
          ),
      );
      expect(votes.map((row) => row.comment)).toEqual(['Nothing about Apple Pay.']);
    });
  });

  describe('M5 exit criteria, on the brand’s host', () => {
    const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
    const TITLES = { en: 'Exchange windows', ar: 'مواعيد الاستبدال' } as const;
    const BODIES = {
      en: '<p>You have thirty days to exchange an item.</p>',
      ar: '<p>لديك ثلاثون يومًا لاستبدال المنتج.</p>',
    } as const;
    let exchanges: HcCategory;
    let bilingual: HcArticle;

    /** One `xpath` over the sitemap, parsed by Postgres's own XML parser. */
    const sitemapPath = async (body: string, path: string): Promise<string[]> => {
      const rows = await owner.db.execute<{ value: string }>(
        sql`SELECT unnest(xpath(${path}, XMLPARSE(DOCUMENT ${body}), ARRAY[ARRAY['s', ${SITEMAP_NS}], ARRAY['x', 'http://www.w3.org/1999/xhtml']]))::text AS value`,
      );
      return rows.map((row) => row.value);
    };

    beforeAll(async () => {
      exchanges = await ok<HcCategory>('POST', hc('/categories'), ada, {
        names: { en: 'Exchanges', ar: 'الاستبدال' },
      });
      const section = await ok<HcSection>('POST', hc('/sections'), ada, {
        categoryId: exchanges.id,
        names: { en: 'Sizes', ar: 'المقاسات' },
      });
      bilingual = await ok<HcArticle>('POST', hc('/articles'), ada, {
        sectionId: section.id,
        locale: 'en',
        title: TITLES.en,
      });
      for (const locale of ['en', 'ar'] as const) {
        await ok('PUT', hc(`/articles/${bilingual.id}/versions/${locale}`), ada, {
          title: TITLES[locale],
          description: `${TITLES[locale]}.`,
          bodyHtml: BODIES[locale],
        });
        await ok('PUT', hc(`/articles/${bilingual.id}/versions/${locale}/status`), ada, {
          status: 'published',
        });
      }
      await deliverPageEvents();
      await withSystem(runtime.db, seeded.brandId, (tx) => reindexArticles(tx));
    });

    it('answers a published article in both languages on support.<brand>, with a valid sitemap', async () => {
      for (const [locale, other, dir] of [
        ['en', 'ar', 'ltr'],
        ['ar', 'en', 'rtl'],
      ] as const) {
        const response = await page(`/${locale}/articles/${bilingual.slug}`);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
        expect(response.body).toContain(`<html lang="${locale}" dir="${dir}">`);
        expect(response.body).toContain(TITLES[locale]);
        expect(response.body).toContain(
          `<link rel="canonical" href="https://${HOST}/${locale}/articles/${bilingual.slug}">`,
        );
        expect(response.body).toContain(
          `<link rel="alternate" hreflang="${other}" href="https://${HOST}/${other}/articles/${bilingual.slug}">`,
        );
      }

      const sitemap = await page('/sitemap.xml');
      expect(sitemap.statusCode).toBe(200);
      const [wellFormed] = await owner.db.execute<{ ok: boolean }>(
        sql`SELECT xml_is_well_formed_document(${sitemap.body}) AS ok`,
      );
      expect(wellFormed?.ok).toBe(true);
      const urls = await sitemapPath(sitemap.body, 'count(/s:urlset/s:url)');
      const locs = await sitemapPath(sitemap.body, '/s:urlset/s:url/s:loc/text()');
      // Every <url> has exactly one <loc>, absolute, on this host, and none twice.
      expect(locs).toHaveLength(Number(urls[0]));
      expect(new Set(locs).size).toBe(locs.length);
      expect(locs.every((loc) => loc.startsWith(`https://${HOST}/`))).toBe(true);
      for (const locale of ['en', 'ar'] as const) {
        const loc = `https://${HOST}/${locale}/articles/${bilingual.slug}`;
        expect(locs).toContain(loc);
        const alternates = await sitemapPath(
          sitemap.body,
          `/s:urlset/s:url[s:loc="${loc}"]/x:link[@rel="alternate"]/@hreflang`,
        );
        expect(alternates.sort()).toEqual(['ar', 'en']);
        const [lastmod] = await sitemapPath(
          sitemap.body,
          `/s:urlset/s:url[s:loc="${loc}"]/s:lastmod/text()`,
        );
        expect(Number.isNaN(Date.parse(lastmod ?? ''))).toBe(false);
      }
    });

    it('finds the article from the help center’s search in English and in Arabic', async () => {
      const english = await page('/en/search?q=exchange');
      const arabic = await page(`/ar/search?q=${encodeURIComponent('الاستبدال')}`);

      expect(english.statusCode).toBe(200);
      expect(english.body).toContain(`/en/articles/${bilingual.slug}?sid=`);
      expect(arabic.statusCode).toBe(200);
      expect(arabic.body).toContain(`/ar/articles/${bilingual.slug}?sid=`);
    });

    it('drops an article toggled from public to internal from the sitemap, public search and every public cached page', async () => {
      const cachedPaths = [
        ...(['en', 'ar'] as const).map((locale) => `/${locale}/articles/${bilingual.slug}`),
        ...(['en', 'ar'] as const).map((locale) => `/${locale}/categories/${exchanges.slug}`),
        '/sitemap.xml',
      ];
      for (const path of cachedPaths) {
        const before = await page(path);
        expect(before.statusCode, path).toBe(200);
        expect(before.body, path).toContain(bilingual.slug);
      }

      for (const locale of ['en', 'ar'] as const) {
        await ok('PUT', hc(`/articles/${bilingual.id}/versions/${locale}/visibility`), ada, {
          visibility: 'internal',
        });
      }
      // Search filters visibility in SQL before ranking, so it needs no event.
      for (const [locale, q] of [
        ['en', 'exchange'],
        ['ar', 'الاستبدال'],
      ] as const) {
        const search = await page(`/${locale}/search?q=${encodeURIComponent(q)}`);
        expect(search.body).not.toContain(bilingual.slug);
        expect(search.body).not.toContain(TITLES[locale]);
      }

      expect(await deliverPageEvents()).toBeGreaterThan(0);

      for (const path of cachedPaths) {
        const after = await page(path);
        expect(after.body, path).not.toContain(bilingual.slug);
        for (const title of Object.values(TITLES)) {
          expect(after.body, path).not.toContain(title);
        }
      }
      for (const locale of ['en', 'ar'] as const) {
        const article = await page(`/${locale}/articles/${bilingual.slug}`);
        expect(article.statusCode).toBe(404);
      }

      // What the page cache holds for visitors now, read from Redis itself:
      // nothing in the current generation names the article.
      const generation = (await runtime.redis.get(generationKey(seeded.brandId))) ?? '0';
      const keys = await runtime.redis.keys(`hc:page:${seeded.brandId}:${generation}:public:*`);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const stored = (await runtime.redis.get(key)) ?? '';
        expect(stored).not.toContain(bilingual.slug);
        for (const title of Object.values(TITLES)) {
          expect(stored).not.toContain(title);
        }
      }

      // Staff still read it.
      const cookie = await staffCookie(ada);
      const staff = await page(`/ar/articles/${bilingual.slug}`, {
        cookies: { [STAFF_COOKIE]: cookie },
      });
      expect(staff.statusCode).toBe(200);
      expect(staff.body).toContain(TITLES.ar);
    });
  });

  describe('site settings (M5-06)', () => {
    it('saves the theme and refuses an accent below 3:1', async () => {
      const refused = await call<{ error: { helpCenter?: { reason: string } } }>(
        'PUT',
        hc('/site/appearance'),
        ada,
        {
          theme: {
            accent: '#FFFF00',
            surfaceTone: 'warm',
            radius: 6,
            mode: 'light',
            font: 'ibm-plex',
          },
          logoMediaId: null,
          faviconMediaId: null,
        },
      );
      expect(refused.status).toBe(422);
      expect(refused.body.error.helpCenter?.reason).toBe('low-contrast');

      await ok('PUT', hc('/site/appearance'), ada, {
        theme: {
          accent: '#2B5FB3',
          surfaceTone: 'cool',
          radius: 10,
          mode: 'auto',
          font: 'ibm-plex',
        },
        logoMediaId: null,
        faviconMediaId: null,
      });
      const missingLogo = await call('PUT', hc('/site/appearance'), ada, {
        theme: {
          accent: '#2B5FB3',
          surfaceTone: 'cool',
          radius: 10,
          mode: 'auto',
          font: 'ibm-plex',
        },
        logoMediaId: uuidv7(),
        faviconMediaId: null,
      });
      expect(missingLogo.status).toBe(422);

      await deliverPageEvents();
      const home = await page('/en');
      expect(home.body).toContain('--hd-action-primary: #2B5FB3;');
      expect(home.body).toContain('--hd-radius-md: 10px;');
    });

    it('sanitises custom CSS on save, says what it removed, and renders what it kept', async () => {
      const result = await ok<HcCustomCssResult>('PUT', hc('/site/custom-css'), ada, {
        css: '@import url("https://x.test/a.css");\n.hd-header { border-block-end-width: 2px; }\n.bar { position: fixed; }',
      });

      expect(result.css).toBe('.hd-header { border-block-end-width: 2px; }');
      expect(result.removed.map((entry) => entry.reason)).toEqual(['import', 'fixed']);
      await deliverPageEvents();
      expect((await page('/en')).body).toContain(
        '.hd-header { border-block-end-width: 2px; }</style>',
      );
    });

    it('saves the home page and the links, and refuses a featured article that is not the brand’s', async () => {
      await ok('PUT', hc('/site/home'), ada, {
        categories: true,
        featured: true,
        featuredArticleIds: [publicArticle.id],
        popular: false,
      });
      await ok('PUT', hc('/site/links'), ada, {
        header: [{ labelEn: 'Main site', labelAr: '', url: 'https://acme.test' }],
        footer: [{ labelEn: 'Privacy', labelAr: 'الخصوصية', url: 'https://acme.test/privacy' }],
      });
      const unknown = await call('PUT', hc('/site/home'), ada, {
        categories: true,
        featured: true,
        featuredArticleIds: [uuidv7()],
        popular: true,
      });
      expect(unknown.status).toBe(422);

      const site = await ok<HcSite>('GET', hc('/site'), sam);
      expect(site.home.featuredArticleIds).toEqual([publicArticle.id]);
      expect(site.links.footer[0]?.url).toBe('https://acme.test/privacy');
      expect(site.url).toBe('https://help.acme.test/');
      expect(site.appearance.theme.accent).toBe('#2B5FB3');

      await deliverPageEvents();
      const home = await page('/en');
      expect(home.body).toContain('https://acme.test/privacy');
      expect(home.body).toContain('Featured');
    });

    it('audits every card and announces it, and lets only an Admin or a Team Leader save', async () => {
      const audited = await owner.db
        .select({ meta: auditLog.meta })
        .from(auditLog)
        .where(
          and(eq(auditLog.brandId, seeded.brandId), eq(auditLog.action, 'hc_settings.updated')),
        );
      const cards = audited.map((row) => (row.meta as { card?: string }).card).filter(Boolean);
      expect(new Set(cards)).toEqual(new Set(['appearance', 'custom_css', 'home', 'links']));

      const events = await owner.db
        .select({ id: outbox.id })
        .from(outbox)
        .where(eq(outbox.event, HC_SITE_CHANGED_EVENT));
      expect(events.length).toBeGreaterThanOrEqual(4);

      expect((await call('PUT', hc('/site/links'), sam, { header: [], footer: [] })).status).toBe(
        403,
      );
    });
  });

  describe('internal-only', () => {
    it('walls every page with a 401 for a visitor, withdraws the sitemap, and lets staff in', async () => {
      await ok('PUT', hc('/settings'), ada, { access: 'internal_only' });
      await deliverPageEvents();

      const home = await page('/en');
      expect(home.statusCode).toBe(401);
      expect(home.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(home.body).toContain('https://support.example.com/help-center/open?brand=');
      expect((await page('/sitemap.xml')).statusCode).toBe(404);
      expect((await page('/robots.txt')).body).toBe('User-agent: *\nDisallow: /\n');

      const cookie = await staffCookie(ada);
      const staff = await page('/en', { cookies: { [STAFF_COOKIE]: cookie } });
      expect(staff.statusCode).toBe(200);
      expect(staff.body).toContain('Team KB');

      await ok('PUT', hc('/settings'), ada, { access: 'public' });
      await deliverPageEvents();
    });
  });
});
