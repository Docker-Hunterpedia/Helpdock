import type { Env } from '@helpdock/config';
import { createDnsResolver, probeTls } from '@helpdock/net';
import type { DomainProbes } from './domain-verifier.js';

/**
 * The install-level facts M5-07 reads from the environment, in one place so
 * the api (the Domains tab, host routing) and the worker (the check) agree.
 */

type DomainEnv = Pick<Env, 'APP_URL' | 'HELPCENTER_CNAME_TARGET'>;

/** Where a brand's CNAME points: `HELPCENTER_CNAME_TARGET`, or the host of `APP_URL`. */
export const cnameTargetOf = (env: DomainEnv): string =>
  env.HELPCENTER_CNAME_TARGET ?? new URL(env.APP_URL).hostname;

/** Hosts that belong to the install itself, which no brand may claim and routing never looks up. */
export const ownHostsOf = (env: DomainEnv): readonly string[] => [
  ...new Set([new URL(env.APP_URL).hostname, cnameTargetOf(env)]),
];

/**
 * The real lookups: the system resolver with a five-second deadline, and a TLS
 * handshake through the SSRF-safe resolver. `OUTBOUND_ALLOW_CIDRS` applies, so
 * an install whose help center is only reachable on a private address can still
 * be probed when the operator says so (DOMAIN-RULES §13).
 */
export const createDomainProbes = (options: {
  readonly allowCidrs: readonly string[];
  readonly onBlocked: (event: { host: string | undefined; address: string | undefined }) => void;
}): DomainProbes => ({
  dns: createDnsResolver(),
  tls: (hostname) =>
    probeTls(hostname, { allowCidrs: options.allowCidrs, onBlocked: options.onBlocked }),
});
