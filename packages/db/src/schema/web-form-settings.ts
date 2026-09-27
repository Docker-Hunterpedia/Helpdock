import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { users } from './users.js';

/**
 * One field of the hosted form as the Admin arranged it: a built-in field or a
 * ticket custom field by its immutable key, in the order the form draws them.
 * Whether a custom field is shown at all is `custom_field_defs.web_form`, so
 * this list only says where it goes and whether the form insists on it.
 */
export interface StoredWebFormField {
  readonly field: string;
  readonly shown: boolean;
  readonly required: boolean;
}

/** The thank-you message per language. A missing entry is the catalog's default. */
export type StoredWebFormThankYou = Partial<Record<'en' | 'ar', string>>;

/**
 * A brand's hosted web form (M4-09, REQUIREMENTS §4.4): whether it is on,
 * which department its tickets open in, whether it asks for a CAPTCHA, what
 * it says afterwards, and how its fields are laid out.
 *
 * **No row means the defaults**: off, the brand's default department, no
 * CAPTCHA, the catalog's thank-you message, the built-in fields in their
 * natural order. A brand that never opens the tab has no public form.
 *
 * `department_id` is set null when the department is deleted, which puts the
 * form back on the brand's default department rather than failing every
 * submission.
 */
export const webFormSettings = pgTable('web_form_settings', {
  brandId: uuid('brand_id')
    .primaryKey()
    .references(() => brands.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  captchaEnabled: boolean('captcha_enabled').notNull().default(false),
  thankYou: jsonb('thank_you').$type<StoredWebFormThankYou>().notNull().default(sql`'{}'::jsonb`),
  fields: jsonb('fields').$type<StoredWebFormField[]>().notNull().default(sql`'[]'::jsonb`),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WebFormSettingsRow = typeof webFormSettings.$inferSelect;
export type NewWebFormSettings = typeof webFormSettings.$inferInsert;
