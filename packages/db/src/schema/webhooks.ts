import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { webhookDeliveryStatusEnum } from './enums.js';
import { users } from './users.js';

/**
 * A brand's outbound webhook endpoint (M8-03, REQUIREMENTS §4.12).
 *
 * **`secret` is a secret**: the `v1.<keyId>.…` envelope `@helpdock/config`
 * writes under `APP_MASTER_KEY`. It signs every delivery and is shown once,
 * when it is created or rotated, and never again (REQUIREMENTS §5.1).
 *
 * `consecutive_failures` counts deliveries that exhausted their retries in a
 * row; at the threshold the endpoint is switched off with `disabled_reason =
 * 'failures'`, and a success resets it.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    events: text('events').array().notNull().default(sql`'{}'::text[]`),
    secret: text('secret').notNull(),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    /** `failures` when Helpdock switched it off; null when a person did, or nobody. */
    disabledReason: text('disabled_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('webhooks_brand_created_idx').on(table.brandId, table.createdAt)],
);

export type WebhookRow = typeof webhooks.$inferSelect;

/**
 * One event sent to one endpoint, and the delivery log of M8-03. The body is
 * frozen when the delivery is created, so a retry and a replay send the bytes
 * the first attempt sent.
 *
 * **Idempotent by `(webhook_id, event_id)`** (DOMAIN-RULES §6): a redelivered
 * outbox event finds its row and adds nothing. A replay is a new row with
 * `replay_of` set, which the unique index leaves out.
 *
 * What the receiver said is kept to the status code and the first 1 KB of the
 * body (DOMAIN-RULES §13); the body is never followed or rendered.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    /** The outbox row the event came from; the receiver dedupes on it. */
    eventId: uuid('event_id').notNull(),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    responseExcerpt: text('response_excerpt'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    replayOf: uuid('replay_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_event_key')
      .on(table.webhookId, table.eventId)
      .where(sql`${table.replayOf} is null`),
    index('webhook_deliveries_webhook_created_idx').on(table.webhookId, table.createdAt),
  ],
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
