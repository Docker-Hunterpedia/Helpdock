/**
 * Whether a name a person typed can be a public DNS hostname at all.
 *
 * A brand Admin adding a custom help center domain (M5-07) types a hostname
 * that the worker then resolves over and over and connects to on port 443. The
 * address check in {@link ./resolve-host.js resolvePublicHost} stops the
 * connection from reaching the install's own network, but a name that can
 * never be public — `localhost`, `db.internal`, `10.0.0.5`, `printer.local` —
 * should not get that far: it is refused when it is typed, with a reason the
 * form can show.
 */
import { isIpLiteral } from './ip-address.js';

/** 253 characters is the longest name DNS can carry in presentation form. */
export const MAX_HOSTNAME_LENGTH = 253;

/**
 * Letters, digits and hyphens, one to 63 of them, no hyphen at either end.
 * Punycode (`xn--…`) passes as ASCII; a Unicode label does not, and the caller
 * converts with `domainToASCII` first if it wants to accept one.
 */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A top-level label is alphabetic or punycode: an all-digit one would make `10.0.0.5` a name. */
const TOP_LEVEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Suffixes that are never delegated in public DNS: the special-use names of
 * RFC 6761 and RFC 6762, `home.arpa` (RFC 8375), `.internal` (reserved by ICANN
 * for private use in 2024) and the ones home and corporate networks commonly
 * squat on. `.test` and `.example` are in the list because no certificate
 * authority will issue for them, so verifying one could only ever fail.
 */
const NON_PUBLIC_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'invalid',
  'test',
  'example',
  'onion',
  'arpa',
];

export type HostnameProblem = 'empty' | 'too-long' | 'ip-address' | 'malformed' | 'not-public';

export type PublicHostnameResult =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly problem: HostnameProblem };

/**
 * Normalises `input` — trims it, lower-cases it, drops one trailing dot — and
 * says whether the result can be a public hostname. It does not resolve
 * anything: a name that passes may still not exist.
 */
export function parsePublicHostname(input: string): PublicHostnameResult {
  const hostname = input.trim().toLowerCase().replace(/\.$/, '');
  if (hostname === '') {
    return { ok: false, problem: 'empty' };
  }
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, problem: 'too-long' };
  }
  if (isIpLiteral(hostname) || isIpLiteral(hostname.replace(/^\[|\]$/g, ''))) {
    return { ok: false, problem: 'ip-address' };
  }

  const labels = hostname.split('.');
  const topLevel = labels.at(-1) ?? '';
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { ok: false, problem: 'malformed' };
  }
  if (!TOP_LEVEL.test(topLevel)) {
    return { ok: false, problem: 'malformed' };
  }
  if (NON_PUBLIC_SUFFIXES.includes(topLevel)) {
    return { ok: false, problem: 'not-public' };
  }

  return { ok: true, hostname };
}
