import { boolean, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';
import { contactIdentityKindEnum } from './enums.js';

/**
 * One way of recognising a contact: an address, a phone number, a Telegram chat
 * id, a widget visitor id, or the brand's own user id.
 *
 * **`value` is always normalised** before it arrives here — lower-cased email,
 * E.164 phone, the chat id as digits — because the unique index below is the
 * whole mechanism: two spellings of one address have to collide, or the same
 * person becomes two contacts. `packages/schemas/src/contact.ts` is the one
 * place that decides what normalised means.
 *
 * **`verified` is the difference between a hint and a fact** (DOMAIN-RULES
 * §4.4). An address an inbound email came from is verified and may be matched
 * on; an address somebody typed into a pre-chat form is not, and produces a
 * duplicate suggestion instead of a match. The flag is per identifier, not per
 * contact, because one person holds both kinds at once.
 *
 * Unique per `(brand_id, kind, value)`: one identifier belongs to one contact
 * inside a brand, and the same address may belong to a different person in
 * another brand of the same deploy.
 */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: contactIdentityKindEnum('kind').notNull(),
    value: text('value').notNull(),
    verified: boolean('verified').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** What established it: `email.inbound`, `widget.form`, `agent`, `import`. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('contact_identities_brand_kind_value_key').on(table.brandId, table.kind, table.value),
    index('contact_identities_contact_idx').on(table.contactId),
  ],
);

export type ContactIdentity = typeof contactIdentities.$inferSelect;
export type NewContactIdentity = typeof contactIdentities.$inferInsert;
