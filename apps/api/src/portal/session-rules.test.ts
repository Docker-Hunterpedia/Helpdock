import { describe, expect, it } from 'vitest';
import {
  csrfKeyFrom,
  csrfToken,
  csrfValid,
  hashToken,
  isExpired,
  isTokenShaped,
  maskCsrf,
  newToken,
  nonceCookieName,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  SIGN_IN_TOKEN_TTL_MS,
  safePortalNext,
  sameHash,
  sessionCookieName,
  sessionExpiry,
  shouldTouch,
  signInExpiry,
} from './session-rules.js';

const NOW = new Date('2026-11-26T10:00:00Z');

describe('tokens', () => {
  it('makes 256 random bits as 43 url-safe characters, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 50 }, newToken));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isTokenShaped(token)).toBe(true);
    }
  });

  it('refuses anything that is not token-shaped before it is looked up', () => {
    for (const value of [undefined, '', 'short', `${'a'.repeat(43)}!`, 'a'.repeat(44), '../etc']) {
      expect(isTokenShaped(value)).toBe(false);
    }
  });

  it('stores a SHA-256 hex digest that is not the token', () => {
    const token = newToken();

    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(sameHash(hashToken(token), hashToken(token))).toBe(true);
    expect(sameHash(hashToken(token), hashToken(newToken()))).toBe(false);
    expect(sameHash('ab', 'abc')).toBe(false);
  });
});

describe('lifetimes', () => {
  it('lets a link live fifteen minutes and a session thirty days', () => {
    expect(SIGN_IN_TOKEN_TTL_MS).toBe(15 * 60_000);
    expect(signInExpiry(NOW).getTime() - NOW.getTime()).toBe(900_000);
    expect(SESSION_TTL_MS).toBe(30 * 86_400_000);
    expect(sessionExpiry(NOW).toISOString()).toBe('2026-12-26T10:00:00.000Z');
  });

  it('is expired exactly at the expiry instant', () => {
    expect(isExpired(NOW, new Date(NOW.getTime() - 1))).toBe(false);
    expect(isExpired(NOW, NOW)).toBe(true);
  });

  it('writes last_seen_at at most once per interval', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);

    expect(shouldTouch(NOW, at(SESSION_TOUCH_INTERVAL_MS - 1))).toBe(false);
    expect(shouldTouch(NOW, at(SESSION_TOUCH_INTERVAL_MS))).toBe(true);
  });
});

describe('cookie names', () => {
  it('uses __Host- over https, and the brand id on the shared host', () => {
    const brandId = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

    expect(sessionCookieName({ secure: true, brandId: null })).toBe('__Host-hd_cs');
    expect(sessionCookieName({ secure: true, brandId })).toBe(`__Host-hd_cs_${brandId}`);
    expect(nonceCookieName({ secure: true, brandId: null })).toBe('__Host-hd_cn');
    expect(nonceCookieName({ secure: true, brandId })).toBe(`__Host-hd_cn_${brandId}`);
  });

  it('keeps bare names over plain http, where a prefixed cookie would be dropped', () => {
    expect(sessionCookieName({ secure: false, brandId: null })).toBe('hd_cs');
    expect(nonceCookieName({ secure: false, brandId: 'b' })).toBe('hd_cn_b');
  });
});

describe('safePortalNext', () => {
  it('keeps a portal page', () => {
    expect(safePortalNext('/tickets')).toBe('/tickets');
    expect(safePortalNext('/tickets/0192c3f0-1a2b')).toBe('/tickets/0192c3f0-1a2b');
  });

  it.each([
    undefined,
    '',
    'tickets',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    'https://evil.example/tickets',
    'javascript:alert(1)',
    '/tickets/../admin',
    '/tickets//x',
    '/tickets?next=//evil',
    '/tickets#x',
    '/tickets/%2e%2e',
    '/tickets\n/x',
    '/admin',
    '/sign-in',
    `/tickets/${'a'.repeat(65)}`,
  ])('drops %j', (next) => {
    expect(safePortalNext(next)).toBeNull();
  });
});

describe('csrf', () => {
  const key = csrfKeyFrom(Buffer.alloc(32, 1));

  it('binds a token to one cookie value', () => {
    const token = csrfToken(key, 'cookie-a');

    expect(csrfValid(key, 'cookie-a', token)).toBe(true);
    expect(csrfValid(key, 'cookie-b', token)).toBe(false);
  });

  it('refuses a missing cookie, an empty or wrong token, and another key', () => {
    const token = csrfToken(key, 'cookie-a');

    expect(csrfValid(key, undefined, token)).toBe(false);
    expect(csrfValid(key, '', token)).toBe(false);
    expect(csrfValid(key, 'cookie-a', '')).toBe(false);
    expect(csrfValid(key, 'cookie-a', 'forged')).toBe(false);
    expect(csrfValid(csrfKeyFrom(Buffer.alloc(32, 2)), 'cookie-a', token)).toBe(false);
  });
});

describe('masked CSRF tokens', () => {
  const key = csrfKeyFrom(Buffer.alloc(32, 3));
  const cookie = 'c'.repeat(43);

  it('differ on every call, and each one still validates', () => {
    const token = csrfToken(key, cookie);
    const first = maskCsrf(token);
    const second = maskCsrf(token);

    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(csrfValid(key, cookie, first)).toBe(true);
    expect(csrfValid(key, cookie, second)).toBe(true);
  });

  it('still accepts the unmasked token the sign-in pages carry', () => {
    expect(csrfValid(key, cookie, csrfToken(key, cookie))).toBe(true);
  });

  it('refuses a mask of another cookie, a tampered mask and malformed ones', () => {
    const mine = maskCsrf(csrfToken(key, cookie));
    const other = maskCsrf(csrfToken(key, 'd'.repeat(43)));
    const [pad, masked] = mine.split('.');

    expect(csrfValid(key, cookie, other)).toBe(false);
    expect(csrfValid(key, cookie, `${pad}.${(masked ?? '').slice(1)}A`)).toBe(false);
    expect(csrfValid(key, cookie, `${pad}.`)).toBe(false);
    expect(csrfValid(key, cookie, '.')).toBe(false);
    expect(csrfValid(key, cookie, `${pad}.${masked}.${masked}`)).toBe(false);
  });
});
