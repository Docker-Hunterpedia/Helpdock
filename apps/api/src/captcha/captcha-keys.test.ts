import type { CaptchaTransport } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { type BrandCaptchaKeys, CaptchaVerifier, safeCaptchaTransport } from './captcha-keys.js';
import type { PowCaptcha } from './pow-captcha.js';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@helpdock/net', async (original) => ({
  ...(await original<typeof import('@helpdock/net')>()),
  safeFetch,
}));

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const KEYS: BrandCaptchaKeys = { provider: 'turnstile', siteKey: 'site', secret: 's3cret' };

/** The built-in check's spend, answering what a test tells it to. */
const powSpending = (success: boolean) => ({
  spend: vi.fn(async () =>
    success ? { success: true as const } : { success: false as const, errorCodes: ['x'] },
  ),
});

const verifierWith = (
  keys: BrandCaptchaKeys | null,
  transport: CaptchaTransport,
  { pow = powSpending(true), log = { warn: vi.fn() } } = {},
) =>
  new CaptchaVerifier({ forBrand: async () => keys }, transport, pow as unknown as PowCaptcha, log);

const HOSTS = ['support.example.com'];
const SURFACE = 'widget-first-message';

const answering = (success: boolean): CaptchaTransport => ({
  postForm: vi.fn(async () => ({
    status: 200,
    body: JSON.stringify({ success, hostname: HOSTS[0], action: SURFACE, cdata: BRAND }),
  })),
});

describe('CaptchaVerifier', () => {
  it('passes a token the provider accepts, with the brand’s secret', async () => {
    const transport = answering(true);

    expect(
      await verifierWith(KEYS, transport).verify({
        brandId: BRAND,
        token: 'tok',
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('passed');
    expect(vi.mocked(transport.postForm).mock.calls[0]?.[1].get('secret')).toBe('s3cret');
  });

  it('fails a missing token without calling out, and a refused one after', async () => {
    const transport = answering(false);
    const verifier = verifierWith(KEYS, transport);

    expect(
      await verifier.verify({
        brandId: BRAND,
        token: undefined,
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('failed');
    expect(transport.postForm).not.toHaveBeenCalled();
    expect(
      await verifier.verify({
        brandId: BRAND,
        token: 'tok',
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('failed');
  });

  it('logs why a pass was refused, without the token or the secret (M18-11)', async () => {
    const log = { warn: vi.fn() };
    const transport: CaptchaTransport = {
      postForm: vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({
          success: true,
          hostname: HOSTS[0],
          action: 'web-form',
          cdata: BRAND,
        }),
      })),
    };

    expect(
      await verifierWith(KEYS, transport, { log }).verify({
        brandId: BRAND,
        token: 'the-token',
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith(
      { brandId: BRAND, surface: SURFACE, errorCodes: ['action-mismatch'] },
      'CAPTCHA refused',
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/the-token|s3cret/);
  });

  it('fails closed when the provider cannot be reached', async () => {
    const transport: CaptchaTransport = {
      postForm: () => Promise.reject(new Error('blocked')),
    };

    expect(
      await verifierWith(KEYS, transport).verify({
        brandId: BRAND,
        token: 'tok',
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('failed');
  });

  it('spends a built-in solution for the surface asking, and never calls out (ADR 0052)', async () => {
    const transport = answering(true);
    const pow = powSpending(false);
    const verifier = verifierWith({ provider: 'pow', difficulty: 'low' }, transport, { pow });

    expect(
      await verifier.verify({
        brandId: BRAND,
        token: 'solution',
        remoteIp: null,
        hostnames: HOSTS,
        surface: 'widget-first-message',
      }),
    ).toBe('failed');
    expect(pow.spend).toHaveBeenCalledWith(BRAND, 'solution', 'widget-first-message');
    expect(transport.postForm).not.toHaveBeenCalled();
  });

  it('says so when the brand has no keys', async () => {
    expect(
      await verifierWith(null, answering(true)).verify({
        brandId: BRAND,
        token: 'tok',
        remoteIp: null,
        hostnames: HOSTS,
        surface: SURFACE,
      }),
    ).toBe('not_configured');
  });
});

describe('safeCaptchaTransport', () => {
  it('posts the form through the SSRF-safe client, small and without redirects', async () => {
    safeFetch.mockResolvedValue({ status: 200, body: Buffer.from('{"success":true}') });
    const transport = safeCaptchaTransport(['10.0.0.0/8']);

    const answer = await transport.postForm(
      'https://verify.test/siteverify',
      new URLSearchParams({ a: 'b c' }),
    );

    expect(answer).toEqual({ status: 200, body: '{"success":true}' });
    const [url, init, policy] = safeFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://verify.test/siteverify');
    expect(init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b+c',
    });
    expect(policy).toMatchObject({ maxRedirects: 0, allowCidrs: ['10.0.0.0/8'] });
  });
});
