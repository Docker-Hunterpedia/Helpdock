import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contacts } from './contacts.js';
import { departments } from './departments.js';
import { ticketParticipantSourceEnum } from './enums.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * The CCs of a ticket (DOMAIN-RULES §2.5, M1-13).
 *
 * A ticket's participants are its contact, its CCs and its staff. Only the CCs
 * are rows: the contact is `tickets.contact_id` and the staff are the assignee
 * and whoever replied, and storing either a second time would be a second
 * answer that can drift from the first.
 *
 * A CC is a **contact**, so it has a name and can be merged like anyone else,
 * and `address` is the normalised email it was added under. The address is
 * what M2's threading compares a sender against (§4.3); it is kept on the row
 * so that a later merge of the CC's contact never changes who may thread into
 * this ticket.
 *
 * **Department-scoped**, like every child of a ticket: `department_id` is
 * filled by the shared `helpdock_ticket_child_department` trigger and follows
 * the ticket through `tickets_department_moved`, exactly as `ticket_tags` does.
 */
export const ticketParticipants = pgTable(
  'ticket_participants',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own, as on `ticket_tags`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** The normalised email it was added under; null when a merge brought a contact with none. */
    address: text('address'),
    source: ticketParticipantSourceEnum('source').notNull(),
    /** The staff member who added it; null for an inbound email or a deleted account. */
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One contact is CC'd on a ticket once, so "add" is idempotent in the
    // database rather than in whichever caller remembered to check.
    unique('ticket_participants_ticket_contact_key').on(table.ticketId, table.contactId),
    index('ticket_participants_brand_department_idx').on(table.brandId, table.departmentId),
    index('ticket_participants_brand_contact_idx').on(table.brandId, table.contactId),
  ],
);

export type TicketParticipant = typeof ticketParticipants.$inferSelect;
export type NewTicketParticipant = typeof ticketParticipants.$inferInsert;
