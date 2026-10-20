import { index, integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * One applied bulk edit (M14-03, ADR 0036): who, what they asked for, and until
 * when they may take it back. Written by the apply, in the same transaction as
 * the changes it describes.
 *
 * **Brand-scoped and owner-scoped.** `actor_id` narrows the row to the person
 * who made the change, so an Undo is theirs alone and an Admin cannot undo a
 * colleague's change. `changes` holds ids and enums, never text.
 *
 * Kept seven days (DOMAIN-RULES §11), with its items.
 */
export const ticketBulkOperations = pgTable(
  'ticket_bulk_operations',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
    /** Tickets that actually changed; the preview's `unchanged` ones are not counted. */
    ticketCount: integer('ticket_count').notNull(),
    undoUntil: timestamp('undo_until', { withTimezone: true }).notNull(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ticket_bulk_operations_brand_created_idx').on(table.brandId, table.createdAt)],
);

/**
 * What one ticket looked like either side of an operation: only the fields the
 * operation moved, as ids, enums and instants. **Department-scoped**, with
 * `department_id` copied from the ticket by the shared trigger and moved with
 * it, so an agent who loses sight of a ticket cannot undo its change either.
 */
export const ticketBulkOperationItems = pgTable(
  'ticket_bulk_operation_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => ticketBulkOperations.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own, as on `ticket_activity`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    before: jsonb('before').$type<Record<string, unknown>>().notNull(),
    after: jsonb('after').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ticket_bulk_operation_items_operation_idx').on(table.operationId),
    index('ticket_bulk_operation_items_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketBulkOperation = typeof ticketBulkOperations.$inferSelect;
export type NewTicketBulkOperation = typeof ticketBulkOperations.$inferInsert;
export type TicketBulkOperationItem = typeof ticketBulkOperationItems.$inferSelect;
export type NewTicketBulkOperationItem = typeof ticketBulkOperationItems.$inferInsert;
