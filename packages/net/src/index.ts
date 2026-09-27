/**
 * `@helpdock/net` — the SSRF-safe outbound HTTP client (DOMAIN-RULES §13).
 *
 * Every Helpdock feature that fetches a user-supplied URL — the crawler, webhook
 * delivery, the remote-image proxy and the Notion and Google Drive connectors —
 * goes through {@link safeFetch}. Nothing calls global `fetch` on user input.
 *
 * The range checks, the URL policy and the resolver live behind `safeFetch`
 * rather than beside it: a caller that could reach them separately could also
 * apply them inconsistently. The custom-domain checks of M5-07 add three
 * helpers that never connect anywhere the range checks have not approved: a
 * public-hostname validator, a DNS record reader with deadlines, and a
 * one-handshake TLS probe that goes through `resolvePublicHost`.
 */
export type { DnsAnswer, DnsBackend, DnsResolver, DnsResolverOptions } from './dns.js';
export { createDnsResolver } from './dns.js';
export type { SafeFetchErrorCode, SafeFetchErrorDetails } from './errors.js';
export { SafeFetchError } from './errors.js';
export type { HostnameProblem, PublicHostnameResult } from './hostname.js';
export { parsePublicHostname } from './hostname.js';
export { addressInCidrs } from './ip-address.js';
export type { BlockedEvent, LookupAddress, LookupFunction, SafeFetchPolicy } from './policy.js';
export { policies } from './policy.js';
export type { ResponseHeaders } from './request.js';
export type { ResolvedHost, ResolveHostPolicy } from './resolve-host.js';
export { resolvePublicHost } from './resolve-host.js';
export type { SafeFetchInit, SafeFetchResponse } from './safe-fetch.js';
export { safeFetch } from './safe-fetch.js';
export type { ProbeSocket, TlsProbeOptions, TlsProbeResult } from './tls-probe.js';
export { probeTls } from './tls-probe.js';
