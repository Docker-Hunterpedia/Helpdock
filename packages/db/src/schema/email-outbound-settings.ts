import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { users } from './users.js';

/** One department's sender, as `department_senders` stores it. */
export interface StoredDepartmentSender {
  readonly departmentId: string;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly replyTo: string | null;
}

/** An Admin's own wording for one auto-reply in one language. */
export interface StoredAutoReplyTemplate {
  readonly subject: string;
  readonly body: string;
}

/**
 * Overrides of the catalog wording, by kind and then locale. A missing entry is
 * the default from the `email` catalog, so a brand that never opened the
 * editor follows the shipped wording as it improves.
 */
export type StoredAutoReplyTemplates = Partial<
  Record<'acknowledgment' | 'outOfHours', Partial<Record<'en' | 'ar', StoredAutoReplyTemplate>>>
>;

/**
 * How one brand sends email (M2-05, M2-06): its SMTP server, who it sends as
 * per department, and its auto-replies. Configuration, read by the Outgoing
 * email tab and by the `email.send` job, never by a department.
 *
 * **A table, not the `smtp.*` settings.** Those are the install's server, set
 * by the first-run wizard, and stay the fallback: a brand with no `smtp_host`
 * here sends through them. Per-brand overrides in `settings` have no resolver
 * yet (`settings-store.ts`), and this row holds more than SMTP besides.
 *
 * **No row means the defaults**: the install's server, no sender override,
 * both auto-replies off, a cap of three per sender per hour.
 *
 * `smtp_password` is the `v1.<keyId>.…` envelope `@helpdock/config` writes
 * under `APP_MASTER_KEY`. It is never selected into a response.
 */
export const emailOutboundSettings = pgTable(
  'email_outbound_settings',
  {
    brandId: uuid('brand_id')
      .primaryKey()
      .references(() => brands.id, { onDelete: 'cascade' }),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    /** `starttls`, `tls` or `none`, as `smtpTlsModeSchema`. */
    smtpTls: text('smtp_tls'),
    smtpUser: text('smtp_user'),
    smtpPassword: text('smtp_password'),
    smtpUpdatedAt: timestamp('smtp_updated_at', { withTimezone: true }),
    smtpUpdatedBy: uuid('smtp_updated_by').references(() => users.id, { onDelete: 'set null' }),
    defaultFromName: text('default_from_name'),
    defaultFromAddress: text('default_from_address'),
    departmentSenders: jsonb('department_senders')
      .$type<StoredDepartmentSender[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    acknowledgmentEnabled: boolean('acknowledgment_enabled').notNull().default(false),
    outOfHoursEnabled: boolean('out_of_hours_enabled').notNull().default(false),
    autoReplyTemplates: jsonb('auto_reply_templates')
      .$type<StoredAutoReplyTemplates>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** M2-06's loop protection: auto-replies to one address per rolling hour. */
    autoReplyHourlyCap: integer('auto_reply_hourly_cap').notNull().default(3),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('email_outbound_settings_cap_range', sql`${table.autoReplyHourlyCap} BETWEEN 1 AND 50`),
    check(
      'email_outbound_settings_port_range',
      sql`${table.smtpPort} IS NULL OR ${table.smtpPort} BETWEEN 1 AND 65535`,
    ),
  ],
);

export type EmailOutboundSettings = typeof emailOutboundSettings.$inferSelect;
export type NewEmailOutboundSettings = typeof emailOutboundSettings.$inferInsert;
