import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';

/**
 * A note an agent leaves on a person rather than on a ticket: "prefers Arabic",
 * "escalate anything about billing". It is staff-only by construction — nothing
 * visitor-facing reads this table — and it survives the tickets it was written
 * beside.
 *
 * `author_id` has no foreign key to `users`, for the reason `audit_log.actor_id`
 * has none: a note outlives the account that wrote it, and staff deletion
 * anonymises the account rather than removing the row (DOMAIN-RULES §12), so
 * the id keeps resolving to "who that was" without the table having to care.
 *
 * `body_text` is plain text. Rich text on a contact note would be a second
 * sanitiser to maintain for a field nobody formats.
 */
export const contactNotes = pgTable(
  'contact_notes',
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
    authorId: uuid('author_id').notNull(),
    bodyText: text('body_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The timeline reads one contact's notes newest first, interleaved with its
  // tickets.
  (table) => [index('contact_notes_contact_created_at_idx').on(table.contactId, table.createdAt)],
);

export type ContactNote = typeof contactNotes.$inferSelect;
export type NewContactNote = typeof contactNotes.$inferInsert;
