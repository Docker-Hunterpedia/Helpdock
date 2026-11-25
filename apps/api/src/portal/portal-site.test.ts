import { describe, expect, it, vi } from 'vitest';
import { NoPageCache } from '../help-center/site/page-cache.js';
import {
  HelpCenterSite,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_CACHE_CONTROL,
  type SiteRequest,
  type SiteResponse,
} from '../help-center/site/site.js';
import { HC_BRAND, memorySiteContent } from '../testing/help-center-site.js';
import {
  MemoryCaptcha,
  MemoryLimiter,
  MemoryPortalStore,
  silentSecurityLog,
} from '../testing/memory-portal.js';
import { PortalSite, userAgentFamily } from './portal-site.js';
import { csrfKeyFrom, SIGN_IN_TOKEN_TTL_MS } from './session-rules.js';

const HOST = 'help.example.com';
const BASE = `/hc/${HC_BRAND}`;
const KNOWN = 'mona@acme.example';

const setup = (options: { portal?: boolean; appUrl?: string } = {}) => {
  const store = new MemoryPortalStore();
  store.known.set(KNOWN, { contactId: 'contact-mona', companyName: 'Acme Trading' });
  const captcha = new MemoryCaptcha();
  const log = silentSecurityLog();
  const clock = { now: new Date('2026-11-26T10:00:00Z') };
  const portal = new PortalSite({
    store,
    captcha,
    limiter: new MemoryLimiter(),
    csrfKey: csrfKeyFrom(Buffer.alloc(32, 7)),
    log,
    now: () => clock.now,
  });
  const site = new HelpCenterSite({
    content: memorySiteContent({ portalEnabled: options.portal ?? true }).content,
    hosts: { brandOf: async (host) => (host === HOST ? HC_BRAND : null) },
    search: { search: async () => ({ hits: [], total: 0 }) },
    feedback: {
      recordView: async () => undefined,
      recordVote: async () => undefined,
      popular: async () => [],
    },
    cache: new NoPageCache(),
    staff: { readerOf: async () => null, spendPass: async () => null, cookieFor: async () => '' },
    appUrl: options.appUrl ?? 'https://desk.example.com',
    imageSources: [],
    visitorSecret: 'secret',
    feedbackBudget: async () => true,
    portal,
    log: { warn: vi.fn() },
  });
  return { site, store, captcha, log, clock };
};

type Setup = ReturnType<typeof setup>;

/** A request on the brand's own host. */
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

const form = (path: string, body: Record<string, string>, extra: Partial<SiteRequest> = {}) =>
  onHost(path, { method: 'POST', headers: { origin: `https://${HOST}` }, body, ...extra });

const cookiesOf = (response: SiteResponse): Record<string, string> =>
  Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));

const csrfOf = (response: SiteResponse): string =>
  /name="csrf" value="([^"]+)"/.exec(response.body)?.[1] ?? '';

/** The body without the per-response nonce, so two answers can be compared. */
const sameShape = (body: string): string => body.replace(/nonce="[^"]+"/g, 'nonce=""');

/** Opens the form, posts an address, and runs the work after the response. */
const requestLink = async (
  s: Setup,
  email: string,
  extra: { lang?: string; ip?: string; next?: string; pow?: string } = {},
): Promise<SiteResponse> => {
  const opened = await s.site.handle(
    onHost('/sign-in', { query: { lang: extra.lang }, ip: extra.ip ?? '203.0.113.9' }),
  );
  const response = await s.site.handle(
    form(
      '/sign-in',
      {
        email,
        csrf: csrfOf(opened),
        lang: extra.lang ?? 'en',
        ...(extra.next === undefined ? {} : { next: extra.next }),
        ...(extra.pow === undefined ? {} : { hd_pow: extra.pow }),
      },
      { cookies: cookiesOf(opened), ip: extra.ip ?? '203.0.113.9' },
    ),
  );
  await response.after?.();
  return response;
};

const tokenOf = (url: string): string => new URL(url).searchParams.get('token') ?? '';

/** Follows the emailed link and presses Continue; returns the response of the press. */
const signIn = async (
  s: Setup,
  email = KNOWN,
): Promise<{ response: SiteResponse; cookies: Record<string, string> }> => {
  await requestLink(s, email);
  const link = s.store.sent.at(-1);
  if (link === undefined) {
    throw new Error('no link was sent');
  }
  const token = tokenOf(link.url);
  const page = await s.site.handle(onHost('/sign-in/confirm', { query: { token, lang: 'en' } }));
  const response = await s.site.handle(
    form(
      '/sign-in/confirm',
      { token, csrf: csrfOf(page), lang: 'en' },
      { cookies: cookiesOf(page) },
    ),
  );
  return { response, cookies: cookiesOf(response) };
};

describe('the brand gate', () => {
  it('answers the help center 404 on every portal address when the portal is off, and shows no header links', async () => {
    const { site } = setup({ portal: false });

    for (const path of ['/sign-in', '/sign-in/confirm', '/tickets', '/sign-in/challenge']) {
      const response = await site.handle(onHost(path, { query: { token: 'x' } }));
      expect(response.status, path).toBe(404);
    }
    for (const path of ['/sign-in', '/sign-in/confirm', '/sign-out', '/sign-out-everywhere']) {
      expect((await site.handle(form(path, {}))).status, path).toBe(404);
    }
    const home = await site.handle(onHost('/en'));
    expect(home.body).not.toContain('<a class="hd-portal-link');
  });

  it('shows My tickets and Sign in to everyone on a public page, which stays cacheable', async () => {
    const { site } = setup();
    const visitor = await site.handle(onHost('/en'));
    const withCookie = await site.handle(
      onHost('/en', { cookies: { '__Host-hd_cs': 'x'.repeat(43) } }),
    );

    expect(visitor.status).toBe(200);
    expect(visitor.headers['cache-control']).toBe(PUBLIC_CACHE_CONTROL);
    expect(visitor.body).toContain('href="/tickets"');
    expect(visitor.body).toContain('href="/sign-in?lang=en"');
    // The same bytes whoever asks: the page is never varied by a session.
    expect(sameShape(withCookie.body)).toBe(sameShape(visitor.body));
    expect(visitor.body).not.toContain('<details');
  });
});

describe('the sign-in form', () => {
  it('is private, not indexed, and sets a pre-session nonce cookie that is bound to nothing else', async () => {
    const { site } = setup();
    const response = await site.handle(onHost('/sign-in'));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(response.body).toContain('Sign in to see your tickets');
    expect(response.body).toContain('<h1 class="hd-display hd-portal-h1" id="hd-h1"');
    expect(response.cookies).toEqual([
      {
        name: '__Host-hd_cn',
        value: expect.stringMatching(/^[\w-]{43}$/),
        path: '/',
        maxAge: 3600,
        secure: true,
      },
    ]);
    expect(csrfOf(response)).not.toBe('');
  });

  it('draws the Arabic page for lang=ar', async () => {
    const { site } = setup();
    const response = await site.handle(onHost('/sign-in', { query: { lang: 'ar' } }));

    expect(response.body).toContain('<html lang="ar" dir="rtl">');
    expect(response.body).toContain('سجّل الدخول لترى تذاكرك');
    expect(response.body).toContain('تذاكري');
  });

  it('keeps only a same-site portal path as the next target', async () => {
    const { site } = setup();
    const good = await site.handle(onHost('/sign-in', { query: { next: '/tickets' } }));
    expect(good.body).toContain('name="next" value="/tickets"');

    for (const next of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/tickets/../x',
      '/admin',
      '/tickets?x=1',
      'tickets',
    ]) {
      const response = await site.handle(onHost('/sign-in', { query: { next } }));
      expect(response.body, next).not.toContain('name="next"');
    }
  });

  it('puts the built-in check above the button when the brand has it on, and refuses a bad solution', async () => {
    const s = setup();
    s.captcha.on = true;
    const opened = await s.site.handle(onHost('/sign-in'));
    expect(opened.body).toContain('id="wf-pow"');
    expect(opened.headers['content-security-policy']).toContain("connect-src 'self'");

    const refused = await requestLink(s, KNOWN, { pow: 'nope' });
    expect(refused.status).toBe(422);
    expect(refused.body).toContain('The check did not pass');
    expect(s.store.sent).toHaveLength(0);

    await requestLink(s, KNOWN, { pow: 'ok' });
    expect(s.store.sent).toHaveLength(1);
  });

  it('serves a fresh challenge only when the check is on', async () => {
    const s = setup();
    expect((await s.site.handle(onHost('/sign-in/challenge'))).status).toBe(404);
    s.captcha.on = true;
    const response = await s.site.handle(onHost('/sign-in/challenge'));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ algorithm: 'SHA-256' });
  });
});

describe('asking for a link', () => {
  it('says the same thing, with the same status, for a customer and for a stranger', async () => {
    const s = setup();
    const known = await requestLink(s, KNOWN);
    const stranger = await requestLink(s, 'nobody@elsewhere.example');

    expect(known.status).toBe(200);
    expect(stranger.status).toBe(known.status);
    expect(Object.keys(stranger.headers).sort()).toEqual(Object.keys(known.headers).sort());
    expect(sameShape(stranger.body).replace('nobody@elsewhere.example', KNOWN)).toBe(
      sameShape(known.body),
    );
    expect(known.body).toContain('Check your email');
    // Only the customer was sent anything.
    expect(s.store.sent.map((link) => link.to)).toEqual([KNOWN]);
  });

  it('leaves the lookup and the queueing until after the response', async () => {
    const s = setup();
    const opened = await s.site.handle(onHost('/sign-in'));
    const response = await s.site.handle(
      form('/sign-in', { email: KNOWN, csrf: csrfOf(opened) }, { cookies: cookiesOf(opened) }),
    );

    expect(response.status).toBe(200);
    expect(s.store.sent).toHaveLength(0);
    await response.after?.();
    expect(s.store.sent).toHaveLength(1);
  });

  it('sends the link to any address when new customers may sign in', async () => {
    const s = setup();
    s.store.newCustomers = true;
    await requestLink(s, 'new.person@elsewhere.example');

    expect(s.store.sent.map((link) => link.to)).toEqual(['new.person@elsewhere.example']);
  });

  it('puts the language of the page in the link, and not a ticket anywhere', async () => {
    const s = setup();
    await requestLink(s, KNOWN, { lang: 'ar' });
    const link = s.store.sent[0];

    expect(link?.locale).toBe('ar');
    expect(new URL(link?.url ?? '').searchParams.get('lang')).toBe('ar');
    expect(link?.url).toMatch(/^https:\/\/help\.example\.com\/sign-in\/confirm\?token=[\w-]{43}/);
  });

  it('gives a malformed address a field error and sends nothing', async () => {
    const s = setup();
    const response = await requestLink(s, 'not an address');

    expect(response.status).toBe(422);
    expect(response.body).toContain('Enter an email address, like name@example.com.');
    expect(response.body).toContain('aria-invalid="true" aria-describedby="hd-email-error"');
    expect(response.body).toContain('value="not an address"');
    expect(s.store.sent).toHaveLength(0);
  });

  it('refuses a post whose CSRF token is not the nonce cookie’s, and sends nothing', async () => {
    const s = setup();
    const opened = await s.site.handle(onHost('/sign-in'));
    const wrongToken = await s.site.handle(
      form('/sign-in', { email: KNOWN, csrf: 'forged' }, { cookies: cookiesOf(opened) }),
    );
    const noCookie = await s.site.handle(form('/sign-in', { email: KNOWN, csrf: csrfOf(opened) }));
    await wrongToken.after?.();
    await noCookie.after?.();

    expect(wrongToken.status).toBe(403);
    expect(noCookie.status).toBe(403);
    expect(s.store.sent).toHaveLength(0);
  });

  it('refuses a post from another origin', async () => {
    const s = setup();
    const response = await s.site.handle(
      form('/sign-in', { email: KNOWN }, { headers: { origin: 'https://evil.example' } }),
    );
    expect(response.status).toBe(403);
  });

  it('shows the warning on the sixth request for one address and sends nothing more', async () => {
    const s = setup();
    for (let n = 0; n < 5; n += 1) {
      expect((await requestLink(s, KNOWN, { ip: `198.51.100.${String(n)}` })).status).toBe(200);
    }
    const sixth = await requestLink(s, KNOWN, { ip: '198.51.100.99' });

    expect(sixth.status).toBe(429);
    expect(sixth.body).toContain('Too many requests for a sign-in link. Try again in an hour.');
    expect(sixth.body).toContain('disabled');
    expect(s.store.sent).toHaveLength(5);
  });

  it('shows the warning on the 21st request from one address of the network', async () => {
    const s = setup();
    s.store.newCustomers = true;
    for (let n = 0; n < 20; n += 1) {
      expect((await requestLink(s, `person${String(n)}@acme.example`)).status).toBe(200);
    }
    const next = await requestLink(s, 'person99@acme.example');

    expect(next.status).toBe(429);
    expect(s.store.sent).toHaveLength(20);
  });
});

describe('the Continue page and the link', () => {
  const emailed = async (s: Setup) => {
    await requestLink(s, KNOWN);
    return tokenOf(s.store.sent[0]?.url ?? '');
  };

  it('names the address and the brand, and spends nothing, however often it is opened', async () => {
    const s = setup();
    const token = await emailed(s);

    for (let n = 0; n < 3; n += 1) {
      const page = await s.site.handle(
        onHost('/sign-in/confirm', { query: { token, lang: 'en' } }),
      );
      expect(page.status).toBe(200);
      expect(page.body).toContain('Continue to your tickets');
      expect(page.body).toContain(KNOWN);
      expect(page.body).toContain('Helpdock Help');
      expect(page.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    }
    expect(s.store.sessions).toHaveLength(0);
    expect(s.store.links[0]?.spentAt).toBeNull();
  });

  it('spends the link by POST, sets the session cookie and lands on My tickets', async () => {
    const s = setup();
    const { response, cookies } = await signIn(s);

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/tickets');
    expect(response.cookies.find((cookie) => cookie.name === '__Host-hd_cs')).toEqual({
      name: '__Host-hd_cs',
      value: expect.stringMatching(/^[\w-]{43}$/),
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      secure: true,
    });
    expect(cookies['__Host-hd_cn']).toBe('');
    expect(s.store.sessions).toHaveLength(1);
    expect(s.log.events.map((event) => event.securityEvent)).toContain('portal.sign_in');
    expect(JSON.stringify(s.log.events)).not.toContain(KNOWN);
  });

  it('lands on the next target a link carried, and ignores one it should not', async () => {
    const s = setup();
    await requestLink(s, KNOWN, { next: '/tickets/abc-123' });
    const token = tokenOf(s.store.sent[0]?.url ?? '');
    expect(new URL(s.store.sent[0]?.url ?? '').searchParams.get('next')).toBe('/tickets/abc-123');
    const page = await s.site.handle(
      onHost('/sign-in/confirm', { query: { token, next: '/tickets/abc-123' } }),
    );
    const landed = await s.site.handle(
      form(
        '/sign-in/confirm',
        { token, csrf: csrfOf(page), next: '/tickets/abc-123' },
        { cookies: cookiesOf(page) },
      ),
    );
    expect(landed.headers.location).toBe('/tickets/abc-123');

    const other = setup();
    await requestLink(other, KNOWN);
    const t2 = tokenOf(other.store.sent[0]?.url ?? '');
    const p2 = await other.site.handle(onHost('/sign-in/confirm', { query: { token: t2 } }));
    const bad = await other.site.handle(
      form(
        '/sign-in/confirm',
        { token: t2, csrf: csrfOf(p2), next: '//evil.example' },
        { cookies: cookiesOf(p2) },
      ),
    );
    expect(bad.headers.location).toBe('/tickets');
  });

  it('says a second press is already used, and a link nobody sent is expired', async () => {
    const s = setup();
    await requestLink(s, KNOWN);
    const token = tokenOf(s.store.sent[0]?.url ?? '');
    const page = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));
    const press = () =>
      s.site.handle(
        form('/sign-in/confirm', { token, csrf: csrfOf(page) }, { cookies: cookiesOf(page) }),
      );
    expect((await press()).status).toBe(303);

    const again = await press();
    expect(again.status).toBe(410);
    expect(again.body).toContain('This link was already used');
    expect(again.body).toContain('Email me a new link');
    expect(again.cookies).toEqual([]);
    const reopened = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));
    expect(reopened.body).toContain('This link was already used');

    const unknown = await s.site.handle(
      onHost('/sign-in/confirm', { query: { token: 'a'.repeat(43) } }),
    );
    expect(unknown.body).toContain('This link has expired');
    expect(s.store.sessions).toHaveLength(1);
  });

  it('expires a link after fifteen minutes, on the page and on the press', async () => {
    const s = setup();
    await requestLink(s, KNOWN);
    const token = tokenOf(s.store.sent[0]?.url ?? '');
    const page = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));
    s.clock.now = new Date(s.clock.now.getTime() + SIGN_IN_TOKEN_TTL_MS + 1000);

    const opened = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));
    expect(opened.status).toBe(410);
    expect(opened.body).toContain('This link has expired');
    const pressed = await s.site.handle(
      form('/sign-in/confirm', { token, csrf: csrfOf(page) }, { cookies: cookiesOf(page) }),
    );
    expect(pressed.body).toContain('This link has expired');
    expect(s.store.sessions).toHaveLength(0);
  });

  it('does not spend a link for a press without a valid CSRF token', async () => {
    const s = setup();
    await requestLink(s, KNOWN);
    const token = tokenOf(s.store.sent[0]?.url ?? '');
    const page = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));

    const forged = await s.site.handle(
      form('/sign-in/confirm', { token, csrf: 'forged' }, { cookies: cookiesOf(page) }),
    );
    const bare = await s.site.handle(form('/sign-in/confirm', { token, csrf: csrfOf(page) }));

    expect(forged.status).toBe(403);
    expect(bare.status).toBe(403);
    expect(s.store.links[0]?.spentAt).toBeNull();
  });

  it('says a token of another brand is expired', async () => {
    const s = setup();
    await requestLink(s, KNOWN);
    const token = tokenOf(s.store.sent[0]?.url ?? '');
    // The memory store binds links to the brand that issued them, as the real one does.
    const link = s.store.links[0];
    if (link !== undefined) {
      Object.assign(link, { brandId: 'another-brand' });
    }
    const page = await s.site.handle(onHost('/sign-in/confirm', { query: { token } }));
    expect(page.body).toContain('This link has expired');
  });
});

describe('the signed-in pages', () => {
  it('sends a visitor with no session to the sign-in form, remembering where they were going', async () => {
    const { site } = setup();
    const response = await site.handle(onHost('/tickets'));

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/sign-in?lang=en&next=%2Ftickets');
  });

  it('shows the signed-in header with the address, the company and both sign-outs', async () => {
    const s = setup();
    const { cookies } = await signIn(s);
    const landing = await s.site.handle(onHost('/tickets', { cookies }));

    expect(landing.status).toBe(200);
    expect(landing.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
    expect(landing.headers['x-robots-tag']).toBe('noindex');
    expect(landing.body).toContain(
      '<h1 class="hd-display hd-portal-h1" id="hd-h1" tabindex="-1">My tickets</h1>',
    );
    expect(landing.body).toContain('Signed in as');
    expect(landing.body).toContain('Acme Trading');
    expect(landing.body).toContain('action="/sign-out"');
    expect(landing.body).toContain('action="/sign-out-everywhere"');
    expect(landing.body).not.toContain('class="hd-portal-link hd-portal-signin"');
  });

  it('refuses a session cookie from another host', async () => {
    const s = setup();
    const { cookies } = await signIn(s);
    const elsewhere = await s.site.handle(
      onHost('/tickets', { cookies, host: 'other.example.com' }),
    );
    // Not a help center host at all, so nothing answers.
    expect(elsewhere.status).toBe(404);
    const session = s.store.sessions[0];
    if (session !== undefined) {
      Object.assign(session, { host: 'other.example.com' });
    }
    const bound = await s.site.handle(onHost('/tickets', { cookies }));
    expect(bound.status).toBe(303);
  });

  it('ends one session on Sign out and clears the cookie, only with the session’s CSRF token', async () => {
    const s = setup();
    const { cookies } = await signIn(s);
    const landing = await s.site.handle(onHost('/tickets', { cookies }));

    const forged = await s.site.handle(form('/sign-out', { csrf: 'forged' }, { cookies }));
    expect(forged.status).toBe(403);
    expect(s.store.sessions).toHaveLength(1);

    const out = await s.site.handle(form('/sign-out', { csrf: csrfOf(landing) }, { cookies }));
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe('/en');
    expect(out.cookies).toEqual([
      { name: '__Host-hd_cs', value: '', path: '/', maxAge: 0, secure: true },
    ]);
    expect(s.store.sessions).toHaveLength(0);
    expect((await s.site.handle(onHost('/tickets', { cookies }))).status).toBe(303);
  });

  it('ends every session of the contact on Sign out everywhere, and no one else’s', async () => {
    const s = setup();
    const first = await signIn(s);
    await signIn(s);
    s.store.known.set('other@acme.example', { contactId: 'contact-other', companyName: null });
    await signIn(s, 'other@acme.example');
    expect(s.store.sessions).toHaveLength(3);

    const landing = await s.site.handle(onHost('/tickets', { cookies: first.cookies }));
    const out = await s.site.handle(
      form('/sign-out-everywhere', { csrf: csrfOf(landing) }, { cookies: first.cookies }),
    );

    expect(out.status).toBe(303);
    expect(s.store.sessions.map((session) => session.contactId)).toEqual(['contact-other']);
    expect(s.log.events.map((event) => event.securityEvent)).toContain(
      'portal.sign_out_everywhere',
    );
  });
});

describe('where it is served', () => {
  it('works under /hc/<brandId> with the brand in the cookie names and the base in every address', async () => {
    const s = setup();
    const base = (path: string) => `${BASE}${path}`;
    const fallback = (path: string, extra: Partial<SiteRequest> = {}): SiteRequest =>
      onHost(base(path), { host: 'desk.example.com', byHost: false, ...extra });
    const opened = await s.site.handle(fallback('/sign-in'));
    expect(opened.cookies[0]?.name).toBe(`__Host-hd_cn_${HC_BRAND}`);
    expect(opened.body).toContain(`action="${BASE}/sign-in"`);

    const posted = await s.site.handle(
      fallback('/sign-in', {
        method: 'POST',
        headers: { origin: 'https://desk.example.com' },
        body: { email: KNOWN, csrf: csrfOf(opened) },
        cookies: cookiesOf(opened),
      }),
    );
    await posted.after?.();
    const url = new URL(s.store.sent[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(`https://desk.example.com${BASE}/sign-in/confirm`);

    const token = url.searchParams.get('token') ?? '';
    const page = await s.site.handle(fallback('/sign-in/confirm', { query: { token } }));
    const done = await s.site.handle(
      fallback('/sign-in/confirm', {
        method: 'POST',
        headers: { origin: 'https://desk.example.com' },
        body: { token, csrf: csrfOf(page) },
        cookies: cookiesOf(page),
      }),
    );
    expect(done.headers.location).toBe(`${BASE}/tickets`);
    expect(done.cookies.find((cookie) => cookie.name === `__Host-hd_cs_${HC_BRAND}`)).toMatchObject(
      {
        path: '/',
        secure: true,
      },
    );
  });

  it('keeps bare, non-Secure names on a plain-http install', async () => {
    const s = setup({ appUrl: 'http://localhost:8080' });
    const response = await s.site.handle(onHost('/sign-in', { headers: {} }));
    expect(response.cookies[0]).toMatchObject({ name: 'hd_cn', secure: false, path: '/' });
  });
});

describe('userAgentFamily', () => {
  it('keeps a browser and a system, never the raw string', () => {
    expect(
      userAgentFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/130.0',
      ),
    ).toBe('Firefox on macOS');
    expect(userAgentFamily(undefined)).toBeNull();
    expect(userAgentFamily('curl/8')).toBeNull();
  });
});
