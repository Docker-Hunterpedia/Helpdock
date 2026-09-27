import { z } from 'zod';

/**
 * Custom help center domains (M5-07, ARCHITECTURE §3 and §11): the Brand ›
 * Domains tab and the api behind it.
 *
 * A domain goes live in three steps. The Admin adds it and is shown two
 * records to publish: a CNAME pointing the name at this install, and a TXT
 * record under `_helpdock.<domain>` carrying a token only this row knows. The
 * worker checks DNS until it sees both, then marks the domain verified, and
 * Caddy's on-demand TLS may issue a certificate for it. Behind Cloudflare's
 * proxy, the Admin ticks "Proxied by Cloudflare" and Cloudflare serves HTTPS
 * instead.
 */

/** The label the TXT record lives under: `_helpdock.support.example.com`. */
export const DOMAIN_TXT_LABEL = '_helpdock';
/** What the TXT record's value starts with, before the row's token. */
export const DOMAIN_TXT_VALUE_PREFIX = 'helpdock-verify=';
/** Help center domains per brand. Every one is re-checked on a schedule, so the count is bounded. */
export const MAX_HELPCENTER_DOMAINS = 10;
/** 253 characters is the longest name DNS can carry. */
export const MAX_DOMAIN_LENGTH = 253;

export const txtRecordNameFor = (domain: string): string => `${DOMAIN_TXT_LABEL}.${domain}`;
export const txtRecordValueFor = (token: string): string => `${DOMAIN_TXT_VALUE_PREFIX}${token}`;

/**
 * `pending`: a record is missing or not seen yet. `verified`: DNS checks out
 * and, unless Cloudflare proxies it, HTTPS works or is about to. `failed`: the
 * reason is in `failure`.
 */
export const customDomainStateSchema = z.enum(['pending', 'verified', 'failed']);
export type CustomDomainState = z.infer<typeof customDomainStateSchema>;

/**
 * How HTTPS is served for a verified domain. `issued`: a handshake saw a valid
 * certificate. `pending`: none seen yet — Caddy issues on the first visit.
 * `cloudflare`: Cloudflare terminates TLS, so this install issues nothing.
 */
export const customDomainTlsSchema = z.enum(['issued', 'pending', 'cloudflare']);
export type CustomDomainTls = z.infer<typeof customDomainTlsSchema>;

/** The codes of `brand_domain_failure`; see `packages/db/src/schema/brand-domains.ts`. */
export const customDomainFailureSchema = z.enum([
  'cname_mismatch',
  'cloudflare_not_flagged',
  'certificate_failed',
  'records_removed',
]);
export type CustomDomainFailure = z.infer<typeof customDomainFailureSchema>;

export const dnsRecordSchema = z.object({
  type: z.enum(['CNAME', 'TXT']),
  name: z.string(),
  value: z.string(),
  /** Whether the last check saw it. */
  seen: z.boolean(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

export const customDomainSchema = z.object({
  id: z.uuid(),
  domain: z.string(),
  primary: z.boolean(),
  cloudflareProxied: z.boolean(),
  state: customDomainStateSchema,
  /** Null until the domain is verified. */
  tls: customDomainTlsSchema.nullable(),
  records: z.object({ cname: dnsRecordSchema, txt: dnsRecordSchema }),
  failure: z
    .object({ reason: customDomainFailureSchema, detail: z.string().nullable() })
    .nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  tlsIssuedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CustomDomain = z.infer<typeof customDomainSchema>;

export const customDomainListSchema = z.object({
  /** Where every CNAME points: a hostname that already reaches this install. */
  cnameTarget: z.string(),
  domains: z.array(customDomainSchema),
});
export type CustomDomainList = z.infer<typeof customDomainListSchema>;

/**
 * "Add domain". Only the shape is checked here; whether the name can be public
 * at all is the api's call (`@helpdock/net`'s `parsePublicHostname`), after it
 * has converted a Unicode name to punycode.
 */
export const customDomainCreateRequestSchema = z.object({
  domain: z.string().trim().min(1).max(MAX_DOMAIN_LENGTH),
});
export type CustomDomainCreateRequest = z.infer<typeof customDomainCreateRequestSchema>;

/**
 * The Cloudflare checkbox and "Make primary". Primary can only be moved *to* a
 * domain, never cleared, so a brand with a verified domain always has one.
 */
export const customDomainUpdateRequestSchema = z
  .object({
    cloudflareProxied: z.boolean().optional(),
    primary: z.literal(true).optional(),
  })
  .refine(
    (value) => value.cloudflareProxied !== undefined || value.primary !== undefined,
    'Send at least one field to change',
  );
export type CustomDomainUpdateRequest = z.infer<typeof customDomainUpdateRequestSchema>;

export const customDomainParamSchema = z.object({ brandId: z.uuid(), domainId: z.uuid() });
export type CustomDomainParam = z.infer<typeof customDomainParamSchema>;

export const domainsRefusalSchema = z.enum([
  /** Not a hostname: a URL, an IP address, a single label, a stray character. */
  'domain-invalid',
  /** A name that can never be public: `.local`, `.internal`, `.test` and the like. */
  'domain-not-public',
  /** One of the install's own hosts, which must never be routed to a brand. */
  'domain-reserved',
  /** Another brand, or this one, already has it. */
  'domain-taken',
  /** {@link MAX_HELPCENTER_DOMAINS} reached. */
  'domain-limit',
  /** "Make primary" on a domain that is not verified. */
  'domain-not-verified',
]);
export type DomainsRefusal = z.infer<typeof domainsRefusalSchema>;
