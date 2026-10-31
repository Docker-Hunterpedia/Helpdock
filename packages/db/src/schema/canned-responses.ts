import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { cannedResponseKindEnum } from './enums.js';
import { users } from './users.js';

/**
 * Canned responses and macros (M3-06, REQUIREMENTS §4.1): one table, told apart
 * by `kind`, because a macro is a canned response plus actions and the admin
 * lists, searches and scopes the two together (`macroSchema` in
 * `@helpdock/schemas` says more).
 *
 * **Personal or shared, by `owner_id`**, exactly as `views` is: a row with an
 * owner is that person's alone and a restrictive policy (`OWNER_SCOPED_TABLES`)
 * hides it from everybody else, an Admin included. A shared row's
 * `department_id` says whose it is — null is every department — and which
 * department a reader may *use* or *edit* it in is a service rule, because a
 * canned response grants nothing: a reply sent with it runs under the sender's
 * own ticket policies.
 *
 * `bodies` is `{ en, ar }` in one jsonb rather than a row per locale: the two
 * are edited, saved and audited as one form, and REQUIREMENTS §4.13's "adding a
 * locale = adding a file" becomes a key rather than a migration.
 */
export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Null for a shared one. Deleting the person deletes their own. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Shared only. Cascades rather than nulling: a null would widen a Billing
     * macro to every department the moment Billing was deleted.
     */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    kind: cannedResponseKindEnum('kind').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    bodies: jsonb('bodies').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** `macroActionSchema[]`, validated on the way in and on the way out. Empty for `canned`. */
    actions: jsonb('actions').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * M14-14: the word typed after `/` (lower-case, no spaces). Null for none.
     * Unique within the scope an item is offered in; the partial indexes below
     * are the backstop for the service's wider check.
     */
    shortcut: varchar('shortcut', { length: 32 }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** M14-14: how many times it has been applied, beside `last_used_at`, for the picker's order. */
    useCount: integer('use_count').notNull().default(0),
    /** No foreign key, for the reason `audit_log.actor_id` has none: the name outlives the person. */
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // The list's read: the brand's shared rows and one person's own, by name.
  (table) => [
    index('canned_responses_brand_owner_name_idx').on(table.brandId, table.ownerId, table.name),
    // One shortcut per scope: the brand's shared items (all departments, or one
    // department each), and each person's own.
    uniqueIndex('canned_responses_shortcut_all_idx')
      .on(table.brandId, table.shortcut)
      .where(
        sql`${table.ownerId} is null and ${table.departmentId} is null and ${table.shortcut} is not null`,
      ),
    uniqueIndex('canned_responses_shortcut_department_idx')
      .on(table.brandId, table.departmentId, table.shortcut)
      .where(
        sql`${table.ownerId} is null and ${table.departmentId} is not null and ${table.shortcut} is not null`,
      ),
    uniqueIndex('canned_responses_shortcut_owner_idx')
      .on(table.brandId, table.ownerId, table.shortcut)
      .where(sql`${table.ownerId} is not null and ${table.shortcut} is not null`),
  ],
);

export type CannedResponse = typeof cannedResponses.$inferSelect;
export type NewCannedResponse = typeof cannedResponses.$inferInsert;
