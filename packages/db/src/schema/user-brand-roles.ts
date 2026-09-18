import { pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { brandRoleEnum } from './enums.js';
import { users } from './users.js';

/**
 * What a staff member may do in one brand (DOMAIN-RULES §1.1–1.2). Tenant table:
 * row-level security restricts it to the brands in `app.brand_ids`.
 *
 * `departmentIds` is null for "every department", which is what an Admin always
 * has and what an unrestricted Team Leader or Viewer has. An Agent always
 * carries an explicit list.
 */
export const userBrandRoles = pgTable(
  'user_brand_roles',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    role: brandRoleEnum('role').notNull(),
    departmentIds: uuid('department_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('user_brand_roles_user_brand_key').on(table.userId, table.brandId)],
);

export type UserBrandRole = typeof userBrandRoles.$inferSelect;
export type NewUserBrandRole = typeof userBrandRoles.$inferInsert;
