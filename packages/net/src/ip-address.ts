/**
 * IP address and CIDR primitives, implemented here rather than pulled in as a
 * dependency: the whole package must stay dependency-free (ARCHITECTURE §1 pins
 * the stack, and an SSRF guard is a poor place for supply-chain surface).
 *
 * Addresses are byte arrays: 4 bytes for IPv4, 16 for IPv6. Textual parsing is
 * gated on `node:net`'s strict validators, so shorthand and octal forms such as
 * `127.0.0.01` or `0x7f.1` never reach the parsers below.
 */
import { isIPv4, isIPv6 } from 'node:net';

export const IPV4_BYTES = 4;
export const IPV6_BYTES = 16;

const IPV4_GROUPS = 4;
const IPV6_GROUPS = 8;
const BITS_PER_BYTE = 8;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;
const DECIMAL_PREFIX = /^\d{1,3}$/;

/** A network as a base address plus a prefix length in bits. */
export interface ParsedCidr {
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function parseIpv4Bytes(text: string): Uint8Array | undefined {
  const parts = text.split('.');
  if (parts.length !== IPV4_GROUPS) {
    return undefined;
  }

  const bytes = new Uint8Array(IPV4_BYTES);
  for (const [index, part] of parts.entries()) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return undefined;
    }
    bytes[index] = value;
  }

  return bytes;
}

/** Rewrites a trailing dotted-quad group (`::ffff:127.0.0.1`) as two hex groups. */
function expandEmbeddedIpv4(groups: readonly string[]): string[] | undefined {
  const last = groups.at(-1);
  if (last === undefined || !last.includes('.')) {
    return [...groups];
  }

  const embedded = parseIpv4Bytes(last);
  if (embedded === undefined) {
    return undefined;
  }

  const high = ((embedded[0] ?? 0) << BITS_PER_BYTE) | (embedded[1] ?? 0);
  const low = ((embedded[2] ?? 0) << BITS_PER_BYTE) | (embedded[3] ?? 0);
  return [...groups.slice(0, -1), high.toString(16), low.toString(16)];
}

function groupsToBytes(groups: readonly string[]): Uint8Array | undefined {
  const bytes = new Uint8Array(groups.length * 2);

  for (const [index, group] of groups.entries()) {
    if (!HEX_GROUP.test(group)) {
      return undefined;
    }
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >>> BITS_PER_BYTE;
    bytes[index * 2 + 1] = value & 0xff;
  }

  return bytes;
}

function parseIpv6Bytes(text: string): Uint8Array | undefined {
  // `node:net` accepts a zone id (`fe80::1%eth0`); it never affects reachability
  // decisions, so drop it before parsing.
  const address = text.split('%')[0] ?? '';
  const compressionAt = address.indexOf('::');
  const compressed = compressionAt !== -1;
  const headText = compressed ? address.slice(0, compressionAt) : address;
  const tailText = compressed ? address.slice(compressionAt + 2) : '';

  const head = expandEmbeddedIpv4(headText === '' ? [] : headText.split(':'));
  const tail = expandEmbeddedIpv4(tailText === '' ? [] : tailText.split(':'));
  if (head === undefined || tail === undefined) {
    return undefined;
  }

  const headBytes = groupsToBytes(head);
  const tailBytes = groupsToBytes(tail);
  if (headBytes === undefined || tailBytes === undefined) {
    return undefined;
  }

  const gap = IPV6_BYTES - headBytes.length - tailBytes.length;
  if (compressed ? gap < 0 : gap !== 0) {
    return undefined;
  }

  const bytes = new Uint8Array(IPV6_BYTES);
  bytes.set(headBytes, 0);
  bytes.set(tailBytes, IPV6_BYTES - tailBytes.length);
  return bytes;
}

/** Parses a literal IPv4 or IPv6 address into bytes, or returns undefined. */
export function parseIp(text: string): Uint8Array | undefined {
  if (isIPv4(text)) {
    return parseIpv4Bytes(text);
  }
  if (isIPv6(text)) {
    return parseIpv6Bytes(text);
  }
  return undefined;
}

/** True when the string is a literal address rather than a name to resolve. */
export function isIpLiteral(text: string): boolean {
  return isIPv4(text) || isIPv6(text);
}

/**
 * Parses `10.0.0.0/8` or `fd00::/8`. The prefix is required: a bare address is
 * rejected rather than guessed at, so a typo in `OUTBOUND_ALLOW_CIDRS` fails
 * loudly instead of widening or narrowing the allow-list silently.
 */
export function parseCidr(text: string): ParsedCidr | undefined {
  const separator = text.lastIndexOf('/');
  if (separator === -1) {
    return undefined;
  }

  const bytes = parseIp(text.slice(0, separator));
  if (bytes === undefined) {
    return undefined;
  }

  const prefixText = text.slice(separator + 1);
  if (!DECIMAL_PREFIX.test(prefixText)) {
    return undefined;
  }

  const prefix = Number(prefixText);
  if (prefix > bytes.length * BITS_PER_BYTE) {
    return undefined;
  }

  return { bytes, prefix };
}

/** True when `address` falls inside `cidr`. Families must match. */
export function cidrContains(cidr: ParsedCidr, address: Uint8Array): boolean {
  if (cidr.bytes.length !== address.length) {
    return false;
  }

  const wholeBytes = Math.floor(cidr.prefix / BITS_PER_BYTE);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (cidr.bytes[index] !== address[index]) {
      return false;
    }
  }

  const remainingBits = cidr.prefix % BITS_PER_BYTE;
  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xff << (BITS_PER_BYTE - remainingBits)) & 0xff;
  return ((cidr.bytes[wholeBytes] ?? 0) & mask) === ((address[wholeBytes] ?? 0) & mask);
}

const IPV4_MAPPED_PREFIX = parseCidr('::ffff:0:0/96');
const IPV4_MAPPED_OFFSET = 12;

/**
 * Returns the IPv4 address embedded in an IPv4-mapped IPv6 address
 * (`::ffff:127.0.0.1`), or undefined when there is none. Both the block list and
 * the allow-list unmap before matching, so the two agree on what an address is.
 */
export function unmapIpv4(address: Uint8Array): Uint8Array | undefined {
  if (address.length !== IPV6_BYTES || IPV4_MAPPED_PREFIX === undefined) {
    return undefined;
  }
  return cidrContains(IPV4_MAPPED_PREFIX, address)
    ? address.slice(IPV4_MAPPED_OFFSET, IPV4_MAPPED_OFFSET + IPV4_BYTES)
    : undefined;
}

/** Formats bytes back to text, for error messages and logs. */
export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === IPV4_BYTES) {
    return Array.from(bytes).join('.');
  }

  const groups: string[] = [];
  for (let index = 0; index < IPV6_GROUPS; index += 1) {
    const value = ((bytes[index * 2] ?? 0) << BITS_PER_BYTE) | (bytes[index * 2 + 1] ?? 0);
    groups.push(value.toString(16));
  }
  return groups.join(':');
}
