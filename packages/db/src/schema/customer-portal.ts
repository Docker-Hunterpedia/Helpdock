import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { contactIdentities } from './contact-identities.js';
import { contacts } from './contacts.js';

/**
 * The customer portal's two tenant tables (M21-01, ADR 0059). Nothing reads
 * them yet: M21-02 writes both on the system path, which is the only path the
 * row-level security policies let write them.
 */

/**
 * One signed-in customer browser. The cookie holds an opaque 256-bit token and
 * only its SHA-256 (hex) is stored here, so a database read never yields a
 * usable session. A session is bound to the brand and to the help center host it
 * was issued on (`host`), and ends when the contact or the identity it was
 * issued for goes away (`cascade`).
 *
 * Readable by system and by staff (the contact page lists them, M21-06) and,
 * for its own rows only, by the `customer` principal; written by system alone.
 */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** The email identity the link was sent to; removing it ends the session (ADR 0059 §8). */
    contactIdentityId: uuid('contact_identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** A short family name ("Firefox on macOS"), never the raw user agent. */
    userAgentFamily: text('user_agent_family'),
    /** The help center host the session was issued on. */
    host: text('host').notNull(),
  },
  (table) => [
    uniqueIndex('customer_sessions_token_hash_key').on(table.tokenHash),
    index('customer_sessions_brand_contact_idx').on(table.brandId, table.contactId),
    index('customer_sessions_expires_idx').on(table.expiresAt),
  ],
);

/**
 * One emailed sign-in link. Only the SHA-256 (hex) of the token is stored.
 * Single use: `spent_at` is set by the `POST` the confirm page sends, never by
 * the `GET` (DOMAIN-RULES §4.6). A row exists only for an address that may sign
 * in, so the table is not a list of who is a customer to anyone who reads it.
 * System path only, in both directions.
 */
export const customerSignInTokens = pgTable(
  'customer_sign_in_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** As typed, lower-cased. */
    email: text('email').notNull(),
    /** Null when the brand lets new customers sign in and the address has no contact yet. */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    spentAt: timestamp('spent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_sign_in_tokens_token_hash_key').on(table.tokenHash),
    index('customer_sign_in_tokens_brand_email_idx').on(table.brandId, table.email),
    index('customer_sign_in_tokens_expires_idx').on(table.expiresAt),
  ],
);

export type CustomerSession = typeof customerSessions.$inferSelect;
export type NewCustomerSession = typeof customerSessions.$inferInsert;
export type CustomerSignInToken = typeof customerSignInTokens.$inferSelect;
export type NewCustomerSignInToken = typeof customerSignInTokens.$inferInsert;
