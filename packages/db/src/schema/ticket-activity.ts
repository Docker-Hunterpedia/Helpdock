import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { activityViaEnum, actorTypeEnum } from './enums.js';
import { tickets } from './tickets.js';

/**
 * "Activity log: every state change with who/when/via what (UI, rule, API, AI)"
 * — REQUIREMENTS §4.1.
 *
 * Separate from `audit_log`, which is the brand's administrative trail and is
 * read by admins. This one is part of the ticket: it is rendered in the thread,
 * it is scoped to a department like the ticket is, and it is purged with the
 * ticket by retention (DOMAIN-RULES §11). A change that is both — a staff
 * member reassigned by an admin action — writes a row in each.
 *
 * **Department-scoped**, with `department_id` denormalised from the ticket by
 * the `ticket_activity_department` trigger, exactly as `ticket_messages` is.
 */
export const ticketActivity = pgTable(
  'ticket_activity',
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
    actorType: actorTypeEnum('actor_type').notNull(),
    /** A user id, a visitor id, `rule:<id>` or a job id, as `audit_log` does. */
    actorId: text('actor_id').notNull(),
    /** Dotted verb: `ticket.created`, `ticket.status.changed`, `ticket.assigned`. */
    action: text('action').notNull(),
    /**
     * What the action changed, as `{ field: value }` on each side. Jsonb rather
     * than two text columns because one action can move several fields at once
     * — a macro sets status, priority and assignee — and the thread renders
     * them as one entry.
     */
    from: jsonb('from').$type<Record<string, unknown>>(),
    to: jsonb('to').$type<Record<string, unknown>>(),
    via: activityViaEnum('via').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The thread reads one ticket's entries oldest first; retention reads a
    // brand's by age, which this covers from its leading column.
    index('ticket_activity_ticket_created_idx').on(table.ticketId, table.createdAt),
    index('ticket_activity_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketActivityEntry = typeof ticketActivity.$inferSelect;
export type NewTicketActivityEntry = typeof ticketActivity.$inferInsert;
