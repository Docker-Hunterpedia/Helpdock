/**
 * The destination ranges DOMAIN-RULES §13 forbids: loopback, private, link-local,
 * CGNAT, multicast, reserved and cloud metadata, for IPv4 and for IPv6 including
 * the transition formats that carry an IPv4 address inside an IPv6 one.
 */
import {
  cidrContains,
  formatIp,
  IPV4_BYTES,
  IPV6_BYTES,
  type ParsedCidr,
  parseCidr,
  unmapIpv4,
} from './ip-address.js';

interface NamedRange {
  readonly name: string;
  readonly cidr: ParsedCidr;
}

function range(name: string, cidr: string): NamedRange {
  const parsed = parseCidr(cidr);
  if (parsed === undefined) {
    throw new TypeError(`unparseable built-in range ${cidr}`);
  }
  return { name, cidr: parsed };
}

/**
 * Narrower entries come first so the reported reason is the most specific one:
 * an operator reading a blocked-attempt log wants "cloud metadata", not
 * "link-local".
 */
const IPV4_RANGES: readonly NamedRange[] = [
  range('IPv4 cloud metadata 169.254.169.254', '169.254.169.254/32'),
  range('IPv4 broadcast 255.255.255.255', '255.255.255.255/32'),
  range('IPv4 unspecified 0.0.0.0/8', '0.0.0.0/8'),
  range('IPv4 loopback 127.0.0.0/8', '127.0.0.0/8'),
  range('IPv4 private 10.0.0.0/8', '10.0.0.0/8'),
  range('IPv4 private 172.16.0.0/12', '172.16.0.0/12'),
  range('IPv4 private 192.168.0.0/16', '192.168.0.0/16'),
  range('IPv4 link-local 169.254.0.0/16', '169.254.0.0/16'),
  range('IPv4 CGNAT 100.64.0.0/10', '100.64.0.0/10'),
  range('IPv4 multicast 224.0.0.0/4', '224.0.0.0/4'),
  range('IPv4 reserved 240.0.0.0/4', '240.0.0.0/4'),
];

const IPV6_RANGES: readonly NamedRange[] = [
  range('IPv6 cloud metadata fd00:ec2::254', 'fd00:ec2::254/128'),
  range('IPv6 unspecified ::', '::/128'),
  range('IPv6 loopback ::1', '::1/128'),
  range('IPv6 unique-local fc00::/7', 'fc00::/7'),
  range('IPv6 link-local fe80::/10', 'fe80::/10'),
  range('IPv6 multicast ff00::/8', 'ff00::/8'),
];

const SIX_TO_FOUR = range('6to4', '2002::/16');
const TEREDO = range('Teredo', '2001::/32');

const SIX_TO_FOUR_OFFSET = 2;
const TEREDO_SERVER_OFFSET = 4;
const TEREDO_CLIENT_OFFSET = 12;
const TEREDO_CLIENT_OBFUSCATION = 0xff;

function matchRange(ranges: readonly NamedRange[], address: Uint8Array): string | undefined {
  return ranges.find((candidate) => cidrContains(candidate.cidr, address))?.name;
}

function sliceIpv4(address: Uint8Array, offset: number): Uint8Array {
  return address.slice(offset, offset + IPV4_BYTES);
}

/** Teredo stores the client's IPv4 in the last four bytes, inverted. */
function teredoClientIpv4(address: Uint8Array): Uint8Array {
  return sliceIpv4(address, TEREDO_CLIENT_OFFSET).map((byte) => byte ^ TEREDO_CLIENT_OBFUSCATION);
}

function describeEmbedded(format: string, embedded: Uint8Array): string | undefined {
  const reason = matchRange(IPV4_RANGES, embedded);
  return reason === undefined ? undefined : `${format} ${formatIp(embedded)} (${reason})`;
}

function ipv6BlockedReason(address: Uint8Array): string | undefined {
  const explicit = matchRange(IPV6_RANGES, address);
  if (explicit !== undefined) {
    return explicit;
  }

  const mapped = unmapIpv4(address);
  if (mapped !== undefined) {
    return describeEmbedded('IPv4-mapped IPv6', mapped);
  }

  if (cidrContains(SIX_TO_FOUR.cidr, address)) {
    return describeEmbedded('6to4 embedded IPv4', sliceIpv4(address, SIX_TO_FOUR_OFFSET));
  }

  if (cidrContains(TEREDO.cidr, address)) {
    return (
      describeEmbedded('Teredo server IPv4', sliceIpv4(address, TEREDO_SERVER_OFFSET)) ??
      describeEmbedded('Teredo client IPv4', teredoClientIpv4(address))
    );
  }

  return undefined;
}

/**
 * Returns a human-readable reason when the address must not be connected to, or
 * undefined when it is a legitimate public destination. The allow-list is applied
 * by the caller, on top of this answer.
 */
export function blockedReason(address: Uint8Array): string | undefined {
  if (address.length === IPV4_BYTES) {
    return matchRange(IPV4_RANGES, address);
  }
  if (address.length === IPV6_BYTES) {
    return ipv6BlockedReason(address);
  }
  return 'address of an unknown family';
}
