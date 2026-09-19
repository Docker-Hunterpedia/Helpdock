import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { integer, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { teams } from './teams.js';

/**
 * The unit a Team Leader leads, an Agent belongs to, and a ticket is filed
 * under (DOMAIN-RULES §1.2).
 *
 * M0-06 needed it to be a real table rather than an idea: a staff member's
 * `user_brand_roles.department_ids` has to reference rows that exist, or
 * "Agents see only tickets in their departments" is a promise with nothing
 * behind it. M1-01 adds the teams inside it, the order the admin list draws it
 * in, and the team a ticket falls to when no rule picks one; business hours
 * (M3), the SLA policy, `on_unassign` (M1-07) and the inbox it collects mail
 * from (M2) are still to come.
 *
 * It is deliberately not referenced by a foreign key from `user_brand_roles`:
 * that column is a `uuid[]`, and Postgres has no array foreign keys. The
 * service checks membership instead, inside the brand's own transaction, which
 * is the same check row-level security would make.
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    /**
     * The same department in Arabic. Null for an install that never serves it;
     * the screens fall back to `name` rather than printing a blank cell.
     */
    nameAr: varchar('name_ar', { length: 120 }),
    /**
     * The team a ticket in this department falls to when nothing else picks one
     * (M1-07). The reference is declared lazily because `teams` points back at
     * this table: the two tables are mutually dependent, and a deferred
     * callback is how Drizzle expresses that without a cycle at module load.
     *
     * `set null` rather than `restrict`: deleting the default team is a
     * reasonable thing to do, and it leaves the department with no default,
     * which is the state every department starts in anyway.
     */
    defaultTeamId: uuid('default_team_id').references((): AnyPgColumn => teams.id, {
      onDelete: 'set null',
    }),
    /** Position in the brand's list. Dense and zero-based after every reorder. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Two departments of one brand with the same name would be indistinguishable
  // in the chip picker, which is the only place a person ever chooses one.
  (table) => [unique('departments_brand_name_key').on(table.brandId, table.name)],
);

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
