import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';

/**
 * The transactional outbox of DOMAIN-RULES §6. A service writes its domain rows
 * and the outbox row in one transaction; `outbox.relay` in the worker publishes
 * unpublished rows to BullMQ with `jobId = outbox.id` and stamps
 * `published_at`. Tenant table: row-level security restricts it to the brands
 * in `app.brand_ids`.
 *
 * Rows are purged seven days after publishing (DOMAIN-RULES §11).
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Dotted event name the relay maps to a queue, for example `ticket.replied`. */
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // The relay's only query: unpublished rows in id order. The index is partial
    // on `published_at IS NULL` so it stays the size of the backlog rather than
    // the size of the table, and is keyed on `id` because ids are UUIDv7 and the
    // relay reads them in that order.
    index('outbox_unpublished_idx').on(table.id).where(sql`${table.publishedAt} is null`),
  ],
);

export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;
