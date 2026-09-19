import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { brandDomainKindEnum } from './enums.js';

/**
 * The hostnames a brand owns (ARCHITECTURE §5). Two kinds live here: a
 * `helpcenter` host Caddy serves the brand's help center on, and a
 * `widget_origin` the widget's origin allow-list checks.
 *
 * M0 needs the table and one reader: Caddy asks `GET /internal/domain-check`
 * before it issues a certificate for an unknown host, and the api answers 200
 * only for a `helpcenter` row whose `verified_at` is set (ARCHITECTURE §3). M5
 * owns the rest — creating rows, publishing the CNAME and TXT records an
 * operator has to add, and stamping `verified_at` once `txt_token` has been
 * observed in DNS.
 *
 * Tenant table: row-level security restricts it to the brands in
 * `app.brand_ids`. `domain` is unique across the install, because a hostname
 * resolves to exactly one brand.
 */
export const brandDomains = pgTable('brand_domains', {
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
  /** The value an operator publishes as a TXT record, which M5 checks for. */
  txtToken: text('txt_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BrandDomain = typeof brandDomains.$inferSelect;
export type NewBrandDomain = typeof brandDomains.$inferInsert;
