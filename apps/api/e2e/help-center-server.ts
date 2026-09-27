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
 * `/hc/<HC_BRAND>/…`.
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
import { loadFonts } from '../dist/static/fonts.js';
import { articleId, memorySiteContent } from '../src/testing/help-center-site.ts';
import { HELP_CENTER_PORT } from './fixtures.ts';

const memory = memorySiteContent();

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

const site = new HelpCenterSite({
  content: memory.content,
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
  staff: {
    readerOf: async () => null,
    spendPass: async () => null,
    cookieFor: async () => '',
  },
  appUrl: `http://127.0.0.1:${String(HELP_CENTER_PORT)}`,
  imageSources: [],
  visitorSecret: 'e2e',
  log: { warn: () => undefined },
} as never);

const fonts = loadFonts();
const server = Fastify();
await server.register(cookie);
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

server.get('/hc/*', (request, reply) => page(request, reply, 'GET'));
server.post('/hc/*', (request, reply) => page(request, reply, 'POST'));

await server.listen({ port: HELP_CENTER_PORT, host: '127.0.0.1' });
process.stdout.write(`help center e2e server on http://127.0.0.1:${String(HELP_CENTER_PORT)}\n`);
