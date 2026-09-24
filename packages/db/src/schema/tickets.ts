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
import { contacts } from './contacts.js';
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
 * `team_id` points at a table that does not exist yet and so carries no foreign
 * key: M1-01 creates `teams`, and until it does the api refuses to set one. The
 * column is written down here rather than added later because the ticket is
 * what the rest of M1 hangs off, and a column added in a second migration is a
 * column every row already written has to be backfilled for.
 *
 * `sla_policy_id` is deliberately *not* here. Nothing in M1 reads it and,
 * unlike a contact, it is not something a ticket can be created with; M3-02
 * owns the clocks and adds it with them. The two `*_due_at` columns it fills
 * are here, because they are what a list renders.
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
    /**
     * From the brand's own sequence. Per brand, and deliberately *not* dense:
     * `nextval` is non-transactional, so a rolled-back creation burns a number
     * (see `ticket-numbers.ts`).
     */
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
    /**
     * Who the ticket is for. Nullable, because a ticket typed into the admin
     * may have nobody attached yet and M1-13's identity rules are what attach
     * one later. `set null` rather than `cascade`: erasing a contact
     * (DOMAIN-RULES §11) must not take their tickets with them, because the
     * work and the SLA history outlive the person's record.
     */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
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
    /**
     * Soft deletion by an Admin (DOMAIN-RULES §2.2): the row stays, every view
     * stops showing it, and M1-14's retention job is what finally removes it.
     *
     * It is a column rather than a status because a deleted ticket has to keep
     * the status it was in — restoring one, and reporting on what was deleted,
     * both need it — and because "deleted" is not one of the four system states
     * the SLA maths and the reports are written against.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
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
    /**
     * Millisecond precision, unlike every other timestamp in the schema, and
     * the same for `updated_at`. Both are **cursor** columns: the ticket list
     * pages by keyset, and the cursor carries the value as an ISO-8601 string,
     * which JavaScript's `Date` — what the driver hands back — cannot hold
     * beyond milliseconds. A `timestamptz` with the default microsecond
     * precision would therefore be compared against a *truncated* copy of
     * itself: ascending, the boundary row satisfies `>` again and the client
     * pages forever; descending, any row inside the sub-millisecond window is
     * silently skipped. Storing what the cursor can carry removes the
     * mismatch rather than papering over it.
     */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Numbers are per brand, and the unique index is also what catches a
    // duplicate if two requests ever read the same value from the sequence.
    unique('tickets_brand_number_key').on(table.brandId, table.number),
    // The ticket list's index set (PRD M1-15, REQUIREMENTS §5.2). Which query
    // each one serves, and the plan that proves it, is in docs/guides/tickets.md
    // under "Performance".
    //
    // The list's own ordering: `(updated_at, id)` is the keyset, so with the
    // brand fixed the default list — and every view that filters rather than
    // narrows — is an index scan that stops after one page.
    index('tickets_brand_updated_idx').on(table.brandId, table.updatedAt, table.id),
    // "My open": one person's tickets, already in list order.
    index('tickets_brand_assignee_updated_idx').on(
      table.brandId,
      table.assigneeId,
      table.updatedAt,
      table.id,
    ),
    // The department and status filters of the filter popover. `id` last, so
    // one department in one status is also already in keyset order.
    index('tickets_brand_department_status_updated_idx').on(
      table.brandId,
      table.departmentId,
      table.statusId,
      table.updatedAt,
      table.id,
    ),
    index('tickets_search_idx').using('gin', table.search),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
