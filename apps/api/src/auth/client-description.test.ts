import { describe, expect, it } from 'vitest';
import { describeClient, truncateAddress } from './client-description.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

describe('describeClient', () => {
  it.each([
    [CHROME_MAC, 'Chrome', 'macOS'],
    [EDGE_WINDOWS, 'Edge', 'Windows'],
    [SAFARI_IPHONE, 'Safari', 'iOS'],
    [FIREFOX_LINUX, 'Firefox', 'Linux'],
  ])('names the browser and system in %#', (userAgent, browser, os) => {
    expect(describeClient(userAgent, null)).toEqual({ browser, os });
  });

  it('leaves out what it cannot tell, rather than guessing', () => {
    expect(describeClient('curl/8.4.0', null)).toEqual({});
    expect(describeClient(null, undefined)).toEqual({});
  });

  it('keeps the network part of the address only', () => {
    expect(describeClient(null, '85.12.34.56')).toEqual({ ip: '85.12.x.x' });
  });
});

describe('truncateAddress', () => {
  it.each([
    ['203.0.113.77', '203.0.x.x'],
    ['::ffff:203.0.113.77', '203.0.x.x'],
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8:x:x'],
  ])('cuts %s to %s', (address, expected) => {
    expect(truncateAddress(address)).toBe(expected);
  });

  it.each(['', 'not an address', '::1', '999'])('refuses %j', (address) => {
    expect(truncateAddress(address)).toBeUndefined();
  });
});
