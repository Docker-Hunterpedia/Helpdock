import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { ticketMessages } from './ticket-messages.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * Time an agent spent on a ticket (REQUIREMENTS §4.1, M1-12): a manual entry
 * from the Log time dialog, the Time card's timer, or the per-reply timer sent
 * with a message (`message_id` set).
 *
 * **Department-scoped**, like every other child of a ticket: `department_id` is
 * denormalised by the shared `helpdock_ticket_child_department` trigger and
 * moved with the ticket by `helpdock_ticket_department_moved`, so an agent who
 * cannot read a ticket cannot read or log time on it either.
 *
 * `user_id` restricts deletion rather than cascading: a staff account is never
 * deleted once it has worked (DOMAIN-RULES §12 replaces its personal data
 * instead), and time that was billed must not vanish with a row that was.
 */
export const ticketTimeEntries = pgTable(
  'ticket_time_entries',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own, as on `ticket_messages`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The reply this was logged with, when it came from the per-reply timer. */
    messageId: uuid('message_id').references(() => ticketMessages.id, { onDelete: 'set null' }),
    seconds: integer('seconds').notNull(),
    note: varchar('note', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // `MAX_TIME_ENTRY_SECONDS` of `@helpdock/schemas`, repeated where a
    // hand-written insert cannot skip it.
    check('ticket_time_entries_seconds_range', sql`${table.seconds} BETWEEN 1 AND 89940`),
    index('ticket_time_entries_ticket_created_idx').on(table.ticketId, table.createdAt),
    index('ticket_time_entries_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketTimeEntry = typeof ticketTimeEntries.$inferSelect;
export type NewTicketTimeEntry = typeof ticketTimeEntries.$inferInsert;
