import type { CaptchaTransport } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { type BrandCaptchaKeys, CaptchaVerifier, safeCaptchaTransport } from './captcha-keys.js';

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('@helpdock/net', async (original) => ({
  ...(await original<typeof import('@helpdock/net')>()),
  safeFetch,
}));

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const KEYS: BrandCaptchaKeys = { provider: 'turnstile', siteKey: 'site', secret: 's3cret' };

const verifierWith = (keys: BrandCaptchaKeys | null, transport: CaptchaTransport) =>
  new CaptchaVerifier({ forBrand: async () => keys }, transport);

const answering = (success: boolean): CaptchaTransport => ({
  postForm: vi.fn(async () => ({ status: 200, body: JSON.stringify({ success }) })),
});

describe('CaptchaVerifier', () => {
  it('passes a token the provider accepts, with the brand’s secret', async () => {
    const transport = answering(true);

    expect(
      await verifierWith(KEYS, transport).verify({ brandId: BRAND, token: 'tok', remoteIp: null }),
    ).toBe('passed');
    expect(vi.mocked(transport.postForm).mock.calls[0]?.[1].get('secret')).toBe('s3cret');
  });

  it('fails a missing token without calling out, and a refused one after', async () => {
    const transport = answering(false);
    const verifier = verifierWith(KEYS, transport);

    expect(await verifier.verify({ brandId: BRAND, token: undefined, remoteIp: null })).toBe(
      'failed',
    );
    expect(transport.postForm).not.toHaveBeenCalled();
    expect(await verifier.verify({ brandId: BRAND, token: 'tok', remoteIp: null })).toBe('failed');
  });

  it('fails closed when the provider cannot be reached', async () => {
    const transport: CaptchaTransport = {
      postForm: () => Promise.reject(new Error('blocked')),
    };

    expect(
      await verifierWith(KEYS, transport).verify({ brandId: BRAND, token: 'tok', remoteIp: null }),
    ).toBe('failed');
  });

  it('says so when the brand has no keys', async () => {
    expect(
      await verifierWith(null, answering(true)).verify({
        brandId: BRAND,
        token: 'tok',
        remoteIp: null,
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
