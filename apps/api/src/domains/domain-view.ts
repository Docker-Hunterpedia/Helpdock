import type { BrandDomain } from '@helpdock/db';
import {
  type CustomDomain,
  type CustomDomainState,
  type CustomDomainTls,
  txtRecordNameFor,
  txtRecordValueFor,
} from '@helpdock/schemas';

/**
 * A `brand_domains` row as the Domains tab reads it. The state is derived
 * rather than stored, so there is no status column to drift from the facts:
 *
 * - a recorded failure is `failed`, whether or not DNS is verified — the
 *   artboard's "Certificate failed" is a verified domain that is not serving;
 * - otherwise a verified domain is `verified`, and its `tls` says how HTTPS is
 *   served;
 * - anything else is `pending`.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const stateOf = (row: BrandDomain): CustomDomainState => {
  if (row.failureReason !== null) {
    return 'failed';
  }
  return row.verifiedAt === null ? 'pending' : 'verified';
};

const tlsOf = (row: BrandDomain): CustomDomainTls | null => {
  if (row.verifiedAt === null) {
    return null;
  }
  if (row.cloudflareProxied) {
    return 'cloudflare';
  }
  return row.tlsIssuedAt === null ? 'pending' : 'issued';
};

export const toCustomDomain = (row: BrandDomain, cnameTarget: string): CustomDomain => ({
  id: row.id,
  domain: row.domain,
  primary: row.isPrimary,
  cloudflareProxied: row.cloudflareProxied,
  state: stateOf(row),
  tls: tlsOf(row),
  records: {
    cname: { type: 'CNAME', name: row.domain, value: cnameTarget, seen: row.cnameSeenAt !== null },
    txt: {
      type: 'TXT',
      name: txtRecordNameFor(row.domain),
      value: txtRecordValueFor(row.txtToken),
      seen: row.txtSeenAt !== null,
    },
  },
  failure:
    row.failureReason === null ? null : { reason: row.failureReason, detail: row.failureDetail },
  verifiedAt: iso(row.verifiedAt),
  tlsIssuedAt: iso(row.tlsIssuedAt),
  lastCheckedAt: iso(row.lastCheckedAt),
  createdAt: row.createdAt.toISOString(),
});
