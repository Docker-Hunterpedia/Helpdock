import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tagColorEnum } from './enums.js';
import { tickets } from './tickets.js';

/**
 * The labels a brand puts on its tickets (REQUIREMENTS §4.1, M1-06).
 *
 * Brand-scoped, not department-scoped, for the reason `ticket_statuses` gives:
 * the list of tags a brand has is the same list in every department, and an
 * Agent has to be able to read the name of a tag on a ticket of their own.
 * Which *tickets* carry which tag is the department-scoped part, and that lives
 * in {@link ticketTags}.
 *
 * `color` is one of the eight keys in DESIGN §6.2 rather than a hex value, so a
 * brand cannot invent a ninth colour and a theme change never rewrites rows.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    /** Arabic label. Null means the brand has not translated this tag yet. */
    nameAr: varchar('name_ar', { length: 60 }),
    color: tagColorEnum('color').notNull().default('sand'),
    /** Position in the brand's list. Dense and zero-based after every reorder. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive, because "Refund" and "refund" are one label to the
    // person reading a ticket and two rows in the picker, which is how a tag
    // list becomes unusable. The comparison is in the index rather than in a
    // service so that two concurrent creations cannot both find the name free.
    uniqueIndex('tags_brand_name_key').on(table.brandId, sql`lower(${table.name})`),
    index('tags_brand_sort_idx').on(table.brandId, table.sortOrder),
  ],
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

/**
 * Which tickets carry which tag.
 *
 * **Department-scoped**, like every other child of a ticket: DOMAIN-RULES §1.3
 * names `ticket_tags` among the six. `department_id` is denormalised from the
 * parent by the shared `helpdock_ticket_child_department` trigger, so the
 * policy is a predicate on this table and never a join back to `tickets`. A
 * ticket that moves department takes its tags with it, through the same
 * `tickets_department_moved` trigger that moves its messages and its activity.
 *
 * The primary key is the pair, so "add this tag" is idempotent in the database
 * rather than in whichever caller remembered to check first. There is no `id`:
 * nothing points at a tagging, and a surrogate key would only be a second way
 * to name the row the pair already names.
 */
export const ticketTags = pgTable(
  'ticket_tags',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own, as on `ticket_messages`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'ticket_tags_pkey', columns: [table.ticketId, table.tagId] }),
    // "Every ticket with this tag": the list filter, and the count the delete
    // confirmation shows before it detaches them.
    index('ticket_tags_brand_tag_idx').on(table.brandId, table.tagId),
    index('ticket_tags_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketTag = typeof ticketTags.$inferSelect;
export type NewTicketTag = typeof ticketTags.$inferInsert;
