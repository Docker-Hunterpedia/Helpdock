/**
 * The knobs a caller may turn, the defaults from DOMAIN-RULES §13, and the three
 * presets the features named there use.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { SafeFetchErrorCode } from './errors.js';
import { type ParsedCidr, parseCidr } from './ip-address.js';

/** One address returned by a resolver. */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/**
 * Resolves a hostname to every address it has. Injected in tests; in production
 * it is `dns.lookup` with `all: true`.
 */
export type LookupFunction = (hostname: string) => Promise<readonly LookupAddress[]>;

/** Passed to {@link SafeFetchPolicy.onBlocked} for every attempt that is refused. */
export interface BlockedEvent {
  readonly code: SafeFetchErrorCode;
  /** The URL of the hop that was refused. */
  readonly url: string | undefined;
  readonly host: string | undefined;
  /** The address the decision was made on, when there was one. */
  readonly address: string | undefined;
  /** Redirect hop index: 0 is the URL the caller passed in. */
  readonly hop: number;
  readonly reason: string;
}

export interface SafeFetchPolicy {
  /** Ports the destination may use. Default 80, 443, 8080, 8443. */
  readonly allowedPorts?: readonly number[];
  /**
   * CIDRs that override the blocked ranges, from `OUTBOUND_ALLOW_CIDRS`. An
   * operator uses this to reach an internal destination on purpose, such as a
   * private Notion proxy on `10.0.0.0/8`.
   */
  readonly allowCidrs?: readonly string[];
  /** Redirects followed before giving up. Default 5. */
  readonly maxRedirects?: number;
  /** Per-hop TCP connect budget in milliseconds. Default 10 000. */
  readonly connectTimeoutMs?: number;
  /** Budget for the whole call, redirects included, in milliseconds. Default 30 000. */
  readonly totalTimeoutMs?: number;
  /** Response body cap in bytes. Default 10 MB. */
  readonly maxBodyBytes?: number;
  /** Resolver override. Tests inject one; production uses `dns.lookup`. */
  readonly lookup?: LookupFunction;
  /** Called for every refused attempt so the caller can log it. Must not throw. */
  readonly onBlocked?: (event: BlockedEvent) => void;
}

/** A policy with every default filled in and every CIDR already parsed. */
export interface ResolvedPolicy {
  readonly allowedPorts: ReadonlySet<number>;
  readonly allowCidrs: readonly ParsedCidr[];
  readonly maxRedirects: number;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly lookup: LookupFunction;
  readonly onBlocked: ((event: BlockedEvent) => void) | undefined;
}

const KIB = 1024;
const MIB = 1024 * KIB;

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 10 * MIB;

/**
 * The three response caps DOMAIN-RULES §13 names. A caller picks one and may
 * still override any field by spreading it.
 */
export const policies = {
  /** Crawling help-center and knowledge pages: 10 MB. */
  crawl: { maxBodyBytes: 10 * MIB },
  /** Webhook delivery: a small response, on a short leash. */
  webhook: { maxBodyBytes: 1 * MIB, totalTimeoutMs: 15_000 },
  /** Remote image proxy: 20 MB. */
  imageProxy: { maxBodyBytes: 20 * MIB },
} as const satisfies Record<string, SafeFetchPolicy>;

const defaultLookup: LookupFunction = async (hostname) => await dnsLookup(hostname, { all: true });

function parseAllowCidrs(entries: readonly string[]): ParsedCidr[] {
  return entries.map((entry) => {
    const parsed = parseCidr(entry);
    if (parsed === undefined) {
      // Fails loudly rather than dropping the entry: an operator who mistypes an
      // allow-list line must not be left believing an internal host is reachable.
      throw new TypeError(`invalid CIDR in allowCidrs: ${entry}`);
    }
    return parsed;
  });
}

function assertPositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number, got ${value}`);
  }
  return value;
}

export function resolvePolicy(policy: SafeFetchPolicy = {}): ResolvedPolicy {
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError(`maxRedirects must be a non-negative integer, got ${maxRedirects}`);
  }

  return {
    allowedPorts: new Set(policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS),
    allowCidrs: parseAllowCidrs(policy.allowCidrs ?? []),
    maxRedirects,
    connectTimeoutMs: assertPositive(
      'connectTimeoutMs',
      policy.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    totalTimeoutMs: assertPositive(
      'totalTimeoutMs',
      policy.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    ),
    maxBodyBytes: assertPositive('maxBodyBytes', policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
    lookup: policy.lookup ?? defaultLookup,
    onBlocked: policy.onBlocked,
  };
}

/**
 * Reports a refusal to the caller's hook. A logging sink that throws must not
 * mask the security decision that triggered it, so its failure is swallowed.
 */
export function reportBlocked(policy: ResolvedPolicy, event: BlockedEvent): void {
  if (policy.onBlocked === undefined) {
    return;
  }
  try {
    policy.onBlocked(event);
  } catch {
    // Intentionally ignored; see the note above.
  }
}
