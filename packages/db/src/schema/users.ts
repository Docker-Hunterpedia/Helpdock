import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { localeEnum, userStatusEnum } from './enums.js';

/**
 * Staff accounts. Global rather than tenant-scoped: sign-in happens before any
 * brand is known, and one person may work in several brands through
 * {@link ../schema/user-brand-roles.js user_brand_roles} (ARCHITECTURE §5).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Argon2id hash. Null for an account that only signs in with OAuth or a magic link. */
    passwordHash: text('password_hash'),
    /** AES-256-GCM envelope from `@helpdock/config`; never leaves the server. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    recoveryCodesHashed: jsonb('recovery_codes_hashed')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    locale: localeEnum('locale').notNull().default('en'),
    status: userStatusEnum('status').notNull().default('invited'),
    /** The only principal that may run "all brands" paths (DOMAIN-RULES §1.1). */
    installAdmin: boolean('install_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [
    // Addresses are compared case-insensitively. A unique index on `lower(email)`
    // does that without the `citext` extension, which keeps the install to the
    // extensions ARCHITECTURE §1 already asks for (pgvector, pg_trgm).
    uniqueIndex('users_email_lower_key').using('btree', sql`lower(${table.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
