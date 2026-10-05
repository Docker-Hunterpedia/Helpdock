import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { csatResponses } from './csat-responses.js';
import { departments } from './departments.js';
import { emailDeliveryKindEnum, emailDeliveryStatusEnum, localeEnum } from './enums.js';
import { ticketMessages } from './ticket-messages.js';
import { tickets } from './tickets.js';

/**
 * One outbound email (M2-05, M2-06): a public reply to its contact and CCs, or
 * an auto-reply. Written in the transaction of the change that asks for it,
 * beside the `email.send` outbox row (DOMAIN-RULES §6), and moved along by the
 * `email.send` job.
 *
 * **The addressing is frozen at creation.** `from_*`, `reply_to`, the
 * recipients and `message_id` are resolved once, so a retry an hour or a week
 * later sends the same message with the same `Message-ID` even if the
 * department's sender changed meanwhile: a client that already holds the first
 * copy recognises the second as a duplicate.
 *
 * **Department-scoped**, like every child of a ticket: `department_id` is
 * filled by `helpdock_ticket_child_department` and follows the ticket through
 * `helpdock_ticket_department_moved`.
 *
 * The body is not stored: it is the ticket message's, rendered when sent.
 */
export const emailDeliveries = pgTable(
  'email_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** The reply this sends; null for an auto-reply, which has no message of its own. */
    ticketMessageId: uuid('ticket_message_id').references(() => ticketMessages.id, {
      onDelete: 'cascade',
    }),
    kind: emailDeliveryKindEnum('kind').notNull(),
    /** The survey a `csat` email asks about (M8-06); null for every other kind. */
    csatResponseId: uuid('csat_response_id').references(() => csatResponses.id, {
      onDelete: 'cascade',
    }),
    fromName: text('from_name').notNull(),
    fromAddress: text('from_address').notNull(),
    replyTo: text('reply_to'),
    toName: text('to_name'),
    toAddress: text('to_address').notNull(),
    ccAddresses: text('cc_addresses').array().notNull().default(sql`'{}'::text[]`),
    locale: localeEnum('locale').notNull(),
    /** The RFC 5322 `Message-ID`, angle brackets included. Deterministic from the id it sends. */
    messageId: text('message_id').notNull(),
    status: emailDeliveryStatusEnum('status').notNull().default('queued'),
    /** Attempts in the current round; a retry from admin starts a new round at zero. */
    attempts: integer('attempts').notNull().default(0),
    /** The relay's last refusal, truncated. Shown to an Admin; never a credential. */
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One email per reply, however often the request that wrote it is retried.
    uniqueIndex('email_deliveries_message_key')
      .on(table.ticketMessageId)
      .where(sql`${table.ticketMessageId} is not null`),
    // "You receive at most one per request" (artboard `EmailCustomer`). A
    // transcript (M4-08) is not an auto-reply: a visitor may ask again.
    uniqueIndex('email_deliveries_auto_reply_key')
      .on(table.ticketId, table.kind)
      .where(sql`${table.kind} in ('acknowledgment', 'out_of_hours')`),
    // One survey email per survey, however often the job that asks for it runs.
    uniqueIndex('email_deliveries_csat_key')
      .on(table.csatResponseId)
      .where(sql`${table.csatResponseId} is not null`),
    uniqueIndex('email_deliveries_brand_message_id_key').on(table.brandId, table.messageId),
    index('email_deliveries_brand_status_idx').on(table.brandId, table.status),
    // The per-sender cap counts auto-replies to one address in the last hour.
    index('email_deliveries_brand_recipient_idx').on(
      table.brandId,
      table.toAddress,
      table.createdAt,
    ),
    index('email_deliveries_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type EmailDelivery = typeof emailDeliveries.$inferSelect;
export type NewEmailDelivery = typeof emailDeliveries.$inferInsert;
