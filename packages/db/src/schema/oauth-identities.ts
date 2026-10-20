import { pgEnum, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { users } from './users.js';

export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'github']);

/**
 * Which Google or GitHub account signs in as which staff account (1.0.1,
 * ADR 0051).
 *
 * Install-scoped, like `user_sso_identities`: sign-in reads it before any brand
 * is known. A sign-in resolves `(provider, provider_subject)` first, so a bound
 * account signs in whatever address the provider reports today. The address is
 * used once, to make the first link, and only where the provider controls it.
 * `email_at_link` records what it was, for the audit trail and the person's
 * own list of sign-in methods.
 */
export const userOauthIdentities = pgTable(
  'user_oauth_identities',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    /** Google's `sub`; GitHub's numeric user id, as text. Stable for the life of the provider account. */
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    emailAtLink: varchar('email_at_link', { length: 320 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('oauth_identity_subject_key').on(table.provider, table.providerSubject),
    // One per account and provider: a second link has to replace the first on purpose.
    unique('oauth_identity_user_provider_key').on(table.userId, table.provider),
  ],
);

export type UserOauthIdentity = typeof userOauthIdentities.$inferSelect;
