import { describe, expect, it } from 'vitest';
import { blockedReason } from './blocked-ranges.js';
import { parseIp } from './ip-address.js';

function reasonFor(text: string): string | undefined {
  const bytes = parseIp(text);
  if (bytes === undefined) {
    throw new Error(`test fixture is not an address: ${text}`);
  }
  return blockedReason(bytes);
}

describe('blockedReason, IPv4', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback 127.0.0.0/8'],
    ['127.255.255.254', 'IPv4 loopback 127.0.0.0/8'],
    ['0.0.0.0', 'IPv4 unspecified 0.0.0.0/8'],
    ['0.1.2.3', 'IPv4 unspecified 0.0.0.0/8'],
    ['10.0.0.1', 'IPv4 private 10.0.0.0/8'],
    ['172.16.0.1', 'IPv4 private 172.16.0.0/12'],
    ['172.31.255.255', 'IPv4 private 172.16.0.0/12'],
    ['192.168.1.1', 'IPv4 private 192.168.0.0/16'],
    ['169.254.1.1', 'IPv4 link-local 169.254.0.0/16'],
    ['100.64.0.1', 'IPv4 CGNAT 100.64.0.0/10'],
    ['224.0.0.1', 'IPv4 multicast 224.0.0.0/4'],
    ['239.255.255.255', 'IPv4 multicast 224.0.0.0/4'],
    ['240.0.0.1', 'IPv4 reserved 240.0.0.0/4'],
    ['255.255.255.255', 'IPv4 broadcast 255.255.255.255'],
    ['169.254.169.254', 'IPv4 cloud metadata 169.254.169.254'],
  ])('blocks %s as %s', (address, reason) => {
    expect(reasonFor(address)).toBe(reason);
  });

  it.each(['8.8.8.8', '1.1.1.1', '203.0.113.9', '172.32.0.1', '11.0.0.1', '100.128.0.1'])(
    'allows the public address %s',
    (address) => {
      expect(reasonFor(address)).toBeUndefined();
    },
  );
});

describe('blockedReason, IPv6', () => {
  it.each([
    ['::1', 'IPv6 loopback ::1'],
    ['::', 'IPv6 unspecified ::'],
    ['fc00::1', 'IPv6 unique-local fc00::/7'],
    ['fdff::1', 'IPv6 unique-local fc00::/7'],
    ['fe80::1', 'IPv6 link-local fe80::/10'],
    ['ff02::1', 'IPv6 multicast ff00::/8'],
    ['fd00:ec2::254', 'IPv6 cloud metadata fd00:ec2::254'],
  ])('blocks %s as %s', (address, reason) => {
    expect(reasonFor(address)).toBe(reason);
  });

  it.each(['2001:4860:4860::8888', '2606:4700:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(reasonFor(address)).toBeUndefined();
    },
  );
});

describe('blockedReason, IPv6 addresses carrying an IPv4 one', () => {
  it('unmaps an IPv4-mapped IPv6 address and re-checks it', () => {
    expect(reasonFor('::ffff:127.0.0.1')).toBe(
      'IPv4-mapped IPv6 127.0.0.1 (IPv4 loopback 127.0.0.0/8)',
    );
    expect(reasonFor('::ffff:169.254.169.254')).toBe(
      'IPv4-mapped IPv6 169.254.169.254 (IPv4 cloud metadata 169.254.169.254)',
    );
  });

  it('allows an IPv4-mapped IPv6 address whose IPv4 is public', () => {
    expect(reasonFor('::ffff:8.8.8.8')).toBeUndefined();
  });

  it('checks the IPv4 embedded in a 6to4 address', () => {
    expect(reasonFor('2002:a00:1::1')).toBe(
      '6to4 embedded IPv4 10.0.0.1 (IPv4 private 10.0.0.0/8)',
    );
    expect(reasonFor('2002:0808:0808::1')).toBeUndefined();
  });

  it('checks the IPv4 embedded in a NAT64 address', () => {
    // On a NAT64 network the well-known prefix is a live route to the IPv4
    // internet, so 64:ff9b::a00:1 reaches 10.0.0.1.
    expect(reasonFor('64:ff9b::a00:1')).toBe(
      'NAT64 embedded IPv4 10.0.0.1 (IPv4 private 10.0.0.0/8)',
    );
    expect(reasonFor('64:ff9b::169.254.169.254')).toBe(
      'NAT64 embedded IPv4 169.254.169.254 (IPv4 cloud metadata 169.254.169.254)',
    );
    expect(reasonFor('64:ff9b::7f00:1')).toBe(
      'NAT64 embedded IPv4 127.0.0.1 (IPv4 loopback 127.0.0.0/8)',
    );
    expect(reasonFor('64:ff9b::808:808')).toBeUndefined();
  });

  it('checks both IPv4 addresses embedded in a Teredo address', () => {
    // 2001:0::<server v4>:<flags>:<port>:<obfuscated client v4>
    expect(reasonFor('2001:0:a00:1::')).toBe(
      'Teredo server IPv4 10.0.0.1 (IPv4 private 10.0.0.0/8)',
    );
    // Public server, client 192.168.0.1 stored as its bitwise complement.
    expect(reasonFor('2001:0:808:808::3f57:fffe')).toBe(
      'Teredo client IPv4 192.168.0.1 (IPv4 private 192.168.0.0/16)',
    );
    expect(reasonFor('2001:0:808:808::f7f7:f7f7')).toBeUndefined();
  });
});

describe('blockedReason, unknown families', () => {
  it('refuses an address that is neither 4 nor 16 bytes', () => {
    expect(blockedReason(new Uint8Array(6))).toBe('address of an unknown family');
  });
});
