import { sql } from 'drizzle-orm';
import {
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
import { departments } from './departments.js';
import { messageAuthorTypeEnum, ticketChannelEnum, ticketMessageKindEnum } from './enums.js';
import { tickets } from './tickets.js';

/**
 * One row in a ticket's thread: a public reply, an internal note, a system
 * entry or an AI answer (REQUIREMENTS §4.1).
 *
 * **Department-scoped.** `department_id` is denormalised from the parent ticket
 * and kept true by the `ticket_messages_department` trigger, so the policy never
 * needs a join (DOMAIN-RULES §1.3). The trigger overwrites whatever is passed
 * with the ticket's own department on insert, and rewrites every row of a
 * ticket that moves department, so a caller cannot file a message under a
 * department its ticket is not in. A ticket the caller cannot see yields no
 * department at all and `NOT NULL` refuses the row.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own. See the note above. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /**
     * The cursor of DOMAIN-RULES §7: monotonic per ticket, assigned by the
     * server, and the only thing that makes a message "sent". A client that
     * receives `seq > last_seq + 1` has missed something and catches up with
     * `GET …/messages?after=<last_seq>`.
     */
    seq: integer('seq').notNull(),
    /**
     * Chosen by the client before the send, so a retry after a dropped
     * connection is recognised as the same message rather than posted twice
     * (§7). Null for messages the server writes itself.
     */
    clientId: uuid('client_id'),
    kind: ticketMessageKindEnum('kind').notNull(),
    authorType: messageAuthorTypeEnum('author_type').notNull(),
    /**
     * Text rather than a uuid, and with no foreign key: it names a user, a
     * contact or a job id depending on `author_type`, and the same column in
     * `audit_log` is text for the same reason.
     */
    authorId: text('author_id'),
    /** Sanitised on the way in (REQUIREMENTS §5.1). Never stored as it arrived. */
    bodyHtml: text('body_html').notNull(),
    /** The same body as plain text: what search, notifications and digests read. */
    bodyText: text('body_text').notNull(),
    channel: ticketChannelEnum('channel').notNull(),
    /**
     * The channel's own id for this message — an RFC 5322 `Message-ID`, a
     * Telegram update id. Unique per brand and channel, which is what stops a
     * redelivered IMAP message or Telegram update becoming a second row
     * (DOMAIN-RULES §6).
     */
    externalMessageId: text('external_message_id'),
    /** Model, tokens, cost and the sources an AI answer cited (DOMAIN-RULES §9). */
    aiMeta: jsonb('ai_meta').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The thread, and the `?after=<seq>` catch-up, in one index.
    uniqueIndex('ticket_messages_ticket_seq_key').on(table.ticketId, table.seq),
    // Partial, because most rows have no `client_id` and a unique index over
    // nulls would still carry them.
    uniqueIndex('ticket_messages_ticket_client_key')
      .on(table.ticketId, table.clientId)
      .where(sql`${table.clientId} is not null`),
    uniqueIndex('ticket_messages_external_key')
      .on(table.brandId, table.channel, table.externalMessageId)
      .where(sql`${table.externalMessageId} is not null`),
    index('ticket_messages_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketMessage = typeof ticketMessages.$inferSelect;
export type NewTicketMessage = typeof ticketMessages.$inferInsert;
