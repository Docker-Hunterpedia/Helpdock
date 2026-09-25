import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tickets } from './tickets.js';

/**
 * One satisfaction survey per close of a ticket, and its answer (REQUIREMENTS
 * §4.1, DOMAIN-RULES §2.2 and §4.6, M1-12).
 *
 * One table rather than a survey and a response: a survey has at most one
 * answer, so the answer is two nullable columns and a timestamp, and the
 * agent's "pending / sent / rated" is a read of one row.
 *
 * **One per close**, not one per ticket: `(ticket_id, closed_at)` is unique, so
 * a ticket reopened and closed again gets a second survey, and the job that
 * creates one can be delivered twice and still leave a single row.
 *
 * **Only a hash of the link's token is stored.** The token is an HMAC over the
 * brand and survey ids under a key derived from `APP_MASTER_KEY`
 * (`apps/api/src/csat/tokens.ts`), so it can be recomputed for the agent to
 * share and checked before any lookup, while a copy of this table is not a set
 * of working links.
 *
 * **Department-scoped** (DOMAIN-RULES §1.3 names `csat_responses`), with
 * `department_id` kept by the shared ticket-child triggers.
 */
export const csatResponses = pgTable(
  'csat_responses',
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
    /** Overwritten by the trigger with the ticket's own, as on `ticket_messages`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** The close this survey asks about. */
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
    /** SHA-256 of the token, hex. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by a channel when it delivers the link (M8-06). */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    rating: smallint('rating'),
    comment: text('comment'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('csat_responses_ticket_close_key').on(table.ticketId, table.closedAt),
    uniqueIndex('csat_responses_token_hash_key').on(table.tokenHash),
    // A rating and its timestamp arrive together or not at all.
    check(
      'csat_responses_rating_shape',
      sql`(${table.rating} IS NULL AND ${table.ratedAt} IS NULL) OR (${table.rating} BETWEEN 1 AND 5 AND ${table.ratedAt} IS NOT NULL)`,
    ),
    index('csat_responses_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type CsatResponse = typeof csatResponses.$inferSelect;
export type NewCsatResponse = typeof csatResponses.$inferInsert;
