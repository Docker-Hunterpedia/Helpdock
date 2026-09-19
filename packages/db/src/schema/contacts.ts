import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { accounts } from './accounts.js';
import { brands } from './brands.js';
import { localeEnum } from './enums.js';

/**
 * A person, as one brand knows them (REQUIREMENTS §4.1). One row carries every
 * channel they have written from; the addresses and ids themselves live in
 * `contact_identities`, so somebody with two verified addresses is one contact
 * rather than two rows that happen to agree.
 *
 * Brand-scoped, not department-scoped (DOMAIN-RULES §1.2). An Agent may open
 * any contact in the brand; what they may not see is the tickets, and the
 * timeline counts those instead of pretending they do not exist.
 *
 * `locale` and `timezone` are nullable because "we have not been told" is a
 * different fact from "English, UTC": a null falls back to the brand's
 * `default_locale` and `timezone` when a reply is composed.
 *
 * `external_id` is the brand's own customer id — the "Customer id" on the
 * contact screen — and is a label, not a credential. When a signed identity
 * proves it (DOMAIN-RULES §4.2) the same value is also written as a
 * `contact_identities` row of kind `external`, and *that* row is what carries
 * the `verified` flag.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Null until somebody files them under a company. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    locale: localeEnum('locale'),
    /** IANA zone, for example `Europe/Berlin`. */
    timezone: text('timezone'),
    externalId: text('external_id'),
    /** Values of the contact custom fields M1-06 defines. */
    custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * Denormalised count of `contact_notes`, written in the same transaction as
     * the note. The list draws it per row, and a correlated count per row is
     * the query that gets slow first.
     */
    notesCount: integer('notes_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Set by the erasure of DOMAIN-RULES §11. The row stays; the person goes. */
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
  },
  (table) => [
    // The list is "this brand's people, most recently touched first", and the
    // account filter narrows the same scan.
    index('contacts_brand_updated_at_idx').on(table.brandId, table.updatedAt),
    index('contacts_brand_account_idx').on(table.brandId, table.accountId),
  ],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
