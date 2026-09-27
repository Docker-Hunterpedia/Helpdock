import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { notificationKindEnum } from './enums.js';
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
  },
  (table) => [
    unique('notifications_source_user_key').on(table.sourceEventId, table.userId),
    // The panel's read: one person's rows in one brand, newest first.
    index('notifications_brand_user_created_idx').on(table.brandId, table.userId, table.createdAt),
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
export const notificationPrefs = pgTable('notification_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
