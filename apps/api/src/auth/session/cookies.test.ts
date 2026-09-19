import { uuidv7 } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  decodeRefreshCookie,
  encodeRefreshCookie,
  isSecureAppUrl,
  refreshCookieAttributes,
  trustedDeviceCookieAttributes,
} from './cookies.js';

const FAMILY_ID = uuidv7();

describe('isSecureAppUrl', () => {
  it.each([
    ['https://support.example.com', true],
    ['http://localhost:3000', false],
    ['not a url', false],
  ])('reads %o as %o', (appUrl, expected) => {
    expect(isSecureAppUrl(appUrl)).toBe(expected);
  });
});

describe('refreshCookieAttributes', () => {
  it('is httpOnly, Lax and scoped to the auth routes, whatever the URL', () => {
    expect(refreshCookieAttributes('http://localhost:3000')).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it('is Secure over https and not over http, where it would be dropped silently', () => {
    expect(refreshCookieAttributes('https://support.example.com').secure).toBe(true);
    expect(refreshCookieAttributes('http://localhost:3000').secure).toBe(false);
  });

  it('never carries a Domain, which would let a sibling subdomain read it', () => {
    expect(refreshCookieAttributes('https://support.example.com')).not.toHaveProperty('domain');
  });
});

describe('trustedDeviceCookieAttributes', () => {
  it('lasts the thirty days the checkbox promises', () => {
    expect(trustedDeviceCookieAttributes('https://support.example.com').maxAge).toBe(
      30 * 24 * 60 * 60,
    );
  });
});

describe('the refresh cookie value', () => {
  it('round-trips the family and the token', () => {
    const payload = { fam: FAMILY_ID, token: 'abc-123' };

    expect(decodeRefreshCookie(encodeRefreshCookie(payload))).toEqual(payload);
  });

  it.each([
    ['nothing', undefined],
    ['an empty value', ''],
    ['no token', FAMILY_ID],
    ['a family that is not a uuid', 'nope.abc'],
    ['an extra segment', `${FAMILY_ID}.abc.extra`],
  ])('refuses %s', (_case, value) => {
    expect(decodeRefreshCookie(value)).toBeNull();
  });
});
