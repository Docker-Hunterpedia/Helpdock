import { describe, expect, it } from 'vitest';
import {
  type CaptchaTransport,
  createCaptchaProvider,
  HCAPTCHA_VERIFY_URL,
  TURNSTILE_VERIFY_URL,
} from './captcha.js';

const recorder = (status: number, body: unknown) => {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const transport: CaptchaTransport = {
    postForm: async (url, form) => {
      calls.push({ url, form });
      return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
  return { calls, transport };
};

describe('the CAPTCHA providers (ADR 0003)', () => {
  it('verifies a Turnstile token with the secret, the address and the idempotency key', async () => {
    const { calls, transport } = recorder(200, { success: true, hostname: 'shop.example.com' });
    const turnstile = createCaptchaProvider('turnstile', transport);

    const verdict = await turnstile.verify({
      secret: 's3cret',
      token: 'tok',
      remoteIp: '203.0.113.9',
      idempotencyKey: 'client-1',
    });

    expect(verdict).toEqual({ success: true, hostname: 'shop.example.com' });
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      secret: 's3cret',
      response: 'tok',
      remoteip: '203.0.113.9',
      idempotency_key: 'client-1',
    });
    expect(turnstile.renderConfig('site')).toEqual({ provider: 'turnstile', siteKey: 'site' });
  });

  it('verifies an hCaptcha token without Turnstile’s idempotency key', async () => {
    const { calls, transport } = recorder(200, {
      success: false,
      'error-codes': ['invalid-input-response'],
    });

    const verdict = await createCaptchaProvider('hcaptcha', transport).verify({
      secret: 's',
      token: 'tok',
      idempotencyKey: 'ignored',
    });

    expect(verdict).toEqual({ success: false, errorCodes: ['invalid-input-response'] });
    expect(calls[0]?.url).toBe(HCAPTCHA_VERIFY_URL);
    expect(calls[0]?.form.has('idempotency_key')).toBe(false);
  });

  it('fails closed on an empty token, an error status and an answer it cannot read', async () => {
    const provider = (status: number, body: unknown) =>
      createCaptchaProvider('turnstile', recorder(status, body).transport);

    expect(await provider(200, {}).verify({ secret: 's', token: ' ' })).toEqual({
      success: false,
      errorCodes: ['missing-input-response'],
    });
    expect(await provider(500, {}).verify({ secret: 's', token: 't' })).toEqual({
      success: false,
      errorCodes: ['http-500'],
    });
    expect(await provider(200, 'nope').verify({ secret: 's', token: 't' })).toEqual({
      success: false,
      errorCodes: ['invalid-response'],
    });
    expect(await provider(200, { success: 'yes' }).verify({ secret: 's', token: 't' })).toEqual({
      success: false,
      errorCodes: ['invalid-response'],
    });
  });
});
