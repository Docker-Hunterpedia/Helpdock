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

const HOSTS = ['shop.example.com', 'help.example.com'];
const ASK = { hostnames: HOSTS, action: 'web-form' } as const;

describe('the CAPTCHA providers (ADR 0003)', () => {
  it('verifies a Turnstile token with the secret, the address and the idempotency key', async () => {
    const { calls, transport } = recorder(200, {
      success: true,
      hostname: 'shop.example.com',
      action: 'widget-first-message',
    });
    const turnstile = createCaptchaProvider('turnstile', transport);

    const verdict = await turnstile.verify({
      secret: 's3cret',
      token: 'tok',
      remoteIp: '203.0.113.9',
      idempotencyKey: 'client-1',
      hostnames: ['shop.example.com'],
      action: 'widget-first-message',
    });

    expect(verdict).toEqual({ success: true, hostname: 'shop.example.com' });
    expect(calls[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      secret: 's3cret',
      response: 'tok',
      remoteip: '203.0.113.9',
      idempotency_key: 'client-1',
    });
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
      hostnames: ['shop.example.com'],
      action: 'web-form',
    });

    expect(verdict).toEqual({ success: false, errorCodes: ['invalid-input-response'] });
    expect(calls[0]?.url).toBe(HCAPTCHA_VERIFY_URL);
    expect(calls[0]?.form.has('idempotency_key')).toBe(false);
  });

  it('fails closed on an error status, an answer it cannot read and a network failure', async () => {
    const provider = (status: number, body: unknown) =>
      createCaptchaProvider('turnstile', recorder(status, body).transport);
    const unreachable = createCaptchaProvider('turnstile', {
      postForm: () => Promise.reject(new Error('reset')),
    });

    expect(
      await provider(500, { success: true }).verify({ secret: 's', token: 't', ...ASK }),
    ).toEqual({
      success: false,
      errorCodes: ['http-500'],
    });
    expect(await provider(200, 'nope').verify({ secret: 's', token: 't', ...ASK })).toEqual({
      success: false,
      errorCodes: ['invalid-response'],
    });
    expect(
      await provider(200, { success: 'yes' }).verify({ secret: 's', token: 't', ...ASK }),
    ).toEqual({
      success: false,
      errorCodes: ['invalid-response'],
    });
    expect(await unreachable.verify({ secret: 's', token: 't', ...ASK })).toEqual({
      success: false,
      errorCodes: ['network-error'],
    });
  });

  it.each([
    [
      'solved on another site',
      { success: true, hostname: 'elsewhere.example.net', action: 'web-form' },
    ],
    ['that names no site', { success: true, action: 'web-form' }],
  ])('refuses a pass %s, since a site key works on any site', async (_label, body) => {
    const { transport } = recorder(200, body);

    expect(
      await createCaptchaProvider('turnstile', transport).verify({
        secret: 's',
        token: 't',
        ...ASK,
      }),
    ).toEqual({ success: false, errorCodes: ['hostname-mismatch'] });
  });

  it.each([
    ['for the other surface', { action: 'widget-first-message' }],
    ['that names no surface', {}],
  ])('refuses a Turnstile pass %s (M18-11)', async (_label, action) => {
    const { transport } = recorder(200, { success: true, hostname: 'shop.example.com', ...action });

    expect(
      await createCaptchaProvider('turnstile', transport).verify({
        secret: 's',
        token: 't',
        ...ASK,
      }),
    ).toEqual({ success: false, errorCodes: ['action-mismatch'] });
  });

  it('accepts a pass solved on any of the allowed hosts, whatever its case', async () => {
    const { transport } = recorder(200, { success: true, hostname: 'Help.Example.com' });

    expect(
      await createCaptchaProvider('hcaptcha', transport).verify({
        secret: 's',
        token: 't',
        ...ASK,
      }),
    ).toEqual({ success: true, hostname: 'Help.Example.com' });
  });

  it.each([
    ['no secret', { secret: '', token: 't', ...ASK }, 'missing-input-secret'],
    ['a blank token', { secret: 's', token: ' ', ...ASK }, 'missing-input-response'],
    [
      'an oversized token',
      { secret: 's', token: 'x'.repeat(5000), ...ASK },
      'invalid-input-response',
    ],
  ] as const)('refuses %s without calling out', async (_label, input, code) => {
    const { calls, transport } = recorder(200, { success: true });

    expect(await createCaptchaProvider('hcaptcha', transport).verify(input)).toEqual({
      success: false,
      errorCodes: [code],
    });
    expect(calls).toHaveLength(0);
  });
});

describe('the challenge a page draws', () => {
  it('draws Turnstile from Cloudflare and allows only that origin', () => {
    const config = createCaptchaProvider('turnstile', recorder(200, {}).transport).renderConfig(
      'site',
      'ar',
      'web-form',
    );

    expect(config).toMatchObject({
      provider: 'turnstile',
      siteKey: 'site',
      action: 'web-form',
      widgetClass: 'cf-turnstile',
      responseField: 'cf-turnstile-response',
      csp: { scriptSrc: ['https://challenges.cloudflare.com'] },
    });
  });

  it('asks hCaptcha for the challenge in the page language', () => {
    const config = createCaptchaProvider('hcaptcha', recorder(200, {}).transport).renderConfig(
      'site',
      'ar',
      'web-form',
    );

    expect(config.scriptUrl).toContain('hl=ar');
    expect(config.action).toBeNull();
    expect(config.responseField).toBe('h-captcha-response');
  });
});
