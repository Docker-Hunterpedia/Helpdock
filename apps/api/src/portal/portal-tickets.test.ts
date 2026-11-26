import { describe, expect, it, vi } from 'vitest';
import { normaliseHost } from '../domains/brand-host.js';
import { NoPageCache } from '../help-center/site/page-cache.js';
import {
  HelpCenterSite,
  PRIVATE_CACHE_CONTROL,
  type SiteRequest,
  type SiteResponse,
} from '../help-center/site/site.js';
import { HC_BRAND, memorySiteContent } from '../testing/help-center-site.js';
import {
  MemoryCaptcha,
  MemoryLimiter,
  MemoryPortalStore,
  type MemoryTicket,
  silentSecurityLog,
} from '../testing/memory-portal.js';
import { PortalSite } from './portal-site.js';
import { csrfKeyFrom, SESSION_TTL_MS } from './session-rules.js';

/**
 * The ticket list and the ticket page (M21-03) through `HelpCenterSite` over the
 * in-memory store: the routes, the guard, the headers, what each page draws and
 * what it must not. What the same code does against row-level security is
 * `portal-tickets.integration.test.ts`.
 */

const HOST = 'help.example.com';
const KNOWN = 'mona@acme.example';
const NOW = new Date('2026-11-26T12:00:00Z');
const ACME = 'account-acme';

const ticket = (over: Partial<MemoryTicket> & { reference: string }): MemoryTicket => ({
  subject: `Subject of ${over.reference}`,
  status: 'open',
  updatedAt: new Date('2026-11-26T10:00:00Z'),
  createdAt: new Date('2026-11-10T11:48:00Z'),
  channel: 'email',
  opener: { contactId: 'contact-mona', name: 'Mona' },
  accountId: ACME,
  private: false,
  messages: [],
  ...over,
});

const OMAR = { contactId: 'contact-omar', name: 'Omar Saleh' };

const fixtures = (): MemoryTicket[] => [
  ticket({
    reference: 'HD-1042',
    subject: 'Refund not received after 10 days, order 8841',
    status: 'waiting_you',
    updatedAt: new Date('2026-11-26T10:00:00Z'),
    messages: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
        by: { kind: 'contact', contactId: 'contact-mona', name: 'Mona' },
        at: new Date('2026-11-10T11:48:00Z'),
        text: 'Hello, I returned order 8841.\n\nStill no refund.',
        files: [
          {
            id: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
            name: 'return-label.pdf',
            mime: 'application/pdf',
            size: 1200,
          },
        ],
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000002',
        by: { kind: 'staff', name: 'Lina' },
        at: new Date('2026-11-10T14:10:00Z'),
        text: 'Card refunds take 3 to 5 business days.',
      },
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000003',
        by: { kind: 'brand' },
        at: new Date('2026-11-11T09:00:00Z'),
        text: 'An assistant answer.',
      },
    ],
  }),
  ticket({
    reference: 'HD-1038',
    status: 'waiting_us',
    updatedAt: new Date('2026-11-25T12:00:00Z'),
  }),
  ticket({ reference: 'HD-1031', private: true, updatedAt: new Date('2026-11-23T12:00:00Z') }),
  ticket({ reference: 'HD-1000', status: 'solved', updatedAt: new Date('2026-11-01T12:00:00Z') }),
  ticket({
    reference: 'HD-1047',
    subject: 'Bulk order discount for Q1',
    status: 'waiting_us',
    opener: OMAR,
    updatedAt: new Date('2026-11-26T11:40:00Z'),
    messages: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000010',
        by: { kind: 'contact', ...OMAR },
        at: new Date('2026-11-22T09:14:00Z'),
        text: 'We plan to order 400 units a month.',
      },
    ],
  }),
  ticket({ reference: 'HD-1050', opener: OMAR, private: true, subject: 'Payroll question' }),
  ticket({
    reference: 'HD-2000',
    subject: 'Another company',
    accountId: 'account-globex',
    opener: { contactId: 'contact-x', name: 'Xavier' },
  }),
  ticket({
    reference: 'HD-1066',
    subject: '<img src=x onerror=alert(1)>',
    messages: [
      {
        id: '0192c3f0-1a2b-7c3d-8e4f-000000000066',
        by: { kind: 'contact', contactId: 'contact-mona', name: 'Mona' },
        at: new Date('2026-11-12T08:00:00Z'),
        text: '<script>alert(2)</script> & "quotes"',
        files: [
          {
            id: '0192c3f0-1a2b-7c3d-8e4f-0000000000f6',
            name: '"><svg onload=alert(3)>.pdf',
            mime: 'application/pdf',
            size: 1,
          },
        ],
      },
    ],
  }),
];

const setup = (
  customer: Partial<Parameters<MemoryPortalStore['known']['set']>[1]> = {},
  tickets: MemoryTicket[] = fixtures(),
) => {
  const store = new MemoryPortalStore();
  store.known.set(KNOWN, {
    contactId: 'contact-mona',
    companyName: 'Acme Trading',
    accountId: ACME,
    visibility: 'all',
    role: 'member',
    ...customer,
  });
  store.seedBrandId = HC_BRAND;
  store.fixtures.push(...tickets);
  const clock = { now: NOW };
  const portal = new PortalSite({
    store,
    captcha: new MemoryCaptcha(),
    limiter: new MemoryLimiter(),
    csrfKey: csrfKeyFrom(Buffer.alloc(32, 7)),
    log: silentSecurityLog(),
    now: () => clock.now,
  });
  const site = new HelpCenterSite({
    content: memorySiteContent({ portalEnabled: true }).content,
    hosts: { brandOf: async (host) => (normaliseHost(host) === HOST ? HC_BRAND : null) },
    search: { search: async () => ({ hits: [], total: 0 }) },
    feedback: {
      recordView: async () => undefined,
      recordVote: async () => undefined,
      popular: async () => [],
    },
    cache: new NoPageCache(),
    staff: { readerOf: async () => null, spendPass: async () => null, cookieFor: async () => '' },
    appUrl: 'https://desk.example.com',
    imageSources: [],
    visitorSecret: 'secret',
    feedbackBudget: async () => true,
    portal,
    log: { warn: vi.fn() },
  });
  return { site, store, clock };
};

type Setup = ReturnType<typeof setup>;

const onHost = (path: string, extra: Partial<SiteRequest> = {}): SiteRequest => ({
  method: 'GET',
  host: HOST,
  path,
  byHost: true,
  query: {},
  headers: { origin: undefined },
  cookies: {},
  ip: '203.0.113.9',
  ...extra,
});

/** A signed-in browser: the store holds a session whose cookie value is `cookie`. */
const signedIn = (s: Setup): Record<string, string> => {
  const cookie = 'a'.repeat(43);
  s.store.seed(cookie, KNOWN, HOST, NOW);
  return { '__Host-hd_cs': cookie };
};

const get = (s: Setup, path: string, query: Record<string, string> = {}, cookies = signedIn(s)) =>
  s.site.handle(onHost(path, { query, cookies }));

/** What the page draws between the header and the footer; the shared stylesheet is not the page. */
const mainOf = (response: SiteResponse): string =>
  /<main[\s\S]*<\/main>/.exec(response.body)?.[0] ?? '';

const rowsOf = (response: SiteResponse): string[] =>
  [...response.body.matchAll(/class="hd-pt-ref" dir="ltr">([A-Z0-9-]+)</g)].map(
    (match) => match[1] ?? '',
  );

describe('GET /tickets', () => {
  it('sends a visitor to sign in and back', async () => {
    const s = setup();
    const response = await s.site.handle(onHost('/tickets'));
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/sign-in?lang=en&next=%2Ftickets');
  });

  it('lists Mine, open, newest change first, as private pages that are not indexed', async () => {
    const s = setup();
    const response = await get(s, '/tickets');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(rowsOf(response)).toEqual(['HD-1042', 'HD-1066', 'HD-1038', 'HD-1031']);
    expect(response.body).toContain('Waiting for you');
    expect(response.body).toContain('Waiting for us');
    expect(response.body).toContain('Only you');
    expect(response.body).not.toContain('Opened by');
    expect(response.body).not.toContain('HD-1047');
    expect(response.body).not.toContain('HD-2000');
  });

  it('draws the Mine and Company switch named after the account, with counts, when the account shows all tickets', async () => {
    const s = setup();
    const body = (await get(s, '/tickets')).body;

    expect(body).toContain('role="group"');
    expect(body).toMatch(/aria-current="true">Mine<span class="hd-pt-count">4<\/span>/);
    expect(body).toContain('Acme Trading<span class="hd-pt-count">');
    expect(body).toContain('People at Acme Trading can see the tickets you open here');
  });

  it('draws no switch and no notice for a customer who sees only their own tickets', async () => {
    const s = setup({ visibility: 'own' });
    const body = mainOf(await get(s, '/tickets'));

    expect(body).not.toContain('hd-pt-count');
    expect(body).not.toContain('can see the tickets you open here');
    expect(rowsOf(await get(s, '/tickets', { scope: 'company' }))).toEqual([
      'HD-1042',
      'HD-1066',
      'HD-1038',
      'HD-1031',
    ]);
  });

  it('shows the company: coworkers rows say who opened them, a private ticket of a coworker never shows', async () => {
    const s = setup();
    const response = await get(s, '/tickets', { scope: 'company' });

    expect(rowsOf(response)).toContain('HD-1047');
    expect(rowsOf(response)).not.toContain('HD-1050');
    expect(rowsOf(response)).not.toContain('HD-2000');
    expect(response.body).toContain('Opened by Omar Saleh');
    expect(response.body).toContain('Opened by you');
    expect(response.body).not.toContain('can see the tickets you open here');
  });

  it('tells a company manager why they see everything, on Company only', async () => {
    const s = setup({ visibility: 'managers', role: 'manager' });

    expect((await get(s, '/tickets', { scope: 'company' })).body).toContain(
      'You can see every ticket of Acme Trading because you are a company manager.',
    );
    expect((await get(s, '/tickets')).body).not.toContain('company manager');
  });

  it('splits Open and Solved and keeps the choice in the switch links', async () => {
    const s = setup();
    const solved = await get(s, '/tickets', { state: 'solved' });

    expect(rowsOf(solved)).toEqual(['HD-1000']);
    expect(solved.body).toContain('>Solved</span>');
    expect(solved.body).toMatch(
      /href="\/tickets\?lang=en&amp;state=solved"[^>]*aria-current="true">Solved/,
    );
  });

  it('searches subject and reference, in both spellings, within what the customer may see', async () => {
    const s = setup();

    expect(rowsOf(await get(s, '/tickets', { q: 'refund' }))).toEqual(['HD-1042']);
    expect(rowsOf(await get(s, '/tickets', { q: 'hd-1038' }))).toEqual(['HD-1038']);
    expect(rowsOf(await get(s, '/tickets', { q: '1031' }))).toEqual(['HD-1031']);
    expect(rowsOf(await get(s, '/tickets', { q: 'Another company' }))).toEqual([]);
    expect(rowsOf(await get(s, '/tickets', { q: 'payroll', scope: 'company' }))).toEqual([]);
  });

  it('says what is empty, and for a search says what was searched, escaped', async () => {
    const s = setup({}, []);

    expect((await get(s, '/tickets')).body).toContain('No open tickets');
    expect((await get(s, '/tickets', { state: 'solved' })).body).toContain('No solved tickets');
    const none = await get(s, '/tickets', { q: '<b>x</b>' });
    expect(none.body).toContain('No tickets match “&lt;b&gt;x&lt;/b&gt;”');
    expect(none.body).not.toContain('<b>x</b>');
  });

  it('pages 20 rows with a Show more link that works without script, and the cursor is stable', async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      ticket({
        reference: `HD-${String(2000 + index)}`,
        updatedAt: new Date(NOW.getTime() - index * 60_000),
      }),
    );
    const s = setup({}, many);
    const first = await get(s, '/tickets');
    const link = /href="([^"]*cursor=[^"]+)"/.exec(first.body)?.[1] ?? '';

    expect(rowsOf(first)).toHaveLength(20);
    expect(link).not.toBe('');
    const second = await get(
      s,
      '/tickets',
      Object.fromEntries(new URL(`https://x${link.replaceAll('&amp;', '&')}`).searchParams),
    );
    expect(rowsOf(second)).toEqual(['HD-2020', 'HD-2021', 'HD-2022', 'HD-2023', 'HD-2024']);
    expect(second.body).not.toContain('cursor=');
  });

  it('starts from the top for a forged cursor and ignores unknown scope and state', async () => {
    const s = setup();
    const forged = await get(s, '/tickets', { cursor: 'AAAA', scope: 'x', state: 'y' });

    expect(forged.status).toBe(200);
    expect(rowsOf(forged)).toHaveLength(4);
  });

  it('marks My tickets as the current item and draws the signed-in menu with a masked CSRF token that changes per response', async () => {
    const s = setup();
    const one = await get(s, '/tickets');
    const two = await get(s, '/tickets');
    const token = (r: SiteResponse) => /name="csrf" value="([^"]+)"/.exec(r.body)?.[1] ?? '';

    expect(one.body).toMatch(
      /<a class="hd-portal-link" href="\/tickets\?lang=en" aria-current="page">/,
    );
    expect(one.body).toContain('mona@acme.example');
    expect(token(one)).toMatch(/^[\w-]{43}\.[\w-]{43}$/);
    expect(token(one)).not.toBe(token(two));
  });

  it('draws Arabic, right to left, with the catalog words', async () => {
    const s = setup();
    const response = await get(s, '/tickets', { lang: 'ar' });

    expect(response.body).toContain('<html lang="ar" dir="rtl">');
    expect(response.body).toContain('بانتظارك');
    expect(response.body).toContain('أنت فقط');
    expect(response.body).toContain('المفتوحة');
    expect(response.body).toContain('يستطيع زملاؤك في Acme Trading');
  });

  it('renews the cookie when the store slid the session, on the list, a ticket and a 404', async () => {
    const renewed = (cookies: Record<string, string>) => [
      {
        name: '__Host-hd_cs',
        value: cookies['__Host-hd_cs'],
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: true,
      },
    ];
    for (const path of ['/tickets', '/tickets/HD-1042', '/tickets/HD-9999']) {
      const s = setup();
      const cookies = signedIn(s);
      s.clock.now = new Date(NOW.getTime() + 16 * 60_000);

      const response = await s.site.handle(onHost(path, { cookies }));
      expect(response.cookies, path).toEqual(renewed(cookies));
      // The slide was written, so the next request a moment later renews nothing.
      expect((await s.site.handle(onHost(path, { cookies }))).cookies, path).toEqual([]);
    }
  });
});

describe('GET /tickets/<ref>', () => {
  it('sends a visitor to sign in and back to that ticket', async () => {
    const s = setup();
    const response = await s.site.handle(onHost('/tickets/HD-1042'));
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/sign-in?lang=en&next=%2Ftickets%2FHD-1042');
  });

  it('reads the ticket: header, messages oldest first with who wrote them, attachments, back link', async () => {
    const s = setup();
    const response = await get(s, '/tickets/HD-1042');
    const body = response.body;

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(body).toContain(
      '<h1 class="hd-display hd-portal-h1 hd-pt-h1" id="hd-h1" tabindex="-1" dir="auto">Refund not received after 10 days, order 8841</h1>',
    );
    expect(body).toContain('>HD-1042<');
    expect(body).toContain('Waiting for you');
    expect(body).toContain('Opened by you · 10 Nov 2026 · by email');
    expect(body.indexOf('Hello, I returned')).toBeLessThan(body.indexOf('Card refunds take'));
    expect(body.indexOf('Card refunds take')).toBeLessThan(body.indexOf('An assistant answer'));
    expect(body).toContain(
      '<article class="hd-pt-msg" aria-label="Message from You, 10 Nov, 14:48">',
    );
    expect(body).toContain(
      '<bdi>Lina from Helpdock</bdi></strong><span class="hd-pt-tag">Support</span>',
    );
    expect(body).toContain('<bdi>Helpdock</bdi></strong><span class="hd-pt-tag">Support</span>');
    expect(body).toContain('<p>Hello, I returned order 8841.</p><p>Still no refund.</p>');
    expect(body).toContain(
      'href="/tickets/HD-1042/attachments/0192c3f0-1a2b-7c3d-8e4f-0000000000f1"',
    );
    expect(body).toContain('return-label.pdf');
    expect(body).toMatch(/class="hd-pt-back" href="\/tickets\?lang=en"/);
  });

  it('draws nothing of M21-04 and no internal field', async () => {
    const s = setup();
    const body = mainOf(await get(s, '/tickets/HD-1042'));

    for (const absent of [
      'Reply',
      'Attach files',
      'Mark as solved',
      'New ticket',
      'textarea',
      'How did we do',
      'priority',
      'assignee',
    ]) {
      expect(body, absent).not.toContain(absent);
    }
  });

  it("reads a coworker's ticket with the coworker's name, labelled Coworker", async () => {
    const s = setup();
    const body = (await get(s, '/tickets/HD-1047')).body;

    expect(body).toContain('Opened by Omar Saleh · 10 Nov 2026 · by email');
    expect(body).toContain('<bdi>Omar Saleh</bdi></strong><span class="hd-pt-tag">Coworker</span>');
  });

  it('reads the Arabic page with the board copy', async () => {
    const s = setup();
    const body = (await get(s, '/tickets/HD-1042', { lang: 'ar' })).body;

    expect(body).toContain('فتحتها أنت · 10 نوفمبر 2026 · بالبريد');
    expect(body).toContain('Lina من Helpdock');
    expect(body).toContain('الدعم');
    expect(body).toContain('بانتظارك');
  });

  it('escapes every value that reaches markup: subject, body and file name', async () => {
    const s = setup();
    const body = (await get(s, '/tickets/HD-1066')).body;

    expect(body).not.toContain('<img src=x');
    expect(body).not.toContain('<script>alert(2)');
    expect(body).not.toContain('<svg onload');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(body).toContain('&quot;&gt;&lt;svg onload=alert(3)&gt;.pdf');
  });

  it.each([
    ['one that does not exist', '/tickets/HD-9999'],
    ["another company's", '/tickets/HD-2000'],
    ["a coworker's private one", '/tickets/HD-1050'],
    ['a malformed reference', '/tickets/not-a-ref'],
    ['a reference with an injected tail', "/tickets/HD-1042'--"],
    ['a path that is neither the ticket nor a file', '/tickets/HD-1042/messages'],
    ['an attachment path of the wrong depth', '/tickets/HD-1042/attachments'],
  ])('answers the help center 404, private and not indexed, for %s', async (_name, path) => {
    const s = setup();
    const response = await get(s, path);

    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(response.body).toContain('We can’t find that page');
    expect(response.body).toContain('mona@acme.example');
  });

  it("answers an own-only customer's coworker ticket exactly as one that does not exist", async () => {
    const s = setup({ visibility: 'own' });
    const hidden = await get(s, '/tickets/HD-1047');
    const missing = await get(s, '/tickets/HD-9999');

    expect(hidden.status).toBe(404);
    expect(hidden.body.replace(/nonce="[^"]+"/g, '').replace(/value="[^"]+\.[^"]+"/g, '')).toBe(
      missing.body.replace(/nonce="[^"]+"/g, '').replace(/value="[^"]+\.[^"]+"/g, ''),
    );
  });

  it('never answers a POST on a ticket address', async () => {
    const s = setup();
    const response = await s.site.handle(
      onHost('/tickets/HD-1042', {
        method: 'POST',
        headers: { origin: `https://${HOST}` },
        body: {},
        cookies: signedIn(s),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /tickets/<ref>/attachments/<id>', () => {
  const FILE = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';

  it('redirects to the short-lived address of a file on a visible ticket, privately', async () => {
    const s = setup();
    const response = await get(s, `/tickets/HD-1042/attachments/${FILE}`);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/__e2e/file/return-label.pdf');
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
  });

  it.each([
    [
      'a file of another ticket',
      `/tickets/HD-1038/attachments/${'0192c3f0-1a2b-7c3d-8e4f-0000000000f1'}`,
    ],
    ['an unknown file', '/tickets/HD-1042/attachments/0192c3f0-1a2b-7c3d-8e4f-0000000000aa'],
    ['a file id that is not an id', '/tickets/HD-1042/attachments/..%2F..'],
    [
      'a file of a ticket that is not theirs',
      `/tickets/HD-2000/attachments/${'0192c3f0-1a2b-7c3d-8e4f-0000000000f1'}`,
    ],
  ])('answers 404 for %s', async (_name, path) => {
    const s = setup();
    const response = await get(s, path);

    expect(response.status).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it('sends a visitor to sign in without a next target the sign-in page would refuse', async () => {
    const s = setup();
    const response = await s.site.handle(onHost(`/tickets/HD-1042/attachments/${FILE}`));

    expect(response.status).toBe(303);
    expect(response.headers.location).toMatch(/^\/sign-in\?lang=en/);
  });
});

describe('the limits on a session’s reads', () => {
  const FILE = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';

  it('refuses the 121st page view in five minutes with a 429, private and with Retry-After, and counts the list and the ticket page together', async () => {
    const s = setup();
    const cookies = signedIn(s);
    for (let n = 0; n < 60; n += 1) {
      expect((await s.site.handle(onHost('/tickets', { cookies }))).status).toBe(200);
      expect((await s.site.handle(onHost('/tickets/HD-1042', { cookies }))).status).toBe(200);
    }

    const over = await s.site.handle(onHost('/tickets/HD-1042', { cookies }));
    expect(over.status).toBe(429);
    expect(over.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(over.headers['retry-after']).toBe('300');
    expect(over.body).not.toContain('Refund');
    expect((await s.site.handle(onHost('/tickets', { cookies }))).status).toBe(429);
  });

  it('keeps file fetches on a budget of their own: 60 in five minutes, apart from the pages', async () => {
    const s = setup();
    const cookies = signedIn(s);
    for (let n = 0; n < 60; n += 1) {
      expect(
        (await s.site.handle(onHost(`/tickets/HD-1042/attachments/${FILE}`, { cookies }))).status,
      ).toBe(303);
    }

    const over = await s.site.handle(onHost(`/tickets/HD-1042/attachments/${FILE}`, { cookies }));
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('300');
    // The pages are untouched by the files.
    expect((await s.site.handle(onHost('/tickets', { cookies }))).status).toBe(200);
  });

  it('counts per session: another session of the same customer has its own budget', async () => {
    const s = setup();
    const first = signedIn(s);
    for (let n = 0; n < 120; n += 1) {
      await s.site.handle(onHost('/tickets', { cookies: first }));
    }
    expect((await s.site.handle(onHost('/tickets', { cookies: first }))).status).toBe(429);

    s.store.seed('b'.repeat(43), KNOWN, HOST, NOW);
    const second = await s.site.handle(
      onHost('/tickets', { cookies: { '__Host-hd_cs': 'b'.repeat(43) } }),
    );
    expect(second.status).toBe(200);
  });
});
