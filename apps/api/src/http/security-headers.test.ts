import { describe, expect, it } from 'vitest';
import { isHttps, securityHeaderOptions } from './security-headers.js';

describe('isHttps', () => {
  it.each([
    ['https://support.example.com', true],
    ['http://localhost:3000', false],
    ['not a url', false],
  ])('reads %s as %s', (appUrl, expected) => {
    expect(isHttps(appUrl)).toBe(expected);
  });
});

describe('securityHeaderOptions', () => {
  it('sends HSTS only on an https origin', () => {
    expect(securityHeaderOptions({ appUrl: 'https://support.example.com' })).toMatchObject({
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    });
    expect(securityHeaderOptions({ appUrl: 'http://localhost:3000' }).strictTransportSecurity).toBe(
      false,
    );
  });

  it('denies everything in the policy, because a JSON response loads nothing', () => {
    const csp = securityHeaderOptions({
      appUrl: 'https://support.example.com',
    }).contentSecurityPolicy;

    expect(csp).toMatchObject({
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    });
  });

  it('keeps the two headers REQUIREMENTS §5.1 names alongside CSP and HSTS', () => {
    const options = securityHeaderOptions({ appUrl: 'https://support.example.com' });

    expect(options.xContentTypeOptions).toBe(true);
    expect(options.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });
});
