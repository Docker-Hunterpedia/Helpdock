import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import {
  notificationEmailBatchKindEnum,
  notificationEmailBatchStatusEnum,
  notificationEmailScheduleEnum,
  notificationEmailStateEnum,
  notificationKindEnum,
} from './enums.js';
import { ticketBulkOperations } from './ticket-bulk-operations.js';
import { ticketMessages } from './ticket-messages.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/**
 * One thing one person was told about one ticket (M3-07).
 *
 * **Brand-scoped and owner-scoped.** The brand policy every tenant table has,
 * plus the restrictive owner policy of `OWNER_SCOPED_TABLES`, so a row is its
 * recipient's alone — an Admin included. The worker writes rows for other
 * people, which is why that policy lets a `system` principal through.
 *
 * **Not department-scoped, and it does not need to be.** A row holds ids and
 * never a subject or a body: the panel reads those through a join to
 * `tickets`, whose department policy decides. A ticket the recipient can no
 * longer see drops out of their panel without a trigger following it around.
 *
 * `source_event_id` is the outbox row the notification came from. With the
 * recipient it is unique, so a redelivered event is one notification however
 * often it arrives (DOMAIN-RULES §6). The three channel flags are the
 * recipient's preferences **when it was made**, so the email and push jobs
 * act on the choice that was in force, not on one changed afterwards.
 *
 * `email_state` follows the row's email through M14-10's pacing: `pending`
 * until a batch sends it or the send-time re-check skips it, and never back.
 * `email_batch_id` is the batch it went, or will go, in.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** The reply or note it is about, for the excerpt; null for SLA and assignment. */
    messageId: uuid('message_id').references(() => ticketMessages.id, { onDelete: 'set null' }),
    kind: notificationKindEnum('kind').notNull(),
    /** Who caused it: the assigner, the author of the note. Null for the system. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Kind-specific facts: the SLA clock and step, how an assignment was made. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    sourceEventId: uuid('source_event_id').notNull(),
    inApp: boolean('in_app').notNull(),
    email: boolean('email').notNull(),
    push: boolean('push').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailState: notificationEmailStateEnum('email_state'),
    emailBatchId: uuid('email_batch_id').references(() => notificationEmailBatches.id, {
      onDelete: 'set null',
    }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    /** M14-03. The bulk edit that caused it: the bell folds on it and an Undo withdraws it. */
    bulkOperationId: uuid('bulk_operation_id').references(() => ticketBulkOperations.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    unique('notifications_source_user_key').on(table.sourceEventId, table.userId),
    // The panel's read: one person's rows in one brand, newest first.
    index('notifications_brand_user_created_idx').on(table.brandId, table.userId, table.createdAt),
    // What the digest tick and the rebuild look for: email still to decide.
    index('notifications_email_pending_idx')
      .on(table.brandId, table.userId, table.createdAt)
      .where(sql`${table.emailState} = 'pending'`),
    index('notifications_email_batch_idx').on(table.emailBatchId),
    index('notifications_bulk_operation_idx')
      .on(table.bulkOperationId)
      .where(sql`${table.bulkOperationId} is not null`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * A person's choice of channel per kind (M3-07). Global, like `users`: the
 * page is "Your account", and one person is told the same way in every brand
 * they work in. A missing row means the defaults of
 * `NOTIFICATION_PREFERENCE_DEFAULTS` in `@helpdock/schemas`.
 */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull(),
    /** M14-10: how notification email reaches them. Right away is the default (D-25). */
    emailSchedule: notificationEmailScheduleEnum('email_schedule').notNull().default('immediate'),
    /** The daily digest's hour, 0–23, in the person's time zone. */
    digestHour: smallint('digest_hour').notNull().default(8),
    /** Email and push are dropped, never delayed, until then. */
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    /** M14-11's one-click unsubscribe. Leaves the matrix as it was. */
    emailUnsubscribedAt: timestamp('email_unsubscribed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'notification_prefs_digest_hour_range',
      sql`${table.digestHour} >= 0 AND ${table.digestHour} <= 23`,
    ),
  ],
);

export type NotificationPrefsRow = typeof notificationPrefs.$inferSelect;

/**
 * One browser a person turned push on in (ADR 0002). Global for the same
 * reason as `notification_prefs`: a browser subscribes once and hears about
 * every brand its owner works in. The endpoint is unique, so a browser that
 * subscribes again replaces its row rather than doubling every push.
 *
 * `p256dh` and `auth` are the subscription's public key and auth secret. The
 * payload is encrypted to them, which is what keeps the push service from
 * reading a ticket subject. A `404` or `410` from the push service deletes the
 * row.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** "Chrome on macOS", as the browser described itself. Display only. */
    label: text('label').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('push_subscriptions_endpoint_key').on(table.endpoint),
    index('push_subscriptions_user_idx').on(table.userId),
  ],
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * M14-10. One email in the making for one person in one brand (ADR 0037):
 * Right away pacing opens one and gathers what arrives until `scheduled_for`;
 * the digest tick opens one per person whose hour it is. Brand-scoped and
 * owner-scoped like `notifications`, with the worker writing for its owner.
 *
 * At most one batch of each kind is pending per person and brand, which is
 * what lets a notification find the batch to join under a lock instead of a
 * guess. `held_since` and `seen_online_at` are the presence hold's memory
 * (DOMAIN-RULES §20): when the hold began, and when the person was last
 * found online by it, so a redelivered job resumes rather than restarts it.
 */
export const notificationEmailBatches = pgTable(
  'notification_email_batches',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationEmailBatchKindEnum('kind').notNull(),
    status: notificationEmailBatchStatusEnum('status').notNull().default('pending'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    /** An urgent notification moved it earlier than pacing alone would have. */
    urgent: boolean('urgent').notNull().default(false),
    heldSince: timestamp('held_since', { withTimezone: true }),
    seenOnlineAt: timestamp('seen_online_at', { withTimezone: true }),
    /** Send failures survive BullMQ retries and rebuilds. */
    sendFailures: integer('send_failures').notNull().default(0),
    /** Daily repeat guard uses the represented tick, not when its job ran. */
    digestTickAt: timestamp('digest_tick_at', { withTimezone: true }),
    itemCount: integer('item_count').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('notification_email_batches_one_pending_key')
      .on(table.brandId, table.userId, table.kind)
      .where(sql`${table.status} = 'pending'`),
    index('notification_email_batches_brand_status_idx').on(table.brandId, table.status),
  ],
);

export type NotificationEmailBatch = typeof notificationEmailBatches.$inferSelect;

/**
 * M14-10. One person's Right away pacing in one brand (DOMAIN-RULES §20), in
 * Postgres so losing Redis loses no pacing (ADR 0037). `step` indexes the
 * back-off; `quiet_since` is the last arrival or send, from which the two
 * quiet hours that reset it are counted. The hour and day windows start at
 * the first send in them, and digests count in them too.
 */
export const notificationEmailPacing = pgTable(
  'notification_email_pacing',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    step: integer('step').notNull().default(0),
    nextAllowedAt: timestamp('next_allowed_at', { withTimezone: true }),
    quietSince: timestamp('quiet_since', { withTimezone: true }),
    hourWindowStart: timestamp('hour_window_start', { withTimezone: true }),
    sentInHour: integer('sent_in_hour').notNull().default(0),
    dayWindowStart: timestamp('day_window_start', { withTimezone: true }),
    sentInDay: integer('sent_in_day').notNull().default(0),
    urgentSentInDay: integer('urgent_sent_in_day').notNull().default(0),
    lastUrgentAt: timestamp('last_urgent_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.brandId, table.userId] })],
);

export type NotificationEmailPacingRow = typeof notificationEmailPacing.$inferSelect;
