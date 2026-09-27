import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';

/**
 * When SLA clocks run (M3-01, REQUIREMENTS §4.2): one row for the brand
 * (`department_id` null) and one per department that overrides it.
 *
 * `timezone` is null on the brand's row, whose zone is `brands.timezone` — one
 * column for "the brand's zone", which the wizard, the brand form and this tab
 * all read. A department's override always names its own.
 *
 * No row for the brand means the defaults of `defaultWeeklyHours` in the brand's
 * zone; no row for a department means it follows the brand.
 *
 * Brand-scoped, not department-scoped: hours are configuration, and which
 * department a Team Leader may edit is a service rule, as it is for `teams`.
 */
/**
 * The stored shape of a week: seven arrays of ranges, Sunday first. The
 * package does not depend on `@helpdock/schemas`, so the type is spelled here
 * and `weeklyHoursSchema` there is what validates it.
 */
export type StoredWeeklyHours = readonly (readonly { start: string; end: string }[])[];

export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    timezone: text('timezone'),
    /** Seven arrays of `{start, end}`, Sunday first; validated by `weeklyHoursSchema`. */
    weekly: jsonb('weekly').$type<StoredWeeklyHours>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One row per department, and one brand row: `NULLS NOT DISTINCT` makes the
    // null department collide with itself.
    unique('business_hours_brand_department_key')
      .on(table.brandId, table.departmentId)
      .nullsNotDistinct(),
  ],
);

export type BusinessHoursRow = typeof businessHours.$inferSelect;
export type NewBusinessHoursRow = typeof businessHours.$inferInsert;

/**
 * Closed days (M3-01). `department_id` null closes every department; a
 * department's own holiday closes only it. A holiday is a whole day in the zone
 * of the hours it applies to.
 */
export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('holidays_ends_after_start', sql`${table.endsOn} >= ${table.startsOn}`),
    index('holidays_brand_starts_idx').on(table.brandId, table.startsOn),
    index('holidays_brand_department_idx')
      .on(table.brandId, table.departmentId)
      .where(sql`${table.departmentId} is not null`),
  ],
);

export type HolidayRow = typeof holidays.$inferSelect;
export type NewHolidayRow = typeof holidays.$inferInsert;
