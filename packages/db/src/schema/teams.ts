import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';

/**
 * A subdivision of one department (REQUIREMENTS §3: `Departments → Teams →
 * Agents`). Tenant table: row-level security restricts it to the brands in
 * `app.brand_ids`.
 *
 * It carries `brand_id` as well as `department_id` because every tenant table
 * does — the policy is `brand_id = ANY(app.brand_ids)` and a policy that had to
 * join to find the brand would be a policy nobody could read (DOMAIN-RULES
 * §1.3). The two are kept in step by the department's own row: a team is only
 * ever created inside the transaction that has already read its department.
 *
 * It is deliberately *not* department-scoped in the row-level security sense.
 * §1.3 lists the six ticket-scoped tables, and this is not one of them: a Team
 * Leader configuring their own departments is a service-layer rule
 * (`department-scope.ts`), not a policy, exactly as it already is for
 * `departments` itself.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references((): AnyPgColumn => departments.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    /** Position inside its department. Dense and zero-based after every reorder. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Two teams with one name inside a department would be indistinguishable in
    // the assignment picker, which is the only place a person ever chooses one.
    unique('teams_department_name_key').on(table.departmentId, table.name),
    index('teams_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
