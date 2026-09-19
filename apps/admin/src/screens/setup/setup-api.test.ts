import { SETUP_TOKEN_HEADER } from '@helpdock/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpSetupApi,
  SetupApiError,
  SetupClosedError,
  SetupThrottledError,
  SetupValidationError,
} from './setup-api.js';

const admin = {
  setupToken: 'the-token',
  expiresInSeconds: 1800,
  admin: {
    id: '0199f4b2-6a91-7c27-9a1f-000000000001',
    name: 'Lina',
    email: 'lina@example.com',
  },
};

const brand = {
  brand: {
    id: '0199f4b2-6a91-7c27-9a1f-00000000000a',
    name: 'Acme',
    prefix: 'ACME',
    defaultLocale: 'en',
    timezone: 'UTC',
  },
  helpcenterDomain: null,
  departmentCreated: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stubFetch = (...responses: Response[]): ReturnType<typeof vi.fn> => {
  const queue = [...responses];
  const fetchStub = vi.fn(() => Promise.resolve(queue.shift() ?? json({}, 500)));
  vi.stubGlobal('fetch', fetchStub);

  return fetchStub;
};

const request = (fetchStub: ReturnType<typeof vi.fn>, index = 0) =>
  fetchStub.mock.calls[index] as [string, RequestInit];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSetupApi', () => {
  it('parses what the api answered rather than trusting it', async () => {
    stubFetch(json(admin));

    await expect(
      new HttpSetupApi().createAdmin({
        name: 'Lina',
        email: 'lina@example.com',
        password: 'a very long passphrase',
        locale: 'en',
      }),
    ).resolves.toEqual(admin);
  });

  it('refuses a response of a shape this build does not understand', async () => {
    stubFetch(json({ setupToken: 42 }));

    await expect(
      new HttpSetupApi().createAdmin({
        name: 'Lina',
        email: 'lina@example.com',
        password: 'a very long passphrase',
        locale: 'en',
      }),
    ).rejects.toBeInstanceOf(SetupApiError);
  });

  it('sends no wizard token on step 1 and the one it was given on every step after', async () => {
    const fetchStub = stubFetch(json(admin), json(brand));
    const api = new HttpSetupApi();

    await api.createAdmin({
      name: 'Lina',
      email: 'lina@example.com',
      password: 'a very long passphrase',
      locale: 'en',
    });
    await api.createBrand({ name: 'Acme', prefix: 'ACME', defaultLocale: 'en', timezone: 'UTC' });

    const first = new Headers(request(fetchStub, 0)[1].headers);
    const second = new Headers(request(fetchStub, 1)[1].headers);

    expect(first.get(SETUP_TOKEN_HEADER)).toBeNull();
    expect(second.get(SETUP_TOKEN_HEADER)).toBe('the-token');
  });

  it('sends the cookie the api sets on step 2, which is what signs the admin in', async () => {
    const fetchStub = stubFetch(json(admin));

    await new HttpSetupApi().createAdmin({
      name: 'Lina',
      email: 'lina@example.com',
      password: 'a very long passphrase',
      locale: 'en',
    });

    expect(request(fetchStub)[1].credentials).toBe('same-origin');
  });

  it('posts the finish with no body at all', async () => {
    const fetchStub = stubFetch(json({ require2fa: true }));

    await expect(new HttpSetupApi().complete()).resolves.toEqual({ require2fa: true });
    expect(request(fetchStub)[1].body).toBeUndefined();
    expect(new Headers(request(fetchStub)[1].headers).get('content-type')).toBeNull();
  });

  it('reads a 409 as the wizard being closed', async () => {
    stubFetch(json({}, 409));

    await expect(new HttpSetupApi().complete()).rejects.toBeInstanceOf(SetupClosedError);
  });

  it('reads a 429 as the limit, not as a failure the screen should retry', async () => {
    stubFetch(json({}, 429));

    await expect(new HttpSetupApi().complete()).rejects.toBeInstanceOf(SetupThrottledError);
  });

  it('reads a 400 as the fields the api would not take', async () => {
    stubFetch(
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'The request did not match the expected shape',
            requestId: 'r1',
            fields: [{ path: 'prefix', message: 'is already in use on this install' }],
          },
        },
        400,
      ),
    );

    const error = await new HttpSetupApi()
      .createBrand({ name: 'Acme', prefix: 'ACME', defaultLocale: 'en', timezone: 'UTC' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SetupValidationError);
    expect((error as SetupValidationError).paths).toEqual(['prefix']);
  });

  it('survives a 400 with no body to read, which a proxy can produce', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html/>', { status: 400 }))),
    );

    const error = await new HttpSetupApi()
      .createBrand({ name: 'Acme', prefix: 'ACME', defaultLocale: 'en', timezone: 'UTC' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SetupValidationError);
    expect((error as SetupValidationError).paths).toEqual([]);
  });

  it('has one sentence for everything else', async () => {
    stubFetch(json({}, 503));

    await expect(new HttpSetupApi().complete()).rejects.toBeInstanceOf(SetupApiError);
  });

  it('reaches each of the endpoints the api declares, in order', async () => {
    const fetchStub = stubFetch(
      json(admin),
      json(brand),
      json({ delivered: true }),
      json({ configured: true }),
      json({ require2fa: false }),
    );
    const api = new HttpSetupApi();
    const credentials = {
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls' as const,
      user: '',
      password: '',
      fromAddress: 'support@example.com',
      fromName: 'Acme',
    };

    await api.createAdmin({
      name: 'Lina',
      email: 'lina@example.com',
      password: 'a very long passphrase',
      locale: 'en',
    });
    await api.createBrand({ name: 'Acme', prefix: 'ACME', defaultLocale: 'en', timezone: 'UTC' });
    await api.testSmtp(credentials);
    await api.saveSmtp({ ...credentials, skip: false });
    await api.complete();

    expect(fetchStub.mock.calls.map((call) => (call as [string])[0])).toEqual([
      '/api/install/setup/admin',
      '/api/install/setup/brand',
      '/api/install/setup/smtp/test',
      '/api/install/setup/smtp',
      '/api/install/setup/complete',
    ]);
  });
});
