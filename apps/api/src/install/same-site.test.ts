import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertSameSiteRequest, isSameSiteRequest } from './same-site.js';

describe('isSameSiteRequest', () => {
  it.each([
    ['same-origin', 'the admin app this api serves'],
    ['none', 'somebody typing the address, or a bookmark'],
  ])('allows %s (%s)', (fetchSite) => {
    expect(isSameSiteRequest(fetchSite)).toBe(true);
  });

  it.each([
    ['cross-site', 'a page on another site'],
    // A sibling subdomain is refused for the same reason the session cookies
    // carry no `Domain`: `evil.example.com` is not this install.
    ['same-site', 'another host under the same registrable domain'],
  ])('refuses %s (%s)', (fetchSite) => {
    expect(isSameSiteRequest(fetchSite)).toBe(false);
  });

  it('allows a client that sends no header, because it has no browser to deputise', () => {
    expect(isSameSiteRequest(undefined)).toBe(true);
  });

  it('refuses a value it does not recognise rather than guessing', () => {
    expect(isSameSiteRequest('somewhere-else')).toBe(false);
  });
});

describe('assertSameSiteRequest', () => {
  it('passes a same-origin request through', () => {
    expect(() => {
      assertSameSiteRequest({ 'sec-fetch-site': 'same-origin' });
    }).not.toThrow();
  });

  it('refuses a cross-site one with a 403', () => {
    expect(() => {
      assertSameSiteRequest({ 'sec-fetch-site': 'cross-site' });
    }).toThrow(ForbiddenException);
  });

  it('reads the first value when a header arrives more than once', () => {
    expect(() => {
      assertSameSiteRequest({ 'sec-fetch-site': ['cross-site', 'same-origin'] });
    }).toThrow(ForbiddenException);
  });

  it('says nothing about the install in its message', () => {
    try {
      assertSameSiteRequest({ 'sec-fetch-site': 'cross-site' });
      expect.unreachable('it should have refused');
    } catch (error) {
      expect((error as ForbiddenException).message).toBe(
        'Setup can only be started from this install',
      );
    }
  });
});
