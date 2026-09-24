import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contactDuplicateSuggestions } from './contact-duplicate-suggestions.js';
import { contacts } from './contacts.js';
import { users } from './users.js';

/**
 * One manual merge of two contacts, and everything needed to take it back
 * (DOMAIN-RULES §4.4: "a merge is recorded in the audit log and can be undone
 * for 24 hours").
 *
 * `survivor_id` keeps its own name and details; `merged_id` is the contact that
 * was folded into it and is left in place with `contacts.merged_into_id` set.
 * The three arrays are **exactly the rows the merge moved** — identifiers,
 * tickets and notes — so an undo moves those back and nothing else: a ticket
 * the survivor gained after the merge stays with the survivor.
 *
 * `moved_ticket_ids` includes tickets in departments the merging agent cannot
 * see (a contact's tickets move whole, DOMAIN-RULES §1.2), so it is never
 * returned to a client; the api reports how many and nothing more.
 *
 * Brand-scoped like every contact table, and never department-scoped.
 */
export const contactMerges = pgTable(
  'contact_merges',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    survivorId: uuid('survivor_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    mergedId: uuid('merged_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** The suggestion the merge was made from, if any; it goes back to `open` on undo. */
    suggestionId: uuid('suggestion_id').references(() => contactDuplicateSuggestions.id, {
      onDelete: 'set null',
    }),
    /** Null once the staff member is deleted; the audit log keeps the id. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    movedIdentityIds: uuid('moved_identity_ids').array().notNull().default(sql`'{}'::uuid[]`),
    movedTicketIds: uuid('moved_ticket_ids').array().notNull().default(sql`'{}'::uuid[]`),
    movedNoteIds: uuid('moved_note_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** `created_at` + 24 hours, stored so the rule is a comparison rather than arithmetic. */
    undoUntil: timestamp('undo_until', { withTimezone: true }).notNull(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    // "The merges into this contact that can still be undone": the banner.
    index('contact_merges_brand_survivor_idx').on(table.brandId, table.survivorId),
    index('contact_merges_brand_merged_idx').on(table.brandId, table.mergedId),
  ],
);

export type ContactMerge = typeof contactMerges.$inferSelect;
export type NewContactMerge = typeof contactMerges.$inferInsert;
