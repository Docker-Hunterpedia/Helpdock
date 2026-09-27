import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';

/**
 * A widget visitor (DOMAIN-RULES §4.1): the server-issued `visitor_id` and the
 * hash of its `visitor_secret`, the only credential an anonymous visitor has.
 *
 * **The secret is never stored**, only `sha256(secret)` as lower-case hex. The
 * secret is 256 random bits, so a plain digest is enough: there is nothing to
 * guess, and a stolen table is a list of hashes of random numbers. Lookup is
 * by the hash, which is why it is unique.
 *
 * `contact_id` is the contact the visitor's conversations are filed under,
 * created on their first message rather than on first load, so a page view is
 * not a contact. `verified_contact_id` is set only while the host site vouches
 * for the visitor with a valid signed identity (§4.2): every session call
 * rewrites it, so signing out on the site signs the widget out of the
 * verified contact's history on the next page load.
 *
 * Brand-scoped: a visitor exists in one brand, and a department never owns one.
 */
export const widgetVisitors = pgTable(
  'widget_visitors',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    secretHash: text('secret_hash').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    verifiedContactId: uuid('verified_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('widget_visitors_secret_hash_key').on(table.secretHash),
    // Retention sweeps visitors nobody has seen in a while (DOMAIN-RULES §11).
    index('widget_visitors_brand_last_seen_idx').on(table.brandId, table.lastSeenAt),
  ],
);

export type WidgetVisitor = typeof widgetVisitors.$inferSelect;
export type NewWidgetVisitor = typeof widgetVisitors.$inferInsert;
