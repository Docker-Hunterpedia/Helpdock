/**
 * Turns a URL into the single address the request is allowed to connect to:
 * scheme, credential and port checks, then resolution and range checks.
 *
 * Every hop of a redirect chain goes through this module again (DOMAIN-RULES §13).
 */
import { blockedReason } from './blocked-ranges.js';
import { SafeFetchError } from './errors.js';
import { cidrContains, IPV6_BYTES, isIpLiteral, parseIp, unmapIpv4 } from './ip-address.js';
import type { ResolvedPolicy } from './policy.js';

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };
const ALLOWED_PROTOCOLS = Object.keys(DEFAULT_PORTS);

/** A URL that passed the scheme, credential and port checks. */
export interface ValidatedUrl {
  readonly url: URL;
  /** Hostname without the brackets a URL puts around an IPv6 literal. */
  readonly hostname: string;
  readonly port: number;
}

/** The one address a hop may connect to, pinned before the socket is opened. */
export interface Destination {
  readonly target: ValidatedUrl;
  readonly address: string;
  readonly family: 4 | 6;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function assertScheme(url: URL, hop: number): void {
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new SafeFetchError(
      'scheme-not-allowed',
      `scheme ${url.protocol} is not allowed (only http: and https:): ${url.href}`,
      { url: url.href, hop },
    );
  }
}

function assertNoCredentials(url: URL, hop: number): void {
  if (url.username === '' && url.password === '') {
    return;
  }

  // Neither the message nor the details carry the href: it holds the credential.
  const origin = `${url.protocol}//${url.host}`;
  throw new SafeFetchError('credentials-in-url', `URL must not carry credentials: ${origin}`, {
    url: origin,
    host: stripBrackets(url.hostname),
    hop,
  });
}

function portOf(url: URL, hostname: string, policy: ResolvedPolicy, hop: number): number {
  const port = url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? 0) : Number(url.port);
  if (!policy.allowedPorts.has(port)) {
    throw new SafeFetchError('port-not-allowed', `port ${port} is not allowed: ${url.href}`, {
      url: url.href,
      host: hostname,
      hop,
    });
  }
  return port;
}

/** Applies the scheme, credential and port rules to one hop. */
export function validateUrl(raw: string | URL, policy: ResolvedPolicy, hop: number): ValidatedUrl {
  const url = typeof raw === 'string' ? URL.parse(raw) : raw;
  if (url === null) {
    throw new SafeFetchError('invalid-url', `not a valid absolute URL: ${String(raw)}`, { hop });
  }

  assertScheme(url, hop);
  assertNoCredentials(url, hop);

  const hostname = stripBrackets(url.hostname);
  if (hostname === '') {
    throw new SafeFetchError('invalid-url', `URL has no host: ${url.href}`, { url: url.href, hop });
  }

  return { url, hostname, port: portOf(url, hostname, policy, hop) };
}

/** True when the operator allow-listed the address in `OUTBOUND_ALLOW_CIDRS`. */
function isAllowListed(policy: ResolvedPolicy, address: Uint8Array): boolean {
  const mapped = unmapIpv4(address);
  return policy.allowCidrs.some(
    (cidr) => cidrContains(cidr, address) || (mapped !== undefined && cidrContains(cidr, mapped)),
  );
}

/** Checks one resolved address and returns its bytes so the caller can reuse them. */
function assertAllowed(
  target: ValidatedUrl,
  candidate: { readonly address: string },
  policy: ResolvedPolicy,
  hop: number,
): Uint8Array {
  const bytes = parseIp(candidate.address);
  if (bytes === undefined) {
    throw new SafeFetchError(
      'destination-blocked',
      `${target.hostname} resolved to an unparseable address ${candidate.address}`,
      { url: target.url.href, host: target.hostname, address: candidate.address, hop },
    );
  }

  const reason = blockedReason(bytes);
  if (reason === undefined || isAllowListed(policy, bytes)) {
    return bytes;
  }

  throw new SafeFetchError(
    'destination-blocked',
    `${target.hostname} resolves to ${candidate.address}, which is in a blocked range (${reason})`,
    { url: target.url.href, host: target.hostname, address: candidate.address, hop },
  );
}

async function resolveAddresses(
  target: ValidatedUrl,
  policy: ResolvedPolicy,
  hop: number,
): Promise<readonly { readonly address: string }[]> {
  if (isIpLiteral(target.hostname)) {
    return [{ address: target.hostname }];
  }

  let addresses: readonly { readonly address: string }[];
  try {
    addresses = await policy.lookup(target.hostname);
  } catch (cause) {
    throw new SafeFetchError(
      'dns-failure',
      `could not resolve ${target.hostname}`,
      { url: target.url.href, host: target.hostname, hop },
      { cause },
    );
  }

  if (addresses.length === 0) {
    throw new SafeFetchError('dns-failure', `${target.hostname} resolved to no addresses`, {
      url: target.url.href,
      host: target.hostname,
      hop,
    });
  }

  return addresses;
}

/**
 * Resolves the hop and returns the address the socket must use. Rejects when any
 * resolved address is blocked, not only the first, so a name that mixes a public
 * and a private answer cannot be used to smuggle a request inside.
 */
export async function resolveDestination(
  target: ValidatedUrl,
  policy: ResolvedPolicy,
  hop: number,
): Promise<Destination> {
  const addresses = await resolveAddresses(target, policy, hop);
  let pinned: Destination | undefined;

  for (const candidate of addresses) {
    const bytes = assertAllowed(target, candidate, policy, hop);
    // The family comes from the address we parsed, not from the label the
    // resolver put on it, so a mislabelled answer cannot pick the wrong stack.
    pinned ??= {
      target,
      address: candidate.address,
      family: bytes.length === IPV6_BYTES ? 6 : 4,
    };
  }

  if (pinned === undefined) {
    throw new SafeFetchError('dns-failure', `${target.hostname} resolved to no addresses`, {
      url: target.url.href,
      host: target.hostname,
      hop,
    });
  }

  return pinned;
}
