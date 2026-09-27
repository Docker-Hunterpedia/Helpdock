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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { mailboxMethodEnum, mailboxSecurityEnum, remoteImagePolicyEnum } from './enums.js';
import { users } from './users.js';

/**
 * An address customers write to (M2-02, M2-03, M2-08; ARCHITECTURE §5's
 * "mailbox rows"). A mailbox only **receives**: replies go out through the
 * brand's outgoing mail, which is M2-05's.
 *
 * **`address` is unique across the install**, not per brand. An inbound-parse
 * request names nothing but its recipient, so the recipient alone has to pick
 * the brand; two brands claiming one address would make that a guess. The
 * price is the one `brand_domains.domain` already pays: a brand learns that an
 * address it tried to add is taken.
 *
 * **`imap_password` is a secret**: the `v1.<keyId>.…` envelope
 * `@helpdock/config` writes under `APP_MASTER_KEY`, never returned to a client
 * after it is saved (REQUIREMENTS §5.1).
 *
 * The `imap_uid_*` pair is the poller's cursor: messages above `last_uid` in a
 * folder whose `UIDVALIDITY` still matches are new. A changed validity means
 * the server renumbered the folder, and the poller starts again from the unseen
 * messages rather than trusting numbers that now mean something else; the
 * unique `Message-ID` on `ticket_messages` keeps that from importing twice.
 *
 * Brand-scoped and not department-scoped: a mailbox is configuration, and a
 * ticket it opens takes `department_id` from here at the moment it is created.
 */
export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Lower-cased, as `normaliseEmail` in `@helpdock/schemas` writes it. */
    address: text('address').notNull(),
    displayName: text('display_name').notNull(),
    /** Where a new ticket from this address is filed. Replies stay where their ticket is. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    method: mailboxMethodEnum('method').notNull(),
    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapSecurity: mailboxSecurityEnum('imap_security'),
    imapUsername: text('imap_username'),
    /** Encrypted. Null for an inbound-parse mailbox. */
    imapPassword: text('imap_password'),
    imapPasswordUpdatedAt: timestamp('imap_password_updated_at', { withTimezone: true }),
    imapPasswordUpdatedBy: uuid('imap_password_updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    imapFolder: text('imap_folder').notNull().default('INBOX'),
    pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
    /** Text, because `UIDVALIDITY` is an unsigned 32-bit number and only ever compared. */
    imapUidValidity: text('imap_uid_validity'),
    imapLastUid: bigint('imap_last_uid', { mode: 'number' }),
    remoteImages: remoteImagePolicyEnum('remote_images').notNull().default('block'),
    /** M2-07's optional heuristic: an SPF or DKIM failure opens the ticket as spam. */
    authFailureIsSpam: boolean('auth_failure_is_spam').notNull().default(false),
    /**
     * Automated senders (DOMAIN-RULES §4.3: `Auto-Submitted`, bulk, `noreply@`)
     * that may open tickets anyway, normalised. A status page is the usual one.
     */
    automatedAllowlist: text('automated_allowlist').array().notNull().default(sql`'{}'::text[]`),
    /** The inbound-parse provider that last delivered here, for "Inbound parse · Postmark". */
    inboundProvider: text('inbound_provider'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    /** The last poll or delivery that worked. What "Behind" is measured from. */
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    /**
     * What the server answered the last time it failed, as it answered it
     * ("A1 NO [AUTHENTICATIONFAILED] …"). Never a password: imapflow does not
     * echo one and nothing here writes one.
     */
    lastError: text('last_error'),
    /** `auth` or `connect`, which decides the words the list shows. */
    lastErrorKind: text('last_error_kind'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mailboxes_address_key').on(table.address),
    index('mailboxes_brand_idx').on(table.brandId),
    check('mailboxes_poll_interval_check', sql`${table.pollIntervalSeconds} IN (30, 60, 120, 300)`),
    check(
      'mailboxes_imap_complete_check',
      sql`${table.method} <> 'imap' OR (${table.imapHost} IS NOT NULL AND ${table.imapPort} IS NOT NULL AND ${table.imapSecurity} IS NOT NULL AND ${table.imapUsername} IS NOT NULL)`,
    ),
  ],
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;

/**
 * The brand's inbound-parse shared secret and its last request (M2-03, the
 * "Inbound parse endpoints" card). One row per brand, written on first use.
 *
 * The secret is ARCHITECTURE §7's `/internal/*` shared secret, one per brand
 * rather than one per install, so a leaked secret opens one brand's mailboxes
 * and not every brand's. Encrypted like every other secret, and shown once,
 * when it is replaced.
 */
export const inboundParseSettings = pgTable('inbound_parse_settings', {
  brandId: uuid('brand_id')
    .primaryKey()
    .references(() => brands.id, { onDelete: 'cascade' }),
  secret: text('secret'),
  secretUpdatedAt: timestamp('secret_updated_at', { withTimezone: true }),
  secretUpdatedBy: uuid('secret_updated_by').references(() => users.id, { onDelete: 'set null' }),
  lastRequestProvider: text('last_request_provider'),
  lastRequestAt: timestamp('last_request_at', { withTimezone: true }),
  /** `accepted`, `duplicate`, `ignored` or `refused`. */
  lastRequestOutcome: text('last_request_outcome'),
});

export type InboundParseSettings = typeof inboundParseSettings.$inferSelect;
