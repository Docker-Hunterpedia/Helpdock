import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { users } from './users.js';

/**
 * A brand's chat widget (M4-03, M4-06, M4-08): how it looks, what it asks
 * before a chat, where it may run and whether the brand's site may vouch for
 * its visitors. Configuration, read by the Channels › Widget tab and by every
 * widget request, never by a department.
 *
 * **No row means the defaults** (`WIDGET_SETTINGS_DEFAULTS` in
 * `@helpdock/schemas`), and no allowed origins: a brand that never opened the
 * tab has a widget that loads nowhere, which is the artboard's rule.
 *
 * The content policy is not here. It is `brands.settings.contentPolicy`
 * (M1-10), which the media pipeline already enforces for every channel; the
 * tab edits it in place. The CAPTCHA keys are the brand's `captcha.*` settings
 * (ADR 0003), shared with the web form; this row only says whether the widget
 * asks for one.
 *
 * `signing_secret` is the `v1.<keyId>.…` envelope `@helpdock/config` writes
 * under `APP_MASTER_KEY` (DOMAIN-RULES §4.2). It is never selected into a
 * response: the api returns a new secret once, when it is made.
 */
export const widgetSettings = pgTable('widget_settings', {
  brandId: uuid('brand_id')
    .primaryKey()
    .references(() => brands.id, { onDelete: 'cascade' }),
  /** `widgetAppearanceSchema`, parsed on the way in and out. */
  appearance: jsonb('appearance')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** `widgetConversationSettingsSchema`. */
  conversation: jsonb('conversation')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Exact `Origin` strings, as `widgetOriginSchema` normalises them. */
  allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
  captchaEnabled: boolean('captcha_enabled').notNull().default(false),
  signedIdentityEnabled: boolean('signed_identity_enabled').notNull().default(false),
  /** DOMAIN-RULES §4.2, default off: a verified visitor sees only widget conversations. */
  signedIdentitySeesAllChannels: boolean('signed_identity_sees_all_channels')
    .notNull()
    .default(false),
  signingSecret: text('signing_secret'),
  signingSecretSetAt: timestamp('signing_secret_set_at', { withTimezone: true }),
  signingSecretSetBy: uuid('signing_secret_set_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WidgetSettingsRow = typeof widgetSettings.$inferSelect;
export type NewWidgetSettingsRow = typeof widgetSettings.$inferInsert;
