import { uuidv7 } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  decodeRefreshCookie,
  encodeRefreshCookie,
  isSecureAppUrl,
  refreshCookie,
  refreshCookieOf,
  trustedDeviceCookie,
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

const LIFETIME = { maxSeconds: 12 * 60 * 60 };

describe('refreshCookie', () => {
  it('is httpOnly, Lax, scoped to the auth routes and as long-lived as its family', () => {
    expect(refreshCookie('http://localhost:3000', LIFETIME).attributes).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 12 * 60 * 60,
    });
  });

  it('is Secure over https and not over http, where it would be dropped silently', () => {
    expect(refreshCookie('https://support.example.com', LIFETIME).attributes.secure).toBe(true);
    expect(refreshCookie('http://localhost:3000', LIFETIME).attributes.secure).toBe(false);
  });

  it('carries the __Secure- prefix over https, so only a secure origin can set it (ASVS 3.4.4)', () => {
    expect(refreshCookie('https://support.example.com', LIFETIME).name).toBe('__Secure-hd_refresh');
    expect(refreshCookie('http://localhost:3000', LIFETIME).name).toBe('hd_refresh');
  });

  it('never carries a Domain, which would let a sibling subdomain read it', () => {
    expect(refreshCookie('https://support.example.com', LIFETIME).attributes).not.toHaveProperty(
      'domain',
    );
  });

  it('takes its lifetime from the install, twelve hours unless it says otherwise', () => {
    expect(refreshCookieOf({ APP_URL: 'https://support.example.com' }).attributes.maxAge).toBe(
      12 * 60 * 60,
    );
    expect(
      refreshCookieOf({ APP_URL: 'https://support.example.com', AUTH_SESSION_MAX_HOURS: 48 })
        .attributes.maxAge,
    ).toBe(48 * 60 * 60);
  });
});

describe('trustedDeviceCookie', () => {
  it('lasts the thirty days the checkbox promises, under the same prefix', () => {
    const cookie = trustedDeviceCookie('https://support.example.com');

    expect(cookie.attributes.maxAge).toBe(30 * 24 * 60 * 60);
    expect(cookie.name).toBe('__Secure-hd_trust');
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
