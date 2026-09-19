import { describe, expect, it } from 'vitest';
import { bearerToken, isPrivateAddress, metricsAccess, tokenMatches } from './metrics-access.js';

const TOKEN = 'a-metrics-token-long-enough';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1%eth0',
    '::ffff:10.0.0.4',
  ])('accepts %s, which can only be reached from inside', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '172.15.0.1',
    '192.169.1.1',
    '100.128.0.1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ])('refuses %s, which is a public address', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('refuses an address it was not given, rather than assuming the best', () => {
    expect(isPrivateAddress(undefined)).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
    expect(isPrivateAddress('not-an-address')).toBe(false);
  });

  it.each(['fe80.evil.example', 'FC00.example.net', 'fd00 is not an address', '::1.example'])(
    'refuses %s, which only looks like a private address to a hex parser',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('bearerToken', () => {
  it('reads the token whatever case the scheme is written in', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('  BEARER   abc  ')).toBe('abc');
  });

  it.each([undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer a b'])(
    'reads nothing out of %o',
    (header) => {
      expect(bearerToken(header)).toBeUndefined();
    },
  );
});

describe('tokenMatches', () => {
  it('accepts the token and nothing else', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
  });
});

describe('metricsAccess', () => {
  it('lets a scraper that dialled this process from the private network in without a token', () => {
    expect(
      metricsAccess({
        remoteAddress: '10.0.1.7',
        authorization: undefined,
        expectedToken: undefined,
        viaProxy: false,
      }),
    ).toBe('private-network');
  });

  /**
   * The one that matters. Behind a proxy the socket peer is the proxy, which is
   * always on the private network — so an internet client the proxy forwarded
   * would otherwise pass on the proxy's credentials rather than its own.
   */
  it('refuses a proxied request on its address alone, however private the peer', () => {
    expect(
      metricsAccess({
        remoteAddress: '172.18.0.2',
        authorization: undefined,
        expectedToken: TOKEN,
        viaProxy: true,
      }),
    ).toBe('denied');
  });

  it('still lets a proxied request in when it carries the token', () => {
    expect(
      metricsAccess({
        remoteAddress: '172.18.0.2',
        authorization: `Bearer ${TOKEN}`,
        expectedToken: TOKEN,
        viaProxy: true,
      }),
    ).toBe('token');
  });

  it('lets a scraper elsewhere in with the token', () => {
    expect(
      metricsAccess({
        remoteAddress: '203.0.113.5',
        authorization: `Bearer ${TOKEN}`,
        expectedToken: TOKEN,
        viaProxy: false,
      }),
    ).toBe('token');
  });

  it('refuses a public address with no token, with the wrong token, or with a token nobody configured', () => {
    expect(
      metricsAccess({
        remoteAddress: '203.0.113.5',
        authorization: undefined,
        expectedToken: TOKEN,
        viaProxy: false,
      }),
    ).toBe('denied');

    expect(
      metricsAccess({
        remoteAddress: '203.0.113.5',
        authorization: 'Bearer wrong-token-entirely',
        expectedToken: TOKEN,
        viaProxy: false,
      }),
    ).toBe('denied');

    // No `METRICS_TOKEN` set: a presented token cannot open the door, or an
    // install that never configured one would be opened by any bearer at all.
    expect(
      metricsAccess({
        remoteAddress: '203.0.113.5',
        authorization: `Bearer ${TOKEN}`,
        expectedToken: undefined,
        viaProxy: false,
      }),
    ).toBe('denied');
  });

  it('refuses a request whose peer address is unknown', () => {
    expect(
      metricsAccess({
        remoteAddress: undefined,
        authorization: undefined,
        expectedToken: TOKEN,
        viaProxy: false,
      }),
    ).toBe('denied');
  });
});
