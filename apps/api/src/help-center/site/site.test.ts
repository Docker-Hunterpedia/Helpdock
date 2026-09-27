import { describe, expect, it, vi } from 'vitest';
import {
  articleId,
  HC_BRAND,
  HC_OTHER_BRAND,
  type MemorySiteOptions,
  memorySiteContent,
} from '../../testing/help-center-site.js';
import { RedisStub } from '../../testing/redis-stub.js';
import type { SearchHit } from '../ports.js';
import { RedisPageCache } from './page-cache.js';
import {
  HelpCenterSite,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  pickLocale,
  type SiteRequest,
  VISITOR_COOKIE,
} from './site.js';
import { STAFF_COOKIE } from './staff-access.js';

const BASE = `/hc/${HC_BRAND}`;
const HOST = 'help.example.com';

interface Setup extends MemorySiteOptions {
  hits?: SearchHit[];
}

const setup = (options: Setup = {}) => {
  const memory = memorySiteContent(options);
  const tree = vi.spyOn(memory.content, 'tree');
  const feedback = {
    recordView: vi.fn(() => Promise.resolve()),
    recordVote: vi.fn(() => Promise.resolve()),
    popular: vi.fn(() =>
      Promise.resolve([
        {
          articleId: articleId(5),
          slug: 'where-is-my-order',
          locale: 'en' as const,
          title: 'Where is my order?',
          sectionTitle: 'Tracking',
        },
      ]),
    ),
  };
  const search = {
    search: vi.fn(() =>
      Promise.resolve({
        hits: options.hits ?? [],
        total: options.hits?.length ?? 0,
        searchId: 'search-1',
      }),
    ),
  };
  const site = new HelpCenterSite({
    content: memory.content,
    hosts: {
      brandOf: (host) =>
        Promise.resolve(
          host === HOST ? HC_BRAND : host === 'help.other.test' ? HC_OTHER_BRAND : null,
        ),
    },
    search,
    feedback,
    cache: new RedisPageCache(new RedisStub().asRedis()),
    staff: {
      readerOf: (cookie) =>
        Promise.resolve(
          cookie === 'staff' ? { staffId: articleId(900), name: 'Lina Haddad' } : null,
        ),
      spendPass: (token) =>
        Promise.resolve(
          token === 'good-pass-token-1234'
            ? {
                staffId: articleId(900),
                familyId: 'fam',
                name: 'Lina Haddad',
                brandId: HC_BRAND,
                path: '/en/articles/approving-large-refunds',
              }
            : null,
        ),
      cookieFor: () => Promise.resolve('signed-cookie'),
    },
    appUrl: 'https://desk.example.com',
    imageSources: ['https://bucket.s3.example.com'],
    visitorSecret: 'secret',
    log: { warn: vi.fn() },
  });
  return { site, memory, tree, feedback, search };
};

const request = (path: string, extra: Partial<SiteRequest> = {}): SiteRequest => ({
  method: 'GET',
  host: 'desk.example.com',
  path,
  byHost: false,
  query: {},
  headers: {},
  cookies: {},
  ip: '203.0.113.9',
  ...extra,
});

const nonceOf = (csp: string | undefined): string => /'nonce-([^']+)'/.exec(csp ?? '')?.[1] ?? '';

describe('HelpCenterSite pages', () => {
  it('answers the home page publicly, in the language of its path, with SEO tags', async () => {
    const { site } = setup();
    const response = await site.handle(request(`${BASE}/en`));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(response.headers.etag).toMatch(/^"[\w-]+"$/);
    expect(response.body).toContain('<html lang="en" dir="ltr">');
    expect(response.body).toContain('How can we help?');
    expect(response.body).toContain('Returns &amp; refunds');
    expect(response.body).toContain(
      `<link rel="canonical" href="https://desk.example.com${BASE}/en">`,
    );
    expect(response.body).toContain(`hreflang="ar" href="https://desk.example.com${BASE}/ar"`);
    expect(response.body).toContain('hreflang="x-default"');
    expect(response.body).toContain('"@type":"WebSite"');
    // Featured and popular lists, and the brand's header and footer links.
    expect(response.body).toContain('Where is my order?');
    expect(response.body).toContain('https://www.example.com/privacy');
    expect(response.body).not.toContain('noindex');
  });

  it('mirrors the Arabic page and names the other language in its own script', async () => {
    const { site } = setup();
    const response = await site.handle(request(`${BASE}/ar`));

    expect(response.body).toContain('<html lang="ar" dir="rtl">');
    expect(response.body).toContain('كيف يمكننا مساعدتك؟');
    expect(response.body).toContain(
      `href="${BASE}/en" lang="en" hreflang="en" dir="ltr">English</a>`,
    );
  });

  it('puts one fresh nonce in the CSP and the page, and never serves the placeholder', async () => {
    const { site } = setup();
    const first = await site.handle(request(`${BASE}/en`));
    const second = await site.handle(request(`${BASE}/en`));
    const nonce = nonceOf(first.headers['content-security-policy']);

    expect(nonce).not.toBe('');
    expect(first.body).toContain(`<style nonce="${nonce}">`);
    expect(first.body).not.toContain('__hd_nonce__');
    expect(nonceOf(second.headers['content-security-policy'])).not.toBe(nonce);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(first.headers['content-security-policy']).toContain("script-src 'none'");
    expect(first.headers['content-security-policy']).toContain(
      "img-src 'self' data: https://bucket.s3.example.com",
    );
  });

  it('serves a repeat from the cache, and answers 304 to a matching ETag', async () => {
    const { site, tree } = setup();
    const first = await site.handle(request(`${BASE}/en/categories/returns-and-refunds`));
    const calls = tree.mock.calls.length;
    const again = await site.handle(request(`${BASE}/en/categories/returns-and-refunds`));
    const conditional = await site.handle(
      request(`${BASE}/en/categories/returns-and-refunds`, {
        headers: { ifNoneMatch: first.headers.etag },
      }),
    );

    expect(tree.mock.calls.length).toBe(calls);
    expect(again.body.replaceAll(nonceOf(again.headers['content-security-policy']), 'N')).toBe(
      first.body.replaceAll(nonceOf(first.headers['content-security-policy']), 'N'),
    );
    expect(conditional.status).toBe(304);
    expect(conditional.body).toBe('');
  });

  it('draws a category with its sections and a section with all its articles', async () => {
    const { site } = setup();
    const category = await site.handle(request(`${BASE}/en/categories/returns-and-refunds`));
    const section = await site.handle(request(`${BASE}/en/sections/refunds`));

    expect(category.body).toContain('Starting a return');
    expect(category.body).toContain('"@type":"BreadcrumbList"');
    expect(category.body).toContain('aria-current="page">Returns &amp; refunds');
    expect(section.status).toBe(200);
    expect(section.body).toContain('Refund timelines');
    expect(section.body).not.toContain('Approving large refunds');
  });

  it('renders an article with its body, feedback form, and structured data, and counts the view', async () => {
    const { site, feedback } = setup();
    const response = await site.handle(request(`${BASE}/en/articles/refund-timelines`));

    expect(response.status).toBe(200);
    expect(response.body).toContain('<h1 class="hd-display">Refund timelines</h1>');
    expect(response.body).toContain(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(response.body).toContain(
      'sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"',
    );
    // A link between articles gets the fallback's base.
    expect(response.body).toContain(`href="${BASE}/en/articles/how-to-start-a-return"`);
    expect(response.body).toContain('Was this article helpful?');
    expect(response.body).toContain(`action="${BASE}/_hd/feedback"`);
    expect(response.body).toContain('"@type":"Article"');
    expect(response.body).toContain(
      `href="/contact/${HC_BRAND}?lang=en&amp;article=${articleId(1)}"`,
    );
    expect(feedback.recordView).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: HC_BRAND, articleId: articleId(1), locale: 'en' }),
    );
    const [[view]] = feedback.recordView.mock.calls as unknown as [[{ visitorKey: string }]];
    expect(view.visitorKey).toMatch(/^h:[\w-]{22}$/);

    await site.handle(request(`${BASE}/en/articles/refund-timelines`));
    expect(feedback.recordView).toHaveBeenCalledTimes(2);
  });

  it('shows the default language with a notice when the article is not in the one asked for', async () => {
    const { site } = setup();
    const response = await site.handle(request(`${BASE}/ar/articles/how-to-start-a-return`));

    expect(response.status).toBe(200);
    expect(response.body).toContain('هذه المقالة غير متوفرة باللغة العربية بعد.');
    expect(response.body).toContain('<article class="hd-stack hd-gap-20" lang="en" dir="ltr">');
    expect(response.body).toContain(
      `<link rel="canonical" href="https://desk.example.com${BASE}/en/articles/how-to-start-a-return">`,
    );
    expect(response.body).not.toContain('hreflang="ar"');
  });

  it('answers 404 to a visitor for an internal or draft article, and 410 for an archived one', async () => {
    const { site } = setup();
    const internal = await site.handle(request(`${BASE}/en/articles/approving-large-refunds`));
    const draft = await site.handle(request(`${BASE}/en/articles/exchanging-a-gift`));
    const archived = await site.handle(request(`${BASE}/en/articles/returning-sale-items`));

    expect(internal.status).toBe(404);
    expect(internal.body).toContain('We can’t find that page');
    expect(internal.body).not.toContain('Approving large refunds');
    expect(internal.headers['x-robots-tag']).toBe('noindex');
    expect(draft.status).toBe(404);
    expect(archived.status).toBe(410);
    expect(archived.body).toContain('“Returning items bought on sale” was retired on 3 Sep 2026');
    expect(archived.body).toContain('More in Starting a return');
  });

  it('shows staff the internal article with its badge, privately and never from the cache', async () => {
    const { site, feedback } = setup();
    const response = await site.handle(
      request(`${BASE}/en/articles/approving-large-refunds`, {
        cookies: { [STAFF_COOKIE]: 'staff' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers.etag).toBeUndefined();
    expect(response.body).toContain('Approving large refunds');
    expect(response.body).toContain('Internal');
    expect(response.body).toContain('Lina Haddad');
    expect(response.body).toContain('<meta name="robots" content="noindex">');
    expect(feedback.recordView).not.toHaveBeenCalled();

    const visitor = await site.handle(request(`${BASE}/en/articles/approving-large-refunds`));
    expect(visitor.status).toBe(404);
  });

  it('walls every page of an internal-only help center with a 401 until staff sign in', async () => {
    const { site } = setup({ access: 'internal_only' });
    const home = await site.handle(request(`${BASE}/en`));
    const article = await site.handle(
      request(`${BASE}/en/articles/refund-timelines`, { query: { q: 'x' } }),
    );
    const staff = await site.handle(
      request(`${BASE}/en`, { cookies: { [STAFF_COOKIE]: 'staff' } }),
    );

    expect(home.status).toBe(401);
    expect(home.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(home.body).toContain('Sign in to read the team knowledge base');
    expect(home.body).toContain('Helpdock Team KB');
    expect(article.body).toContain(
      `https://desk.example.com/help-center/open?brand=${HC_BRAND}&amp;path=%2Fen%2Farticles%2Frefund-timelines%3Fq%3Dx`,
    );
    expect(staff.status).toBe(200);
    expect(staff.body).toContain('Refund timelines');
  });

  it('publishes a sitemap and robots.txt, and withholds the sitemap when internal-only', async () => {
    const { site } = setup();
    const sitemap = await site.handle(request(`${BASE}/sitemap.xml`));
    const robots = await site.handle(request(`${BASE}/robots.txt`));

    expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(sitemap.body).toContain(
      `<loc>https://desk.example.com${BASE}/en/articles/refund-timelines</loc>`,
    );
    expect(sitemap.body).toContain('hreflang="ar"');
    expect(sitemap.body).not.toContain('approving-large-refunds');
    expect(robots.body).toContain(`Sitemap: https://desk.example.com${BASE}/sitemap.xml`);

    const closed = setup({ access: 'internal_only' }).site;
    expect((await closed.handle(request(`${BASE}/sitemap.xml`))).status).toBe(404);
    expect((await closed.handle(request(`${BASE}/robots.txt`))).body).toBe(
      'User-agent: *\nDisallow: /\n',
    );
  });

  it('redirects the bare address to the reader’s language', async () => {
    const { site } = setup();
    const response = await site.handle(
      request(`${BASE}/`, { headers: { acceptLanguage: 'ar-SA,ar;q=0.9,en;q=0.8' } }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${BASE}/ar`);
  });
});

describe('HelpCenterSite search', () => {
  it('shows the empty state for a query with no results, never cached and never indexed', async () => {
    const { site, search } = setup();
    const response = await site.handle(
      request(`${BASE}/en/search`, { query: { q: 'warranty claim' } }),
    );

    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: HC_BRAND,
        audience: 'public',
        locale: 'en',
        q: 'warranty claim',
        source: 'help_center',
        log: true,
      }),
    );
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.body).toContain('No results for “warranty claim”');
    expect(response.body).toContain('<meta name="robots" content="noindex">');
  });

  it('searches the internal audience for staff and keeps it out of the search log', async () => {
    const { site, search } = setup();
    await site.handle(
      request(`${BASE}/en/search`, {
        query: { q: 'refund' },
        cookies: { [STAFF_COOKIE]: 'staff' },
      }),
    );

    expect(search.search).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'internal', log: false }),
    );
  });

  it('marks the words of the query in the results and counts them per topic', async () => {
    const { site } = setup({
      hits: [
        {
          articleId: articleId(1),
          slug: 'refund-timelines',
          locale: 'en',
          title: 'Refund timelines',
          snippet: 'We issue the <refund> quickly.',
          sectionTitle: 'Refunds',
        },
      ],
    });
    const response = await site.handle(request(`${BASE}/en/search`, { query: { q: 'refund' } }));

    expect(response.body).toContain(`href="${BASE}/en/articles/refund-timelines?sid=search-1"`);
    expect(response.body).toContain('<mark>Refund</mark> timelines');
    expect(response.body).toContain('We issue the &lt;<mark>refund</mark>&gt; quickly.');
    expect(response.body).toContain('1 result in English');
    expect(response.body).toContain(`${BASE}/en/search?q=refund&amp;topic=returns-and-refunds`);
  });
});

describe('HelpCenterSite forms and staff', () => {
  it('names the search a view came from, and counts none for staff', async () => {
    const { site, feedback } = setup();
    await site.handle(
      request(`${BASE}/en/articles/refund-timelines`, { query: { sid: 'search-1' } }),
    );
    await site.handle(
      request(`${BASE}/en/articles/refund-timelines`, { cookies: { [STAFF_COOKIE]: 'staff' } }),
    );

    expect(feedback.recordView).toHaveBeenCalledOnce();
    expect(feedback.recordView).toHaveBeenCalledWith(
      expect.objectContaining({ searchId: 'search-1' }),
    );
  });

  it('thanks staff for a vote without counting it', async () => {
    const { site, feedback } = setup();
    const response = await site.handle(
      request(`${BASE}/_hd/feedback`, {
        method: 'POST',
        cookies: { [STAFF_COOKIE]: 'staff' },
        body: { article: articleId(1), locale: 'en', slug: 'refund-timelines', helpful: 'yes' },
      }),
    );

    expect(response.status).toBe(303);
    expect(feedback.recordVote).not.toHaveBeenCalled();
  });

  it('records a vote with a first-party visitor cookie and returns to the article', async () => {
    const { site, feedback } = setup();
    const response = await site.handle(
      request(`${BASE}/_hd/feedback`, {
        method: 'POST',
        headers: { origin: 'https://desk.example.com' },
        body: { article: articleId(1), locale: 'en', slug: 'refund-timelines', helpful: 'no' },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      `${BASE}/en/articles/refund-timelines?feedback=1#feedback`,
    );
    const cookie = response.cookies.find((candidate) => candidate.name === VISITOR_COOKIE);
    expect(cookie?.value).toMatch(/^[\w-]{22}$/);
    expect(cookie?.path).toBe(BASE);
    expect(feedback.recordVote).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: articleId(1),
        helpful: false,
        visitorKey: `c:${cookie?.value}`,
      }),
    );

    const thanked = await site.handle(
      request(`${BASE}/en/articles/refund-timelines`, { query: { feedback: '1' } }),
    );
    expect(thanked.body).toContain('Thank you.');
    expect(thanked.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('refuses a vote from another origin, and one for an article the visitor may not read', async () => {
    const { site, feedback } = setup();
    const foreign = await site.handle(
      request(`${BASE}/_hd/feedback`, {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: { article: articleId(1), locale: 'en', slug: 'refund-timelines', helpful: 'yes' },
      }),
    );
    const hidden = await site.handle(
      request(`${BASE}/_hd/feedback`, {
        method: 'POST',
        body: {
          article: articleId(3),
          locale: 'en',
          slug: 'approving-large-refunds',
          helpful: 'yes',
        },
      }),
    );

    expect(foreign.status).toBe(403);
    expect(hidden.status).toBe(404);
    expect(feedback.recordVote).not.toHaveBeenCalled();
  });

  it('exchanges a staff pass for the staff cookie once, and signs out', async () => {
    const { site } = setup();
    const spent = await site.handle(
      request(`${BASE}/_hd/staff`, { query: { pass: 'good-pass-token-1234' } }),
    );
    const bad = await site.handle(request(`${BASE}/_hd/staff`, { query: { pass: 'nope' } }));
    const out = await site.handle(request(`${BASE}/_hd/sign-out`, { method: 'POST', body: {} }));

    expect(spent.status).toBe(303);
    expect(spent.headers.location).toBe(`${BASE}/en/articles/approving-large-refunds`);
    expect(spent.cookies).toEqual([
      { name: STAFF_COOKIE, value: 'signed-cookie', path: BASE, maxAge: 28_800, secure: true },
    ]);
    expect(bad.status).toBe(403);
    expect(out.cookies[0]).toMatchObject({ name: STAFF_COOKIE, value: '', maxAge: 0 });
  });

  it('previews the working copy for staff with the banner, and never for a visitor', async () => {
    const { site } = setup();
    const staff = await site.handle(
      request(`${BASE}/en/articles/exchanging-a-gift`, {
        query: { preview: '1' },
        cookies: { [STAFF_COOKIE]: 'staff' },
      }),
    );
    const visitor = await site.handle(
      request(`${BASE}/en/articles/exchanging-a-gift`, { query: { preview: '1' } }),
    );

    expect(staff.status).toBe(200);
    expect(staff.body).toContain('Draft preview');
    expect(staff.body).toContain(`https://desk.example.com/help-center/articles/${articleId(6)}`);
    expect(staff.body).not.toContain('Was this article helpful?');
    expect(staff.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(visitor.status).toBe(404);
  });
});

describe('HelpCenterSite hosts', () => {
  it('serves the brand’s own host at the root, and nothing on a host that is no help center', async () => {
    const { site } = setup();
    const own = await site.handle(request('/en', { host: HOST, byHost: true }));
    const stranger = await site.handle(request('/en', { host: 'nobody.test', byHost: true }));

    expect(own.status).toBe(200);
    expect(own.body).toContain('<link rel="canonical" href="https://help.example.com/en">');
    expect(own.body).toContain('href="/contact?lang=en"');
    expect(stranger.status).toBe(404);
    expect(await site.servesHost(HOST)).toBe(true);
    expect(await site.servesHost('nobody.test')).toBe(false);
  });

  it('never serves one brand’s help center on another brand’s domain', async () => {
    const { site } = setup();
    const response = await site.handle(request(`${BASE}/en`, { host: 'help.other.test' }));

    expect(response.status).toBe(404);
  });

  it('loads the widget and opens it from "Chat with us" only where the brand allows it', async () => {
    const { site } = setup({ widgetOrigins: ['https://desk.example.com'] });
    const response = await site.handle(request(`${BASE}/en/articles/refund-timelines`));

    expect(response.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
    expect(response.body).toContain(
      `<script type="module" src="/widget.js" data-brand="${HC_BRAND}"`,
    );
    expect(response.body).toContain(
      `data-hd-chat="{&quot;article&quot;:&quot;${articleId(1)}&quot;}"`,
    );
  });

  it('adds the brand’s sanitised custom CSS after the page styles', async () => {
    const { site } = setup({ customCss: '.hd-header { border-block-end-width: 2px; }' });
    const response = await site.handle(request(`${BASE}/en`));

    expect(response.body).toMatch(
      /\.hd-footer[\s\S]*\.hd-header \{ border-block-end-width: 2px; \}<\/style>/,
    );
  });
});

describe('pickLocale', () => {
  it('takes the reader’s best-ranked language the help center speaks', () => {
    expect(pickLocale('fr-FR,ar;q=0.8,en;q=0.9', 'ar')).toBe('en');
    expect(pickLocale('fr', 'ar')).toBe('ar');
    expect(pickLocale(undefined, 'en')).toBe('en');
    expect(pickLocale('ar;q=0', 'en')).toBe('en');
  });
});
