import { pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';

/**
 * The unit a Team Leader leads, an Agent belongs to, and a ticket is filed
 * under (DOMAIN-RULES §1.2).
 *
 * M0-06 needs it to be a real table rather than an idea: a staff member's
 * `user_brand_roles.department_ids` has to reference rows that exist, or
 * "Agents see only tickets in their departments" is a promise with nothing
 * behind it. So the table arrives here with the four columns the staff screens
 * read, and M1-01 extends it with the rest — business hours, the SLA policy,
 * `on_unassign`, the inbox it collects mail from.
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Two departments of one brand with the same name would be indistinguishable
  // in the chip picker, which is the only place a person ever chooses one.
  (table) => [unique('departments_brand_name_key').on(table.brandId, table.name)],
);

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
