import { pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';
import { contactDuplicateStatusEnum, contactIdentityKindEnum } from './enums.js';

/**
 * "These two might be the same person." Written whenever an **unverified**
 * identifier lands on a new contact while another contact in the brand already
 * holds that exact value (DOMAIN-RULES §4.4): the match is a hint, so it may
 * not merge anything, and an agent decides.
 *
 * `contact_id` is the newcomer and `other_contact_id` the contact that was
 * already there, so the suggestion reads in the direction it was discovered.
 * The pair is unique, because the third pre-chat form from the same typed
 * address is not a third opinion.
 *
 * `reason` is the identifier kind that matched, which is also the sentence the
 * contact screen prints ("same email"). A wider vocabulary would be a second
 * enum to keep in step with nothing.
 *
 * Merging itself — and the 24-hour undo — is M1-13. This table and the
 * dismissal ("Not the same") are what M1-04 ships.
 */
export const contactDuplicateSuggestions = pgTable(
  'contact_duplicate_suggestions',
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
    otherContactId: uuid('other_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    reason: contactIdentityKindEnum('reason').notNull(),
    status: contactDuplicateStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('contact_duplicate_suggestions_pair_key').on(
      table.brandId,
      table.contactId,
      table.otherContactId,
    ),
  ],
);

export type ContactDuplicateSuggestion = typeof contactDuplicateSuggestions.$inferSelect;
export type NewContactDuplicateSuggestion = typeof contactDuplicateSuggestions.$inferInsert;
