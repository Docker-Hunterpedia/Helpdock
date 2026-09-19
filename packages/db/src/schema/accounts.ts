import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';

/**
 * The customer company a contact belongs to (REQUIREMENTS §4.1). Brand-scoped,
 * never department-scoped: DOMAIN-RULES §1.2 puts contacts and accounts outside
 * the department walls, and it is the *timeline* that hides what the viewer may
 * not read.
 *
 * `domain` is the email domain that marks a person as working here. It is
 * unique per brand rather than per install, because two brands of one deploy
 * may both sell to `acme.example` and are not allowed to see each other's
 * customers. It is nullable: an account created by hand from a phone call has
 * no domain, and several such accounts must be able to coexist — Postgres
 * treats nulls as distinct in a unique index, which is exactly the behaviour
 * wanted here.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Lower-cased email domain, for example `acme.example`. */
    domain: text('domain'),
    /** Values of the account custom fields M1-06 defines. */
    custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique('accounts_brand_domain_key').on(table.brandId, table.domain)],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
