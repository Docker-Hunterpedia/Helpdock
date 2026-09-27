import type { CaptchaTransport } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { type BrandCaptchaKeys, CaptchaVerifier } from './captcha-keys.js';

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
