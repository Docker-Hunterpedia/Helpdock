import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { isUuid, uuidv7 } from '../uuid.js';
import { brandStatusEnum, localeEnum } from './enums.js';

/**
 * A brand is the tenant. The table is global: rows are managed by install-admin
 * paths, and every other tenant table points back here through `brand_id`.
 *
 * Inserting a row also creates that brand's ticket sequence, through the
 * `brands_create_ticket_sequence` trigger installed by the migration. `prefix`
 * is never reused, because the ticket numbers of a deleted brand must stay
 * unambiguous (DOMAIN-RULES §11).
 */
export const brands = pgTable('brands', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text('name').notNull(),
  /** Short code in front of every ticket number, for example `ACME-1042`. */
  prefix: text('prefix').notNull().unique(),
  defaultLocale: localeEnum('default_locale').notNull().default('en'),
  /** IANA zone used for business hours and SLA clocks (DOMAIN-RULES §3). */
  timezone: text('timezone').notNull().default('UTC'),
  status: brandStatusEnum('status').notNull().default('active'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;

/**
 * Name of the sequence that issues ticket numbers for a brand. One sequence per
 * brand keeps numbers dense and per-brand, and keeps two brands from contending
 * on a shared counter (ARCHITECTURE §5). The name goes into SQL as an
 * identifier, so a value that is not a UUID is refused rather than quoted.
 */
export const brandTicketSequenceName = (brandId: string): string => {
  if (!isUuid(brandId)) {
    throw new TypeError('brandTicketSequenceName expects a UUID brand id');
  }
  return `brand_ticket_seq_${brandId.replaceAll('-', '')}`;
};
