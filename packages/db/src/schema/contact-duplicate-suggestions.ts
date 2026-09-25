import { pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';
import { contactDuplicateReasonEnum, contactDuplicateStatusEnum } from './enums.js';

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
 * `reason` is the identifier kind that matched ("same phone"), or, from M1-13,
 * `similar_name`: two contacts under one account whose names read alike. The
 * contact screen turns it into the pill on the suggestion.
 *
 * `status` becomes `merged` when an agent merges the pair (M1-13) and goes back
 * to `open` if that merge is undone; `dismissed` ("Not the same") is permanent
 * for the pair.
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
    reason: contactDuplicateReasonEnum('reason').notNull(),
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
