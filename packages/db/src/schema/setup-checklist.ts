import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { users } from './users.js';

/**
 * A person hiding the setup checklist in one brand (M14-13). The steps are
 * never stored, because each is computed from the brand's own data when it is
 * read; the only thing the checklist keeps is who has asked not to see it.
 *
 * **Brand-scoped and owner-scoped.** The restrictive owner policy makes a row
 * visible to the person it belongs to alone, so hiding is per person and per
 * brand and no Admin can hide it for a colleague, or read that they did. Only
 * a system transaction (a retention or erasure job) may also reach the rows.
 * `dismissed_at` is compared with the role's own `created_at` when read, so a
 * role that is removed and granted again shows the checklist again without
 * anything having to delete this row.
 */
export const setupChecklistDismissals = pgTable(
  'setup_checklist_dismissals',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.brandId, table.userId] })],
);

export type SetupChecklistDismissal = typeof setupChecklistDismissals.$inferSelect;
