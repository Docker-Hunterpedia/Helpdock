import { contentPolicySchema } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { WEB_FORM_ROUTE } from './web-form-page.controller.js';
import {
  pageContentSecurityPolicy,
  readFormBody,
  WebFormPage,
  type WebFormPageRequest,
} from './web-form-page.js';
import type { LoadedForm, SubmitResult } from './web-form-public.service.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const OTHER = '0192c3f0-1a2b-7c3d-8e4f-0000000000a2';

const form = (overrides: Partial<LoadedForm> = {}): LoadedForm => ({
  brand: {
    id: BRAND,
    name: 'Helpdock',
    defaultLocale: 'en',
    prefix: 'HD',
    active: true,
    contentPolicy: {},
  },
  locale: 'en',
  state: 'open',
  fields: [
    { field: 'email', label: 'Email', type: 'email', required: true, options: [] },
    { field: 'message', label: 'Message', type: 'long_text', required: true, options: [] },
  ],
  attachments: null,
  captcha: null,
  thankYou: 'Thanks. {{ticket.number}}',
  departmentId: null,
  policy: contentPolicySchema.parse({}),
  keys: null,
  ...overrides,
});

const pageWith = ({
  loaded = form(),
  result = { kind: 'created', reference: 'HD-7' } as SubmitResult,
  hostBrand = null as string | null,
} = {}) => {
  const load = vi.fn(async () => loaded);
  const submit = vi.fn(async () => result);
  const log = { error: vi.fn() };
  const page = new WebFormPage({
    forms: { load, submit },
    resolveHost: async () => hostBrand,
    log,
  });
  return { page, load, submit, log };
};

const request = (overrides: Partial<WebFormPageRequest> = {}): WebFormPageRequest => ({
  host: 'desk.example.com',
  brandId: BRAND,
  lang: undefined,
  ip: '203.0.113.1',
  ...overrides,
});

const body = (fields: Record<string, string>) => ({
  fields: new Map(Object.entries(fields).map(([key, value]) => [key, [value]])),
  files: [],
});

describe('WebFormPage', () => {
  it('shows the form with a fresh submission id and a CSP that allows no script', async () => {
    const { page } = pageWith();
    const response = await page.handle(request());

    expect(response.status).toBe(200);
    expect(response.html).toMatch(/name="hd_submission" value="[0-9a-f-]{36}"/);
    expect(response.contentSecurityPolicy).toContain("script-src 'none'");
    expect(response.contentSecurityPolicy).toContain("form-action 'self'");
  });

  it('serves `/contact` on a help center host as that host’s brand', async () => {
    const { page, load } = pageWith({ hostBrand: BRAND });
    const response = await page.handle(request({ brandId: undefined }));

    expect(load).toHaveBeenCalledWith(BRAND, undefined);
    expect(response.html).toContain('action="/contact"');
    expect(response.html).toContain('href="/"');
  });

  it.each([
    ['`/contact` on a host that is no help center', { brandId: undefined }, null],
    ['another brand’s form on this brand’s host', { brandId: OTHER }, BRAND],
    ['a path that is not a brand id', { brandId: 'not-a-uuid' }, null],
  ] as const)('answers 404 for %s', async (_label, overrides, hostBrand) => {
    const { page, load } = pageWith({ hostBrand });
    const response = await page.handle(request(overrides));

    expect(response.status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it('answers 404 with the page language when no brand has the id', async () => {
    const { page } = pageWith({ loaded: null as unknown as LoadedForm });
    const response = await page.handle(request({ lang: 'ar' }));

    expect(response.status).toBe(404);
    expect(response.html).toContain('dir="rtl"');
  });

  it.each([
    ['closed', 404],
    ['unavailable', 503],
  ] as const)('answers a %s form with %i and no form', async (state, status) => {
    const { page, submit } = pageWith({ loaded: form({ state }) });
    const response = await page.handle(request({ body: body({ email: 'a@example.com' }) }));

    expect(response.status).toBe(status);
    expect(response.html).not.toContain('<form');
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows the reference once a submission is filed', async () => {
    const { page, submit } = pageWith();
    const response = await page.handle(
      request({ body: body({ email: 'a@example.com', message: 'Hi', lang: 'en' }) }),
    );

    expect(submit).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.html).toContain('<p class="hd-secondary">Thanks. HD-7</p>');
  });

  it('keeps what was typed, and the same submission id, when fields need attention', async () => {
    const { page } = pageWith({
      result: { kind: 'invalid', errors: new Map([['email', 'email']]) },
    });
    const response = await page.handle(
      request({ body: body({ email: 'a@b', message: 'Hi', hd_submission: 'the-same-id' }) }),
    );

    expect(response.status).toBe(422);
    expect(response.html).toContain('value="a@b"');
    expect(response.html).toContain('value="the-same-id"');
  });

  it.each([
    ['captcha', 422],
    ['rate_limited', 429],
    ['rejected', 400],
    ['failed', 500],
  ] as const)('answers a %s refusal with %i', async (error, status) => {
    const { page } = pageWith({ result: { kind: 'refused', error } });
    const response = await page.handle(request({ body: body({ email: 'a@example.com' }) }));

    expect(response.status).toBe(status);
  });

  it('tells the customer to try again, and logs why, when filing throws', async () => {
    const { page, submit, log } = pageWith();
    submit.mockRejectedValueOnce(new Error('database gone'));
    const response = await page.handle(request({ body: body({ email: 'a@example.com' }) }));

    expect(response.status).toBe(500);
    expect(response.html).toContain('Something went wrong and your message was not sent.');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('takes the language the form posted over the query', async () => {
    const { page, load } = pageWith();
    await page.handle(request({ lang: 'en', body: body({ lang: 'ar' }) }));

    expect(load).toHaveBeenCalledWith(BRAND, 'ar');
  });
});

describe('pageContentSecurityPolicy', () => {
  it('adds the provider’s sources only while a challenge is drawn', () => {
    const policy = pageContentSecurityPolicy('abc', {
      provider: 'hcaptcha',
      siteKey: 's',
      scriptUrl: 'https://js.hcaptcha.com/1/api.js',
      widgetClass: 'h-captcha',
      responseField: 'h-captcha-response',
      csp: {
        scriptSrc: ['https://hcaptcha.com'],
        frameSrc: ['https://hcaptcha.com'],
        styleSrc: ['https://hcaptcha.com'],
        connectSrc: ['https://hcaptcha.com'],
      },
    });

    expect(policy).toContain("script-src 'nonce-abc' https://hcaptcha.com");
    expect(policy).toContain('frame-src https://hcaptcha.com');
    expect(policy).toContain('connect-src https://hcaptcha.com');
    expect(policy).toContain("style-src 'self' 'nonce-abc' https://hcaptcha.com");
  });
});

describe('readFormBody', () => {
  it('decodes a multipart body into repeated fields and the attachments', async () => {
    const data = new FormData();
    data.append('email', 'a@example.com');
    data.append('custom:areas', 'One');
    data.append('custom:areas', 'Two');
    data.append(
      'attachments',
      new File([Buffer.from('%PDF')], 'a.pdf', { type: 'application/pdf' }),
    );
    data.append('stray', new File([Buffer.from('x')], 'x.bin'));
    const encoded = new Request('http://form.test', { method: 'POST', body: data });

    const read = await readFormBody(
      encoded.headers.get('content-type') ?? '',
      Buffer.from(await encoded.arrayBuffer()),
    );

    expect(read?.fields.get('custom:areas')).toEqual(['One', 'Two']);
    expect(read?.files).toMatchObject([{ filename: 'a.pdf', contentType: 'application/pdf' }]);
  });

  it('reads a url-encoded body the framework already parsed', async () => {
    const read = await readFormBody('application/x-www-form-urlencoded', {
      email: 'a@example.com',
      'custom:areas': ['One', 'Two'],
    });

    expect(read?.fields.get('custom:areas')).toEqual(['One', 'Two']);
    expect(read?.files).toEqual([]);
  });

  it('answers null for a body it cannot read', async () => {
    expect(
      await readFormBody('multipart/form-data; boundary=x', Buffer.from('nonsense')),
    ).toBeNull();
    expect(await readFormBody(undefined, undefined)).toBeNull();
  });
});

describe('WEB_FORM_ROUTE', () => {
  it.each([
    ['/contact', true],
    ['/contact?lang=ar', true],
    ['/contact/:brandId', true],
    ['/contacts', false],
    ['/api/contact', false],
  ])('%s takes a form body: %s', (url, expected) => {
    expect(WEB_FORM_ROUTE.matches(url)).toBe(expected);
  });
});
