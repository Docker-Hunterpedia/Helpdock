import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';

/**
 * How long a brand keeps what it keeps (DOMAIN-RULES §11), and what the last
 * nightly `maintenance.retention` run of that brand removed (M1-14).
 *
 * **A table, not a key in `brands.settings`.** That column is sent whole by the
 * brand's `PATCH`, so a screen that predates a key would reset it to the
 * default on its next save — harmless for a toggle, and a data-loss bug for a
 * retention window, where the default for closed tickets is "never" and a
 * reset could turn a brand's two-year history into a purge that night. A row
 * of its own is written only by the Data retention form and read only by the
 * form and the job.
 *
 * **No row means the defaults.** A brand that never opened the form is kept
 * under §11's defaults, which are the column defaults below; the job and the
 * api both read "missing" as "defaults" rather than insert on brand creation.
 *
 * Every window is a whole number of days. `closed_ticket_days` is null for
 * "never", which is §11's default for closed tickets. The CHECKs repeat the Zod
 * minimums (`retentionSettingsSchema`) so a hand-edited row cannot shorten the
 * audit log below the 90 days §11 promises.
 */
export const retentionSettings = pgTable(
  'retention_settings',
  {
    brandId: uuid('brand_id')
      .primaryKey()
      .references(() => brands.id, { onDelete: 'cascade' }),
    closedTicketDays: integer('closed_ticket_days'),
    spamTicketDays: integer('spam_ticket_days').notNull().default(30),
    aiCallDays: integer('ai_call_days').notNull().default(90),
    searchLogDays: integer('search_log_days').notNull().default(180),
    auditLogDays: integer('audit_log_days').notNull().default(730),
    visitorSessionDays: integer('visitor_session_days').notNull().default(30),
    /** The staff member who last saved the form. Text, as on `audit_log`. */
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the job last finished for this brand; null until it has. */
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** Rows removed per category by that run. Counts only, never an id. */
    lastRunCounts: jsonb('last_run_counts')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    check(
      'retention_settings_closed_ticket_days_check',
      sql`${table.closedTicketDays} IS NULL OR ${table.closedTicketDays} >= 1`,
    ),
    check('retention_settings_spam_ticket_days_check', sql`${table.spamTicketDays} >= 1`),
    check('retention_settings_ai_call_days_check', sql`${table.aiCallDays} >= 1`),
    check('retention_settings_search_log_days_check', sql`${table.searchLogDays} >= 1`),
    check('retention_settings_audit_log_days_check', sql`${table.auditLogDays} >= 90`),
    check('retention_settings_visitor_session_days_check', sql`${table.visitorSessionDays} >= 1`),
  ],
);

export type RetentionSettingsRow = typeof retentionSettings.$inferSelect;
export type NewRetentionSettingsRow = typeof retentionSettings.$inferInsert;
