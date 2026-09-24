import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { blockedSenderKindEnum } from './enums.js';
import { users } from './users.js';

/**
 * A brand's sender block list (M1-11; DOMAIN-RULES §2.2, "sender added to block
 * list if the agent ticks 'block sender'").
 *
 * **`value` is normalised before it arrives**, by the functions that normalise
 * `contact_identities.value` (`@helpdock/schemas`, ADR 0008 for phone numbers),
 * so the inbound gate compares one spelling with one spelling. A domain is
 * lower-cased punycode with no trailing dot.
 *
 * **`dropped_count` is the only thing a match writes.** The message is gone
 * before a ticket exists, so the counter and `last_dropped_at` are the whole
 * record that the row is doing anything; the Spam tab prints them so an Admin
 * can tell a live block from a stale one.
 *
 * Brand-scoped, not department-scoped: a sender is blocked from the brand, not
 * from a queue, and the department-scoped tables of DOMAIN-RULES §1.3 are all
 * children of a ticket, which this is not.
 */
export const blockedSenders = pgTable(
  'blocked_senders',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    kind: blockedSenderKindEnum('kind').notNull(),
    value: text('value').notNull(),
    /** Who added it. Null once that person is deleted (DOMAIN-RULES §12). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The ticket it was blocked from, when it came from "Mark as spam". Not a
     * foreign key: spam tickets are purged after 30 days (§11) and the block
     * outlives them.
     */
    sourceTicketId: uuid('source_ticket_id'),
    droppedCount: integer('dropped_count').notNull().default(0),
    lastDroppedAt: timestamp('last_dropped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One row per spelling. Blocking a sender twice is the same block, and two
  // rows would split its counter in half.
  (table) => [
    unique('blocked_senders_brand_kind_value_key').on(table.brandId, table.kind, table.value),
  ],
);

export type BlockedSender = typeof blockedSenders.$inferSelect;
export type NewBlockedSender = typeof blockedSenders.$inferInsert;
