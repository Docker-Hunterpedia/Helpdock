/**
 * DNS record lookups with a deadline, for checks that read records rather than
 * connect anywhere: the custom-domain verification of M5-07 reads a CNAME, a TXT
 * record and the addresses a name points at.
 *
 * Every hostname passed here was typed by somebody, and every answer comes from
 * a name server that somebody controls, so:
 *
 * - each query has a timeout and a retry budget, and a slow or silent server is
 *   a `failed` answer rather than a hung job;
 * - "the name has no such record" (`absent`) is kept apart from "the lookup did
 *   not work" (`failed`), because the first may revoke a verified domain and the
 *   second must never;
 * - answers are normalised and capped before anyone reads them.
 *
 * Nothing here opens a connection to the name being looked up; that is
 * {@link ./resolve-host.js resolvePublicHost}'s job, with its range checks.
 */
import { Resolver } from 'node:dns/promises';

export type DnsAnswer =
  | { readonly status: 'found'; readonly records: readonly string[] }
  | { readonly status: 'absent' }
  | { readonly status: 'failed'; readonly code: string };

export interface DnsResolver {
  /** CNAME targets, lower-cased, without the trailing dot. */
  cname(hostname: string): Promise<DnsAnswer>;
  /** TXT records, each one's character strings joined, as RFC 7208 §3.3 reads them. */
  txt(hostname: string): Promise<DnsAnswer>;
  /** A and AAAA records together. */
  addresses(hostname: string): Promise<DnsAnswer>;
}

/** The subset of `dns.promises.Resolver` this module calls. A test passes a double. */
export interface DnsBackend {
  resolveCname(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface DnsResolverOptions {
  /** Per-query timeout in milliseconds. Default 5 000. */
  readonly timeoutMs?: number;
  /** Attempts per query before it fails. Default 2. */
  readonly tries?: number;
  /** Name servers to ask instead of the system's. */
  readonly servers?: readonly string[];
  /** Replaces the Node resolver entirely; tests use it. */
  readonly backend?: DnsBackend;
}

export const DEFAULT_DNS_TIMEOUT_MS = 5_000;
export const DEFAULT_DNS_TRIES = 2;

/** More records than any honest name publishes; the rest are ignored. */
export const MAX_DNS_RECORDS = 50;
/** Longer than any verification token; a longer TXT record is cut here. */
export const MAX_TXT_LENGTH = 1_024;

/**
 * The resolver codes that mean the name answered and has no such record.
 * `ENOTFOUND` is NXDOMAIN, `ENODATA` is "the name exists, the type does not".
 * Everything else — `ETIMEOUT`, `ESERVFAIL`, `ECONNREFUSED`, `EREFUSED` — is the
 * lookup failing, which says nothing about the records.
 */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
};

const normaliseName = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

const settle = async (query: () => Promise<readonly string[]>): Promise<DnsAnswer> => {
  try {
    const records = (await query()).slice(0, MAX_DNS_RECORDS);
    return records.length === 0 ? { status: 'absent' } : { status: 'found', records };
  } catch (error) {
    const code = codeOf(error);
    return ABSENT_CODES.has(code) ? { status: 'absent' } : { status: 'failed', code };
  }
};

/** Combines the A and AAAA answers: found if either found anything, failed only if nothing was found and one failed. */
const combine = (first: DnsAnswer, second: DnsAnswer): DnsAnswer => {
  const records = [
    ...(first.status === 'found' ? first.records : []),
    ...(second.status === 'found' ? second.records : []),
  ];
  if (records.length > 0) {
    return { status: 'found', records: records.slice(0, MAX_DNS_RECORDS) };
  }
  if (first.status === 'failed') {
    return first;
  }
  return second.status === 'failed' ? second : { status: 'absent' };
};

const nodeBackend = (options: DnsResolverOptions): DnsBackend => {
  const resolver = new Resolver({
    timeout: options.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    tries: options.tries ?? DEFAULT_DNS_TRIES,
  });
  if (options.servers !== undefined && options.servers.length > 0) {
    resolver.setServers([...options.servers]);
  }
  return resolver;
};

export function createDnsResolver(options: DnsResolverOptions = {}): DnsResolver {
  const backend = options.backend ?? nodeBackend(options);

  return {
    cname: (hostname) =>
      settle(async () => (await backend.resolveCname(hostname)).map(normaliseName)),
    txt: (hostname) =>
      settle(async () =>
        (await backend.resolveTxt(hostname)).map((chunks) =>
          chunks.join('').slice(0, MAX_TXT_LENGTH),
        ),
      ),
    addresses: async (hostname) => {
      const [v4, v6] = await Promise.all([
        settle(() => backend.resolve4(hostname)),
        settle(() => backend.resolve6(hostname)),
      ]);
      return combine(v4, v6);
    },
  };
}
