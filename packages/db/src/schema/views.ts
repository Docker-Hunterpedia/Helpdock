import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { ticketViewBuiltInEnum } from './enums.js';
import { users } from './users.js';

/**
 * Saved filters over the ticket list (M1-05, REQUIREMENTS §4.1).
 *
 * **Personal or shared, by `owner_id`.** A row with an owner is that person's
 * alone, and row-level security enforces it: besides the brand policy every
 * tenant table has, `views` carries a restrictive policy that hides a personal
 * view from every principal but its owner — an Admin included. A row without an
 * owner is shared, and `visible_department_ids` says with whom: null is the
 * whole brand, an array is the staff whose scope reaches one of them.
 *
 * Brand-scoped and **not** department-scoped. Which departments a shared view
 * is *shown* in is a service rule, because a view grants nothing: what it
 * resolves to is a list query, and that query runs under the reader's own
 * department policy like any other.
 *
 * `filters` is `ticketViewFiltersSchema` from `@helpdock/schemas` — the ticket
 * list's own query schema — validated on the way in and on the way out.
 */
export const views = pgTable(
  'views',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Null for a shared view. Deleting the person deletes their views. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Wider than the 80 characters a person may type, because a department's
     * "All open" view is named after the department, whose own name may run to
     * 120.
     */
    name: varchar('name', { length: 160 }).notNull(),
    nameAr: varchar('name_ar', { length: 160 }),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Shared views only: null is the whole brand, otherwise these departments. */
    visibleDepartmentIds: uuid('visible_department_ids').array(),
    /** Which seeded default this is; null for a view somebody saved. */
    builtIn: ticketViewBuiltInEnum('built_in'),
    /**
     * The department a `department_open` view is for. It cascades, so deleting
     * a department takes its "All open" view with it.
     */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    /** Hidden from the brand's sidebars. Shared views only. */
    hidden: boolean('hidden').notNull().default(false),
    /** Position among the brand's shared views, or among the owner's own. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One of each default per brand, and one "All open" per department. The
    // coalesce is what makes the brand-wide four unique: a null department
    // would otherwise never collide with another null.
    uniqueIndex('views_brand_built_in_key')
      .on(
        table.brandId,
        table.builtIn,
        sql`coalesce(${table.departmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${table.builtIn} IS NOT NULL`),
    // The sidebar's read: the shared views, then one person's own, in order.
    index('views_brand_owner_sort_idx').on(table.brandId, table.ownerId, table.sortOrder),
  ],
);

export type View = typeof views.$inferSelect;
export type NewView = typeof views.$inferInsert;
