import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { bytea } from './bytea.js';
import { users } from './users.js';

/**
 * Staff passkeys (M18-01, ADR 0050). One row per WebAuthn credential.
 *
 * Install-scoped, like `users` and `user_oauth_identities`: a passwordless
 * sign-in looks the credential up by its id before any person or brand is
 * known, and one physical key belongs to one person whatever brands they work
 * in. Only two paths reach it: the sign-in path, by `credential_id`, and a
 * person's own `/api/me/*` routes, which always filter on their own user id.
 *
 * Only the public key is stored; the private key never leaves the
 * authenticator (ASVS 2.9.1).
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The credential's `rawId`, at most 1,023 bytes by the specification. */
    credentialId: bytea('credential_id').notNull().unique('webauthn_credential_id_key'),
    /** The COSE-encoded public key. */
    publicKey: bytea('public_key').notNull(),
    /** The COSE algorithm: -8 (EdDSA), -7 (ES256) or -257 (RS256). */
    algorithm: integer('algorithm').notNull(),
    /** Checked only when non-zero: synced passkeys always report 0. */
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default([]),
    /** The authenticator model, when the browser reports one. For display only, never for policy. */
    aaguid: uuid('aaguid'),
    /** The `credProps.rk` the browser reported, or null when it reported none. */
    discoverable: boolean('discoverable'),
    backupEligible: boolean('backup_eligible').notNull(),
    backedUp: boolean('backed_up').notNull(),
    /** Chosen by the person; rendered inside `<bdi>`. */
    name: varchar('name', { length: 80 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    index('webauthn_credentials_user_idx').on(table.userId),
    check(
      'webauthn_credential_id_length_check',
      sql`octet_length(${table.credentialId}) BETWEEN 1 AND 1023`,
    ),
    check('webauthn_algorithm_check', sql`${table.algorithm} IN (-8, -7, -257)`),
  ],
);

export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type NewWebauthnCredential = typeof webauthnCredentials.$inferInsert;
