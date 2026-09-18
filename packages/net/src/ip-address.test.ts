import { describe, expect, it } from 'vitest';
import {
  cidrContains,
  formatIp,
  isIpLiteral,
  parseCidr,
  parseIp,
  unmapIpv4,
} from './ip-address.js';

function ip(text: string): Uint8Array {
  const bytes = parseIp(text);
  if (bytes === undefined) {
    throw new Error(`test fixture is not an address: ${text}`);
  }
  return bytes;
}

function cidr(text: string) {
  const parsed = parseCidr(text);
  if (parsed === undefined) {
    throw new Error(`test fixture is not a CIDR: ${text}`);
  }
  return parsed;
}

describe('parseIp', () => {
  it('parses a dotted quad into four bytes', () => {
    expect(Array.from(ip('192.168.1.255'))).toEqual([192, 168, 1, 255]);
  });

  it('parses a full IPv6 address into sixteen bytes', () => {
    expect(formatIp(ip('2001:db8:0:0:0:0:0:1'))).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('expands :: compression from either end', () => {
    expect(Array.from(ip('::1'))).toEqual([...new Array(15).fill(0), 1]);
    expect(Array.from(ip('fe80::'))[0]).toBe(0xfe);
    expect(Array.from(ip('fe80::'))[15]).toBe(0);
  });

  it('parses an embedded IPv4 tail', () => {
    const bytes = ip('::ffff:127.0.0.1');
    expect(Array.from(bytes.slice(10))).toEqual([0xff, 0xff, 127, 0, 0, 1]);
  });

  it('ignores an IPv6 zone id', () => {
    expect(formatIp(ip('fe80::1%eth0'))).toBe('fe80:0:0:0:0:0:0:1');
  });

  it.each([
    ['127.0.0.01', 'leading zero, which some resolvers read as octal'],
    ['0x7f.0.0.1', 'hexadecimal shorthand'],
    ['127.1', 'short form'],
    ['256.0.0.1', 'out of range'],
    ['not-an-address', 'a hostname'],
    ['', 'the empty string'],
    ['1:2:3:4:5:6:7:8:9', 'too many IPv6 groups'],
  ])('rejects %s (%s)', (text) => {
    expect(parseIp(text)).toBeUndefined();
  });
});

describe('isIpLiteral', () => {
  it('separates literals from names', () => {
    expect(isIpLiteral('10.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('parseCidr', () => {
  it('parses an IPv4 network', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ bytes: ip('10.0.0.0'), prefix: 8 });
  });

  it('parses an IPv6 network', () => {
    expect(parseCidr('fc00::/7')).toEqual({ bytes: ip('fc00::'), prefix: 7 });
  });

  it.each([
    ['10.0.0.0', 'a bare address without a prefix'],
    ['10.0.0.0/33', 'an IPv4 prefix over 32'],
    ['fc00::/129', 'an IPv6 prefix over 128'],
    ['10.0.0.0/', 'an empty prefix'],
    ['10.0.0.0/eight', 'a non-numeric prefix'],
    ['10.0.0.0/-1', 'a negative prefix'],
    ['not-a-network/8', 'a non-address'],
  ])('rejects %s (%s)', (text) => {
    expect(parseCidr(text)).toBeUndefined();
  });
});

describe('cidrContains', () => {
  it('matches every address under /0', () => {
    expect(cidrContains(cidr('0.0.0.0/0'), ip('8.8.8.8'))).toBe(true);
    expect(cidrContains(cidr('::/0'), ip('2001:db8::1'))).toBe(true);
  });

  it('matches only the exact address under /32 and /128', () => {
    expect(cidrContains(cidr('169.254.169.254/32'), ip('169.254.169.254'))).toBe(true);
    expect(cidrContains(cidr('169.254.169.254/32'), ip('169.254.169.253'))).toBe(false);
    expect(cidrContains(cidr('fd00:ec2::254/128'), ip('fd00:ec2::254'))).toBe(true);
    expect(cidrContains(cidr('fd00:ec2::254/128'), ip('fd00:ec2::255'))).toBe(false);
  });

  it('honours a prefix that ends mid-byte', () => {
    expect(cidrContains(cidr('172.16.0.0/12'), ip('172.16.0.1'))).toBe(true);
    expect(cidrContains(cidr('172.16.0.0/12'), ip('172.31.255.255'))).toBe(true);
    expect(cidrContains(cidr('172.16.0.0/12'), ip('172.32.0.1'))).toBe(false);
    expect(cidrContains(cidr('100.64.0.0/10'), ip('100.127.255.255'))).toBe(true);
    expect(cidrContains(cidr('100.64.0.0/10'), ip('100.128.0.1'))).toBe(false);
  });

  it('never matches across families', () => {
    expect(cidrContains(cidr('0.0.0.0/0'), ip('::1'))).toBe(false);
    expect(cidrContains(cidr('::/0'), ip('8.8.8.8'))).toBe(false);
  });
});

describe('unmapIpv4', () => {
  it('returns the embedded address for an IPv4-mapped IPv6 address', () => {
    expect(formatIp(unmapIpv4(ip('::ffff:10.0.0.7')) as Uint8Array)).toBe('10.0.0.7');
  });

  it('leaves an address that carries no mapped IPv4 alone', () => {
    expect(unmapIpv4(ip('2001:db8::1'))).toBeUndefined();
    expect(unmapIpv4(ip('10.0.0.7'))).toBeUndefined();
  });
});

describe('formatIp', () => {
  it('round-trips both families', () => {
    expect(formatIp(ip('203.0.113.9'))).toBe('203.0.113.9');
    expect(formatIp(ip('2002:7f00:1::'))).toBe('2002:7f00:1:0:0:0:0:0');
  });
});
