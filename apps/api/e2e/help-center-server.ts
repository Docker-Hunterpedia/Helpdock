/**
 * The published help center (M5-03, M5-04) in a real browser without a
 * database: the api's own request handling, renderer, CSP, page cache and
 * fonts, over a Fastify server, with the help center held in memory
 * (`src/testing/help-center-site.ts`). What the pages do against Postgres and
 * Redis is `help-center-site.integration.test.ts`; what this server lets
 * Playwright prove is the pages themselves — both languages, the article's
 * feedback form, search, the states, axe.
 *
 * It runs the build (`pnpm --filter @helpdock/api build`), not the sources, as
 * `web-form-server.ts` does. Every page is on the fallback path,
 * `/hc/<HC_BRAND>/…`. A second port serves the same help center switched to
 * internal-only, for the wall `help-center-a11y.spec.ts` audits.
 *
 * Search and feedback are stand-ins for the ports: search finds the refund
 * article for any query with "refund" in it and nothing otherwise. The real
 * `HelpCenterSearchService` and `HelpCenterFeedbackService` behind these pages
 * are proved against Postgres in `help-center-site.integration.test.ts` and
 * `search.integration.test.ts`.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { NoPageCache } from '../dist/help-center/site/page-cache.js';
import { send, siteRequest } from '../dist/help-center/site/site.controller.js';
import { HelpCenterSite } from '../dist/help-center/site/site.js';
import { PortalSite } from '../dist/portal/portal-site.js';
import { csrfKeyFrom } from '../dist/portal/session-rules.js';
import { loadFonts } from '../dist/static/fonts.js';
import { articleId, memorySiteContent } from '../src/testing/help-center-site.ts';
import {
  MemoryCaptcha,
  MemoryLimiter,
  MemoryPortalStore,
  silentSecurityLog,
} from '../src/testing/memory-portal.ts';
import {
  HELP_CENTER_FONT_PORTS,
  HELP_CENTER_PORT,
  HELP_CENTER_PORTAL_PORT,
  HELP_CENTER_WALL_PORT,
  PORTAL_COMPANY,
} from './fixtures.ts';
import {
  IMPORTED_FILE_BYTES,
  IMPORTED_FILE_DOWNLOAD_PATH,
  withImportedArticle,
} from './imported-article.ts';
import {
  PORTAL_ACME_ACCOUNT,
  PORTAL_MANAGER,
  PORTAL_MONA,
  PORTAL_OWN_ONLY,
  portalMonaFor,
  portalTickets,
} from './portal-fixtures.ts';

const refundHits = [
  {
    articleId: articleId(1),
    slug: 'refund-timelines',
    locale: 'en',
    title: 'Refund timelines',
    snippet: 'Once we receive your return, we issue the refund.',
    sectionTitle: 'Refunds',
  },
];

const siteOver = (
  access: 'public' | 'internal_only',
  port: number,
  font?: 'noto-sans' | 'vazirmatn',
  portal?: PortalSite,
) =>
  new HelpCenterSite({
    content: withImportedArticle(
      memorySiteContent({ access, font, portalEnabled: portal !== undefined }).content,
    ),
    ...(portal === undefined ? {} : { portal }),
    hosts: { brandOf: async () => null },
    search: {
      search: async ({ q }: { q: string }) =>
        q.toLowerCase().includes('refund')
          ? { hits: refundHits, total: refundHits.length }
          : { hits: [], total: 0 },
    },
    feedback: {
      recordView: async () => undefined,
      recordVote: async () => undefined,
      popular: async () => [
        {
          articleId: articleId(5),
          slug: 'where-is-my-order',
          locale: 'en',
          title: 'Where is my order?',
          sectionTitle: 'Tracking',
        },
      ],
    },
    cache: new NoPageCache(),
    feedbackBudget: async () => true,
    staff: {
      readerOf: async () => null,
      spendPass: async () => null,
      cookieFor: async () => '',
    },
    appUrl: `http://127.0.0.1:${String(port)}`,
    imageSources: [],
    visitorSecret: 'e2e',
    log: { warn: () => undefined },
  } as never);

const fonts = loadFonts();

/**
 * The portal's stand-ins (M21-02): a store that knows one customer and lets any
 * other address in as a new one, so every browser test can use an address of its
 * own; a per-address limit and no per-IP limit, since every test comes from one
 * IP; and a few control routes to read the emailed link and age it.
 */
const portalStore = new MemoryPortalStore();
portalStore.newCustomers = true;
portalStore.known.set(PORTAL_MONA, {
  contactId: 'contact-mona',
  companyName: PORTAL_COMPANY,
  accountId: PORTAL_ACME_ACCOUNT,
  visibility: 'all',
  role: 'member',
});
for (const locale of ['en', 'ar'] as const) {
  portalStore.known.set(portalMonaFor(locale), {
    contactId: 'contact-mona',
    companyName: PORTAL_COMPANY,
    accountId: PORTAL_ACME_ACCOUNT,
    visibility: 'all',
    role: 'member',
  });
}
portalStore.known.set(PORTAL_OWN_ONLY, {
  contactId: 'contact-lena',
  companyName: PORTAL_COMPANY,
  accountId: PORTAL_ACME_ACCOUNT,
  visibility: 'own',
  role: 'member',
});
portalStore.known.set(PORTAL_MANAGER, {
  contactId: 'contact-maya',
  companyName: PORTAL_COMPANY,
  accountId: PORTAL_ACME_ACCOUNT,
  visibility: 'managers',
  role: 'manager',
});
portalStore.fixtures.push(...portalTickets(new Date()));
const portalLimiter = new MemoryLimiter();
const portalSite = new PortalSite({
  store: portalStore,
  captcha: new MemoryCaptcha(),
  limiter: {
    consume: (rule, subject) =>
      rule.bucket === 'portal-link-email'
        ? portalLimiter.consume(rule, subject)
        : Promise.resolve(true),
  },
  csrfKey: csrfKeyFrom(Buffer.alloc(32, 9)),
  log: silentSecurityLog(),
});

/** One Fastify server over `site`: its pages, its two forms and the fonts. */
const serve = async (site: HelpCenterSite, port: number): Promise<void> => {
  const server = Fastify();
  await server.register(cookie);
  server.get(IMPORTED_FILE_DOWNLOAD_PATH, async (_request, reply) =>
    reply
      .header('content-disposition', 'attachment; filename="original-manual.pdf"')
      .header('cache-control', 'private, no-store')
      .type('application/pdf')
      .send(IMPORTED_FILE_BYTES),
  );
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  server.get('/_hd/fonts/:file', async (request, reply) => {
    const found = fonts.get((request.params as { file: string }).file);
    if (found === undefined) {
      return reply.code(404).send();
    }
    return reply.type(found.contentType).send(found.body);
  });

  const page = async (request: FastifyRequest, reply: FastifyReply, method: 'GET' | 'POST') => {
    await send(
      reply,
      await site.handle(
        siteRequest(
          request,
          method,
          false,
          (request.query ?? {}) as Record<string, string>,
          method === 'POST' ? request.body : undefined,
        ),
      ),
    );
  };

  if (port === HELP_CENTER_PORTAL_PORT) {
    server.get('/__e2e/link', async (request, reply) => {
      const email = (request.query as { email?: string }).email ?? '';
      const link = [...portalStore.sent].reverse().find((sent) => sent.to === email);
      return reply.header('cache-control', 'no-store').send({ url: link?.url ?? null });
    });
    // Where the memory store's attachment redirect lands: a stand-in for the bucket's short-lived address.
    server.get('/__e2e/file/:name', async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .type('text/plain')
        .send(`file ${(request.params as { name: string }).name}`),
    );
    server.post('/__e2e/expire', async (request, reply) => {
      portalStore.expireLinks((request.query as { email?: string }).email ?? '');
      return reply.send({ ok: true });
    });
  }

  server.get('/hc/*', (request, reply) => page(request, reply, 'GET'));
  server.post('/hc/*', (request, reply) => page(request, reply, 'POST'));

  await server.listen({ port, host: '127.0.0.1' });
  process.stdout.write(`help center e2e server on http://127.0.0.1:${String(port)}\n`);
};

// The brands that picked Noto Sans and Vazirmatn, for help-center-brand-fonts.spec.ts.
for (const font of ['noto-sans', 'vazirmatn'] as const) {
  await serve(siteOver('public', HELP_CENTER_FONT_PORTS[font], font), HELP_CENTER_FONT_PORTS[font]);
}
// The internal-only twin first: Playwright starts the specs once the public one answers.
await serve(siteOver('internal_only', HELP_CENTER_WALL_PORT), HELP_CENTER_WALL_PORT);
await serve(
  siteOver('public', HELP_CENTER_PORTAL_PORT, undefined, portalSite),
  HELP_CENTER_PORTAL_PORT,
);
await serve(siteOver('public', HELP_CENTER_PORT), HELP_CENTER_PORT);
