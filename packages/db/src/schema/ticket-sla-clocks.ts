import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import {
  slaBreachCauseEnum,
  slaClockKindEnum,
  slaStopReasonEnum,
  slaTimeModeEnum,
} from './enums.js';
import { slaPolicies } from './sla-policies.js';
import { tickets } from './tickets.js';

/**
 * One SLA clock of one ticket (M3-02, DOMAIN-RULES §3.1): the columns §3.1
 * names — target, start, paused total, due, satisfied, breached — plus the
 * accounting that keeps "elapsed in business hours" exact under a calendar
 * that changes.
 *
 * **Elapsed is accumulated, not recomputed.** `elapsed_ms` is the business
 * time consumed up to `checkpoint_at`; whatever runs after that is counted
 * under the calendar in force *now*. A change of department, policy or hours
 * first moves the checkpoint to the moment of the change under the old
 * calendar, which is §3.3's "elapsed = time already consumed under the old
 * calendar (unchanged)".
 *
 * **A reopen is a new cycle.** §3.5 replaces the response clock and restarts
 * the resolution clock while keeping the originals for reports, so the old
 * rows stay with `is_current = false` and the new ones take `cycle + 1`.
 *
 * Department-scoped like every child of a ticket: `department_id` is copied
 * from the parent by `helpdock_ticket_child_department` and follows a move.
 */
export const ticketSlaClocks = pgTable(
  'ticket_sla_clocks',
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
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    kind: slaClockKindEnum('kind').notNull(),
    /** 0 for the initial clocks; one more for every reopen (§3.5). */
    cycle: integer('cycle').notNull().default(0),
    isCurrent: boolean('is_current').notNull().default(true),
    policyId: uuid('policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    targetMinutes: integer('target_minutes').notNull(),
    timeMode: slaTimeModeEnum('time_mode').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).notNull(),
    elapsedMs: bigint('elapsed_ms', { mode: 'number' }).notNull().default(0),
    checkpointAt: timestamp('checkpoint_at', { withTimezone: true, precision: 3 }).notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true, precision: 3 }),
    /** Wall time spent paused, for "time waiting on customer" (§3.2). */
    pausedTotalMs: bigint('paused_total_ms', { mode: 'number' }).notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true, precision: 3 }),
    satisfiedAt: timestamp('satisfied_at', { withTimezone: true, precision: 3 }),
    breachedAt: timestamp('breached_at', { withTimezone: true, precision: 3 }),
    breachCause: slaBreachCauseEnum('breach_cause'),
    stoppedAt: timestamp('stopped_at', { withTimezone: true, precision: 3 }),
    stopReason: slaStopReasonEnum('stop_reason'),
    /** `[{ percent, firedAt }]`: the escalation steps that ran, never to run again (§3.4). */
    firedSteps: jsonb('fired_steps')
      .$type<{ percent: number; firedAt: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('ticket_sla_clocks_ticket_kind_cycle_key').on(
      table.ticketId,
      table.kind,
      table.cycle,
    ),
    // `sla.rebuild` and a recompute read every running clock of a brand.
    index('ticket_sla_clocks_brand_running_idx')
      .on(table.brandId, table.ticketId)
      .where(
        sql`${table.isCurrent} AND ${table.satisfiedAt} IS NULL AND ${table.stoppedAt} IS NULL`,
      ),
    index('ticket_sla_clocks_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type TicketSlaClockRow = typeof ticketSlaClocks.$inferSelect;
export type NewTicketSlaClockRow = typeof ticketSlaClocks.$inferInsert;
