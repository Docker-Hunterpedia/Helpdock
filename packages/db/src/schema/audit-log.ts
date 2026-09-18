import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { actorTypeEnum } from './enums.js';

/**
 * Who did what, kept for two years by default (DOMAIN-RULES §11). Tenant table:
 * row-level security restricts it to the brands in `app.brand_ids`.
 *
 * `brand_id` is not null; an install-wide action is recorded under
 * `INSTALL_SCOPE_BRAND_ID`, for the reason given on the `settings` table, and
 * for the same reason there is no foreign key to `brands`.
 *
 * `actorId` is text rather than a uuid because a system actor is a job id and a
 * visitor may be recorded before a contact exists.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    /** Dotted verb, for example `ticket.assigned` or `settings.updated`. */
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The admin activity view and the nightly retention job both read a brand's
  // rows newest first.
  (table) => [index('audit_log_brand_created_at_idx').on(table.brandId, table.createdAt)],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
