import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { ticketChannelEnum, ticketPriorityEnum } from './enums.js';
import { ticketStatuses } from './ticket-statuses.js';
import { tsvector } from './tsvector.js';
import { users } from './users.js';

/**
 * The ticket (ARCHITECTURE §5, REQUIREMENTS §4.1). **Department-scoped**: the
 * row-level security policies add `department_id` to the brand predicate, which
 * is what makes "an Agent in another department cannot see this ticket" a
 * property of the database rather than of a query somebody remembered to write
 * (DOMAIN-RULES §1.3 layer 3).
 *
 * `department_id` is therefore not null. A ticket with no department would be
 * invisible to everyone, including the person who filed it.
 *
 * Three of the columns point at tables that do not exist yet and so carry no
 * foreign key. They are written down here rather than added later because the
 * ticket is what the rest of M1 hangs off, and a column added in a second
 * migration is a column every row already written has to be backfilled for:
 *
 * | Column | Waiting on |
 * |---|---|
 * | `team_id` | M1-01 `teams` |
 * | `contact_id` | M1-04 `contacts` |
 * | `sla_policy_id` | M3-02, which owns the clocks; the two `*_due_at` columns it fills are here |
 *
 * `sla_policy_id` is the exception and is *not* here: nothing in M1 reads it,
 * and unlike a contact it is not something a ticket can be created with.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /** From the brand's own sequence, so numbers are dense and per-brand. */
    number: bigint('number', { mode: 'number' }).notNull(),
    /**
     * The brand's prefix as it was when the ticket was created. Copied rather
     * than joined because `HD-1042` is printed in emails that outlive a rename:
     * a brand that changes its prefix must not change what an old ticket was
     * called in a message already sent (DOMAIN-RULES §11 keeps prefixes
     * reserved for the same reason).
     */
    prefix: text('prefix').notNull(),
    subject: text('subject').notNull(),
    statusId: uuid('status_id')
      .notNull()
      .references(() => ticketStatuses.id, { onDelete: 'restrict' }),
    priority: ticketPriorityEnum('priority').notNull().default('medium'),
    channel: ticketChannelEnum('channel').notNull(),
    /** M1-01 `teams`. No foreign key until that table exists. */
    teamId: uuid('team_id'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    /** M1-04 `contacts`. No foreign key until that table exists. */
    contactId: uuid('contact_id'),
    /** The closed ticket this one continues, set by the reopen policy (§2.3). */
    parentId: uuid('parent_id').references((): AnyPgColumn => tickets.id, {
      onDelete: 'set null',
    }),
    /** Set on the *secondary* of a merge; the primary is untouched (§2.4). */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => tickets.id, {
      onDelete: 'set null',
    }),
    splitFromId: uuid('split_from_id').references((): AnyPgColumn => tickets.id, {
      onDelete: 'set null',
    }),
    /** Filled by the SLA engine in M3-02; the column is here so it need not backfill. */
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
    slaBreached: boolean('sla_breached').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Custom field values, keyed by `custom_field_defs.key` (M1-06). */
    custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * Full-text search over the subject. Generated, so it can never disagree
     * with the column it is derived from — there is no update path to forget.
     *
     * `english` for every brand for now. Per-locale configuration (a brand's
     * `default_locale` choosing `arabic`) is M5, which is where the help center
     * makes the same choice for article bodies; a generated column cannot read
     * another table, so getting there means a trigger or a column that carries
     * the configuration name.
     */
    search: tsvector('search').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', coalesce(${tickets.subject}, ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Numbers are per brand, and the unique index is also what catches a
    // duplicate if two requests ever read the same value from the sequence.
    unique('tickets_brand_number_key').on(table.brandId, table.number),
    // The ticket list's index set (PRD M1-15, REQUIREMENTS §5.2). The leading
    // columns are what every list filters on and the trailing one is what it
    // sorts by, so the common view is an index scan rather than a sort.
    index('tickets_brand_department_status_updated_idx').on(
      table.brandId,
      table.departmentId,
      table.statusId,
      table.updatedAt,
    ),
    index('tickets_brand_assignee_idx').on(table.brandId, table.assigneeId),
    index('tickets_search_idx').using('gin', table.search),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
