/**
 * `@helpdock/net` — the SSRF-safe outbound HTTP client (DOMAIN-RULES §13).
 *
 * Every Helpdock feature that fetches a user-supplied URL — the crawler, webhook
 * delivery, the remote-image proxy and the Notion and Google Drive connectors —
 * goes through {@link safeFetch}. Nothing calls global `fetch` on user input.
 *
 * The range checks, the URL policy and the resolver live behind `safeFetch`
 * rather than beside it: a caller that could reach them separately could also
 * apply them inconsistently.
 */
export type { SafeFetchErrorCode, SafeFetchErrorDetails } from './errors.js';
export { SafeFetchError } from './errors.js';
export type { BlockedEvent, LookupAddress, LookupFunction, SafeFetchPolicy } from './policy.js';
export { policies } from './policy.js';
export type { ResponseHeaders } from './request.js';
export type { SafeFetchInit, SafeFetchResponse } from './safe-fetch.js';
export { safeFetch } from './safe-fetch.js';
