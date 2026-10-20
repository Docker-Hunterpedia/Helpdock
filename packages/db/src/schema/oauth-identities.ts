import { pgEnum, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { users } from './users.js';

export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'microsoft', 'github']);

/** How a provider account came to be bound (M18-07): for the person's list and the audit trail. */
export const oauthLinkedViaEnum = pgEnum('oauth_linked_via', ['sign-in', 'connect', 'invite']);

/**
 * Which Google, Microsoft or GitHub account signs in as which staff account (1.0.1,
 * ADR 0051).
 *
 * Install-scoped, like `user_sso_identities`: sign-in reads it before any brand
 * is known. A sign-in resolves `(provider, provider_subject)` first, so a bound
 * account signs in whatever address the provider reports today. The address is
 * used once, to make the first link, and only where the provider controls it.
 * `email_at_link` records what it was, for the audit trail and the person's
 * own list of sign-in methods.
 *
 * `last_used_at` is the last sign-in through it (M18-07). The security page
 * shows it beside each provider, so a provider account someone else linked and
 * uses stands out to its holder. Rows bound before it existed read null until
 * their next sign-in, as do their `linked_via`.
 */
export const userOauthIdentities = pgTable(
  'user_oauth_identities',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    /** Google's `sub`; GitHub's numeric user id, as text; Microsoft's `<tid>:<oid>`. Stable for the life of the provider account. */
    providerSubject: varchar('provider_subject', { length: 255 }).notNull(),
    emailAtLink: varchar('email_at_link', { length: 320 }).notNull(),
    linkedVia: oauthLinkedViaEnum('linked_via'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    unique('oauth_identity_subject_key').on(table.provider, table.providerSubject),
    // One per account and provider: a second link has to replace the first on purpose.
    unique('oauth_identity_user_provider_key').on(table.userId, table.provider),
  ],
);

export type UserOauthIdentity = typeof userOauthIdentities.$inferSelect;
