import { customType, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tickets } from './tickets.js';

/**
 * `text` compared byte by byte. The fuzzy half of the search reads "every token
 * that starts with these three letters" as a range of the index
 * (`token >= p AND token < p || U+10FFFF`), and only the `C` collation orders
 * strings so that every string with a prefix sits inside that range. Lexemes
 * are already lower-cased by the text-search configuration, so nothing a
 * reader could notice depends on the collation otherwise.
 */
const byteText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
});

/**
 * The words of each ticket, one row per distinct lexeme of its subject and its
 * first message (ADR 0011, M1-15 part 2).
 *
 * It exists because the list's search cannot use a GIN index under `FORCE ROW
 * LEVEL SECURITY`: neither `@@` nor `<%` is `LEAKPROOF`, so Postgres evaluates
 * them after the policy, row by row. `=` and the range comparisons on `text`
 * are leakproof, so a lookup here is an index condition ahead of the policy
 * and a search nothing matches costs an index probe rather than a read of
 * every visible ticket. Isolation stays in the policy.
 *
 * **Department-scoped**, like every child of a ticket (DOMAIN-RULES §1.3): the
 * words of a ticket in Billing are Billing's. `department_id` is copied from
 * the parent by the shared `helpdock_ticket_child_department` trigger and
 * moved by `helpdock_ticket_department_moved`.
 *
 * Nothing in the api writes here. The rows are maintained by
 * `helpdock_ticket_search_refresh`, called by triggers on `tickets` (insert,
 * subject edit) and on a ticket's first message, in the same transaction as
 * the write (`0023_ticket_search_tokens.sql`).
 */
export const ticketSearchTokens = pgTable(
  'ticket_search_tokens',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own, as on `ticket_messages`. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** A lexeme of `to_tsvector('english', …)`, the configuration `tickets.search` uses. */
    token: byteText('token').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'ticket_search_tokens_pkey',
      columns: [table.ticketId, table.token],
    }),
    // The search: `brand_id = … AND token = ANY(…)`, or a prefix range for the
    // fuzzy half. `ticket_id` and `department_id` ride along so the lookup can
    // be answered from the index, the policy's department check included.
    index('ticket_search_tokens_brand_token_idx').on(
      table.brandId,
      table.token,
      table.ticketId,
      table.departmentId,
    ),
  ],
);

export type TicketSearchToken = typeof ticketSearchTokens.$inferSelect;
