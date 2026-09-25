import { sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { ticketPriorityEnum } from './enums.js';

/**
 * "Ticket templates: predefined subject/fields for manual creation"
 * (REQUIREMENTS §4.1). A template is a *starting point*, not a constraint:
 * `POST /tickets` applies it server-side and every field it fills can still be
 * overridden in the same request.
 *
 * Brand-scoped, even though a template may name a department. The department is
 * where a ticket made from it is filed, not who may read the template, and the
 * picker on the create screen has to show every template the brand has.
 *
 * `body_text` is plain text in M1: the composer that would produce rich text is
 * M5's TipTap, and a column full of HTML nobody sanitises on the way out is a
 * worse thing to have than one that has to be upgraded later. The api wraps it
 * into paragraphs and puts it through the same sanitiser as any other message.
 */
export const ticketTemplates = pgTable(
  'ticket_templates',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    /**
     * Where a ticket made from this template is filed. Null means "ask", and
     * the creating request has to name one. `set null` rather than `restrict`:
     * deleting a department leaves its templates usable rather than making the
     * department undeletable.
     */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    priority: ticketPriorityEnum('priority').notNull().default('medium'),
    /** May carry `{{…}}` placeholders; see `apps/api/src/ticketing/template-render.ts`. */
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    /**
     * Tags every ticket made from this template starts with. A `uuid[]` rather
     * than a join table: it is read and written whole, it is never queried
     * across templates, and a tag deleted from the brand is filtered out on
     * read rather than cascading through a second table.
     */
    defaultTagIds: uuid('default_tag_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Values for the ticket custom fields, keyed by `custom_field_defs.key`. */
    customDefaults: jsonb('custom_defaults')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * How many tickets have been created from it. Denormalised, because the
     * list prints it on every row and the alternative is a column on `tickets`
     * that every list read would have to group by.
     */
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Case-insensitive for the reason `tags` gives: the picker shows names, and
  // two that differ only in case are one name to whoever is choosing.
  (table) => [
    uniqueIndex('ticket_templates_brand_name_key').on(table.brandId, sql`lower(${table.name})`),
  ],
);

export type TicketTemplate = typeof ticketTemplates.$inferSelect;
export type NewTicketTemplate = typeof ticketTemplates.$inferInsert;
