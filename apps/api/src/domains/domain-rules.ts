import type { BrandDomain, BrandDomainFailure } from '@helpdock/db';
import { addressInCidrs, type DnsAnswer, type TlsProbeResult } from '@helpdock/net';
import { txtRecordValueFor } from '@helpdock/schemas';

/**
 * The decisions of a custom-domain check (M5-07), as pure functions: what DNS
 * said, what that makes the domain, and when it should be looked at again. The
 * verifier (`domain-verifier.ts`) does the lookups and writes the result; this
 * file is where "verified" is defined.
 *
 * A domain is **verified** when its TXT record carries the row's token — the
 * proof that whoever added it controls the zone — and the name reaches this
 * install: a CNAME to the target, or addresses shared with the target (an apex
 * domain cannot have a CNAME), or Cloudflare's edge, because a proxied record is
 * flattened and its CNAME is invisible from outside.
 */

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). A name
 * that resolves into them is proxied, which is how the check can tell an Admin
 * who forgot the "Proxied by Cloudflare" box why no certificate was issued.
 * They change rarely; a stale list only makes that hint less precise, it
 * decides nothing about access.
 */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** What one check read from DNS. */
export interface DnsObservation {
  readonly cname: DnsAnswer;
  readonly txt: DnsAnswer;
  /** The A and AAAA records of the domain itself. */
  readonly addresses: DnsAnswer;
  /** The A and AAAA records of the CNAME target, to recognise an apex pointed by address. */
  readonly targetAddresses: DnsAnswer;
}

export interface DnsVerdict {
  /** A lookup that matters failed, so nothing may be concluded, least of all a revocation. */
  readonly inconclusive: boolean;
  readonly txtSeen: boolean;
  /** The name reaches this install by CNAME or by shared address. */
  readonly cnameSeen: boolean;
  /** The first Cloudflare edge address the name resolves to, when it reaches nothing else. */
  readonly cloudflareAddress: string | null;
  /** A CNAME that points somewhere else, when there is one. */
  readonly cnameElsewhere: string | null;
  /** TXT proves control and the name reaches this install (directly or through Cloudflare). */
  readonly verified: boolean;
}

const recordsOf = (answer: DnsAnswer): readonly string[] =>
  answer.status === 'found' ? answer.records : [];

export const evaluateDns = (
  observation: DnsObservation,
  expected: { readonly token: string; readonly cnameTarget: string },
): DnsVerdict => {
  const txtSeen = recordsOf(observation.txt).includes(txtRecordValueFor(expected.token));
  const cnames = recordsOf(observation.cname);
  const addresses = recordsOf(observation.addresses);
  const targetAddresses = new Set(recordsOf(observation.targetAddresses));

  const cnameSeen =
    cnames.includes(expected.cnameTarget) ||
    addresses.some((address) => targetAddresses.has(address));
  const cloudflareAddress = cnameSeen
    ? null
    : (addresses.find((address) => addressInCidrs(address, CLOUDFLARE_RANGES)) ?? null);
  const cnameElsewhere =
    cnameSeen || cloudflareAddress !== null
      ? null
      : (cnames.find((target) => target !== expected.cnameTarget) ?? null);

  const inconclusive =
    observation.txt.status === 'failed' ||
    (observation.cname.status === 'failed' && observation.addresses.status === 'failed');

  return {
    inconclusive,
    txtSeen,
    cnameSeen,
    cloudflareAddress,
    cnameElsewhere,
    verified: txtSeen && (cnameSeen || cloudflareAddress !== null),
  };
};

/** The columns a check writes. */
export type CheckUpdate = Pick<
  BrandDomain,
  | 'verifiedAt'
  | 'cnameSeenAt'
  | 'txtSeenAt'
  | 'tlsIssuedAt'
  | 'lastCheckedAt'
  | 'failureReason'
  | 'failureDetail'
>;

/** What changed that an audit row should say. */
export type CheckTransition = 'verified' | 'verification_lost' | null;

export interface CheckDecision {
  readonly update: CheckUpdate;
  readonly transition: CheckTransition;
  /** Whether the verifier should now run a TLS handshake and call {@link applyTls}. */
  readonly probeTls: boolean;
}

/** The longest failure detail kept: an address, a hostname or a TLS error code. */
const MAX_DETAIL = 253;

const failure = (
  reason: BrandDomainFailure,
  detail: string | null,
): Pick<CheckUpdate, 'failureReason' | 'failureDetail'> => ({
  failureReason: reason,
  failureDetail: detail === null ? null : detail.slice(0, MAX_DETAIL),
});

const NO_FAILURE = { failureReason: null, failureDetail: null } as const;

/**
 * The state a domain moves to after one DNS reading. TLS is a second step: when
 * `probeTls` is set, the verifier runs the handshake and folds its result in
 * with {@link applyTls}.
 *
 * - An **inconclusive** reading changes nothing but `last_checked_at`: a DNS
 *   timeout must never un-verify a help center that is serving.
 * - A **verified** domain whose TXT record is definitively gone is un-verified
 *   (`records_removed`): the proof of control is what the certificate rests on.
 * - An **unverified** domain becomes verified once {@link DnsVerdict.verified}.
 */
export const decideCheck = (
  row: Pick<
    BrandDomain,
    'verifiedAt' | 'cnameSeenAt' | 'txtSeenAt' | 'tlsIssuedAt' | 'cloudflareProxied'
  > &
    Pick<CheckUpdate, 'failureReason' | 'failureDetail'>,
  verdict: DnsVerdict,
  now: Date,
): CheckDecision => {
  const unchanged: CheckUpdate = {
    verifiedAt: row.verifiedAt,
    cnameSeenAt: row.cnameSeenAt,
    txtSeenAt: row.txtSeenAt,
    tlsIssuedAt: row.tlsIssuedAt,
    lastCheckedAt: now,
    failureReason: row.failureReason,
    failureDetail: row.failureDetail,
  };
  if (verdict.inconclusive) {
    return { update: unchanged, transition: null, probeTls: false };
  }

  const seen = {
    cnameSeenAt: verdict.cnameSeen ? now : null,
    txtSeenAt: verdict.txtSeen ? now : null,
    lastCheckedAt: now,
  };

  if (row.verifiedAt !== null && !verdict.txtSeen) {
    return {
      update: {
        ...seen,
        verifiedAt: null,
        tlsIssuedAt: null,
        ...failure('records_removed', null),
      },
      transition: 'verification_lost',
      probeTls: false,
    };
  }

  const verifiedAt = row.verifiedAt ?? (verdict.verified ? now : null);
  const transition: CheckTransition =
    row.verifiedAt === null && verifiedAt !== null ? 'verified' : null;

  if (verifiedAt === null) {
    return {
      update: {
        ...seen,
        verifiedAt: null,
        tlsIssuedAt: null,
        ...(verdict.cnameElsewhere === null
          ? NO_FAILURE
          : failure('cname_mismatch', verdict.cnameElsewhere)),
      },
      transition,
      probeTls: false,
    };
  }

  const base = { ...seen, verifiedAt, tlsIssuedAt: row.tlsIssuedAt };
  if (row.cloudflareProxied) {
    return { update: { ...base, ...NO_FAILURE }, transition, probeTls: false };
  }
  if (verdict.cloudflareAddress !== null) {
    return {
      update: { ...base, ...failure('cloudflare_not_flagged', verdict.cloudflareAddress) },
      transition,
      probeTls: false,
    };
  }

  return { update: { ...base, ...NO_FAILURE }, transition, probeTls: true };
};

/** Folds a TLS handshake's outcome into a decision that asked for one. */
export const applyTls = (update: CheckUpdate, result: TlsProbeResult, now: Date): CheckUpdate =>
  result.status === 'valid'
    ? { ...update, tlsIssuedAt: update.tlsIssuedAt ?? now, ...NO_FAILURE }
    : { ...update, ...failure('certificate_failed', result.code) };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long after it is added a pending domain is checked at the fast cadence. */
export const FAST_CHECK_WINDOW_MS = 48 * HOUR;
export const CHECK_INTERVALS_MS = {
  /** Pending, in its first two days: DNS changes usually show within minutes. */
  pendingFresh: 15 * MINUTE,
  /** Pending for longer than that: somebody forgot, and hammering their DNS will not help. */
  pendingStale: 6 * HOUR,
  /** Verified, but HTTPS is not confirmed yet or failed. */
  verifiedUnconfirmed: HOUR,
  /** Verified and serving: a daily look catches a removed record or a lapsed certificate. */
  verifiedHealthy: 24 * HOUR,
} as const;

/**
 * The schedule ticks every fifteen minutes and a tick is never exactly on time,
 * so a domain is due a minute early rather than one tick late.
 */
const SLACK_MS = MINUTE;

export const checkIntervalFor = (
  row: Pick<
    BrandDomain,
    'verifiedAt' | 'createdAt' | 'cloudflareProxied' | 'tlsIssuedAt' | 'failureReason'
  >,
  now: Date,
): number => {
  if (row.verifiedAt === null) {
    return now.getTime() - row.createdAt.getTime() < FAST_CHECK_WINDOW_MS
      ? CHECK_INTERVALS_MS.pendingFresh
      : CHECK_INTERVALS_MS.pendingStale;
  }
  const healthy = row.failureReason === null && (row.cloudflareProxied || row.tlsIssuedAt !== null);
  return healthy ? CHECK_INTERVALS_MS.verifiedHealthy : CHECK_INTERVALS_MS.verifiedUnconfirmed;
};

export const isCheckDue = (
  row: Pick<
    BrandDomain,
    | 'verifiedAt'
    | 'createdAt'
    | 'cloudflareProxied'
    | 'tlsIssuedAt'
    | 'failureReason'
    | 'lastCheckedAt'
  >,
  now: Date,
): boolean =>
  row.lastCheckedAt === null ||
  now.getTime() - row.lastCheckedAt.getTime() >= checkIntervalFor(row, now) - SLACK_MS;

/** A second "Check now" inside this window is answered but not queued again. */
export const CHECK_REQUEST_COOLDOWN_MS = 15_000;

export const mayRequestCheck = (row: Pick<BrandDomain, 'checkRequestedAt'>, now: Date): boolean =>
  row.checkRequestedAt === null ||
  now.getTime() - row.checkRequestedAt.getTime() >= CHECK_REQUEST_COOLDOWN_MS;
