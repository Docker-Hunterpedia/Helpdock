import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The database half of the configuration model (ARCHITECTURE §4). Tenant table:
 * row-level security restricts it to the brands in `app.brand_ids`.
 *
 * `value` is the JSON encoding of the setting, or the `v1.<keyId>.…` envelope
 * `@helpdock/config` writes for a secret key. There is deliberately no `key_id`
 * column: the envelope already names the master key generation that wrote it,
 * so rotation reads it from the value itself (DOMAIN-RULES §10).
 *
 * `brand_id` is not null. Install-scope rows carry `INSTALL_SCOPE_BRAND_ID`
 * instead of null, because a null would be invisible to the `brand_id = ANY(…)`
 * policy and so unreadable and unwritable by the runtime role. It carries no
 * foreign key for the same reason: the sentinel is not a brand.
 */
export const settings = pgTable(
  'settings',
  {
    key: text('key').notNull(),
    brandId: uuid('brand_id').notNull(),
    value: text('value').notNull(),
    /** User id, or a system actor such as `wizard`, so it is text and not a foreign key. */
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.key, table.brandId] })],
);

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
