import { sql } from 'drizzle-orm';
import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { brandDomainKindEnum } from './enums.js';

/**
 * Why a help center domain is not serving (M5-07). The Domains tab picks its
 * sentence from the code and shows `failure_detail` — what DNS or the TLS
 * handshake actually said — beside it.
 *
 * - `cname_mismatch`: the name has a CNAME, pointing somewhere else.
 * - `cloudflare_not_flagged`: the name resolves to Cloudflare's edge, but the
 *   domain is not marked "proxied by Cloudflare", so no certificate can be
 *   issued here.
 * - `certificate_failed`: DNS is verified, and a TLS handshake to the name
 *   did not end with a certificate a browser would accept.
 * - `records_removed`: a verified domain's TXT record is gone, so it was
 *   un-verified.
 */
export const brandDomainFailureEnum = pgEnum('brand_domain_failure', [
  'cname_mismatch',
  'cloudflare_not_flagged',
  'certificate_failed',
  'records_removed',
]);

/**
 * The hostnames a brand owns (ARCHITECTURE §5). Two kinds live here: a
 * `helpcenter` host Caddy serves the brand's help center on, and a
 * `widget_origin` the widget's origin allow-list checks.
 *
 * Caddy asks `GET /internal/domain-check` before it issues a certificate for
 * an unknown host, and the api answers 200 only for a `helpcenter` row whose
 * `verified_at` is set and which is not proxied by Cloudflare (ARCHITECTURE §3).
 * M5-07 adds the rest: the Domains tab creates rows and publishes the CNAME and
 * TXT records an operator has to add, and the `domains` queue checks DNS,
 * stamps `verified_at` once `txt_token` and the CNAME have been observed, and
 * probes TLS. The columns below the M0 ones are that check's state; they mean
 * nothing on a `widget_origin` row.
 *
 * Tenant table: row-level security restricts it to the brands in
 * `app.brand_ids`. `domain` is unique across the install, because a hostname
 * resolves to exactly one brand.
 */
export const brandDomains = pgTable(
  'brand_domains',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Lower-case hostname with no trailing dot; punycode for non-ASCII labels. */
    domain: text('domain').notNull().unique(),
    kind: brandDomainKindEnum('kind').notNull(),
    /** Null until DNS verification succeeds. Until then the domain gets no certificate. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** The value an operator publishes as a TXT record, which the check looks for. */
    txtToken: text('txt_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The one host the help center's links, sitemap and canonical tags use.
     * At most one per brand (the partial unique index below), and only ever a
     * verified one: the service refuses the rest.
     */
    isPrimary: boolean('is_primary').notNull().default(false),
    /**
     * Cloudflare terminates TLS for this host, so Caddy must not try to
     * issue a certificate for it: `/internal/domain-check` refuses it, and the
     * check skips the TLS probe. Set by the Admin on the Domains tab.
     */
    cloudflareProxied: boolean('cloudflare_proxied').notNull().default(false),
    /** When the last check saw the CNAME (or the name pointing at this install). Null: not seen. */
    cnameSeenAt: timestamp('cname_seen_at', { withTimezone: true }),
    /** When the last check saw the TXT record with `txt_token`. Null: not seen. */
    txtSeenAt: timestamp('txt_seen_at', { withTimezone: true }),
    /** When a TLS handshake first saw a valid certificate for the name. */
    tlsIssuedAt: timestamp('tls_issued_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /**
     * When somebody last asked for a check ("Add", "Check now", the Cloudflare
     * flag). A second press inside a few seconds is not queued again.
     */
    checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
    failureReason: brandDomainFailureEnum('failure_reason'),
    /** What DNS or the handshake said, for the reason above: an address, a CNAME target, a TLS code. */
    failureDetail: text('failure_detail'),
  },
  (table) => [
    uniqueIndex('brand_domains_one_primary_idx').on(table.brandId).where(sql`${table.isPrimary}`),
  ],
);

export type BrandDomain = typeof brandDomains.$inferSelect;
export type NewBrandDomain = typeof brandDomains.$inferInsert;
export type BrandDomainFailure = (typeof brandDomainFailureEnum.enumValues)[number];
