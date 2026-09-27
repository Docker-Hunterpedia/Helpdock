import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import { tickets } from './tickets.js';
import { users } from './users.js';

/** M3-03 / M3-04: started by an event, or run on a schedule over matching tickets. */
export const workflowRuleKindEnum = pgEnum('workflow_rule_kind', ['event', 'scheduled']);

/** What became of one rule on one ticket (M3-03's execution log). */
export const workflowRunResultEnum = pgEnum('workflow_run_result', [
  'applied',
  'skipped',
  'stopped',
  'failed',
]);

/**
 * A brand's workflow rules (M3-03, M3-04; REQUIREMENTS §4.3), in the order they
 * run. Brand-scoped and **not** department-scoped: a rule is configuration,
 * like a tag or a status, and which tickets it acts on is its conditions'.
 *
 * `conditions` and `actions` are `ruleConditionsSchema` and an array of
 * `ruleActionSchema` from `@helpdock/schemas`, validated on the way in and on
 * the way out. `position` orders one kind's list; event rules for one event
 * run in it.
 */
export const workflowRules = pgTable(
  'workflow_rules',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 300 }),
    kind: workflowRuleKindEnum('kind').notNull(),
    /** An event rule's event (`ruleTriggerSchema`); null on a scheduled rule. */
    trigger: varchar('trigger', { length: 40 }),
    /** A scheduled rule's interval; null on an event rule. */
    intervalMinutes: integer('interval_minutes'),
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull(),
    actions: jsonb('actions').$type<Record<string, unknown>[]>().notNull(),
    position: integer('position').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** When the time-based tick last evaluated this rule; null until it has. */
    lastScheduledRunAt: timestamp('last_scheduled_run_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The engine's read: one brand's enabled rules of one kind, in order.
    index('workflow_rules_brand_kind_position_idx').on(table.brandId, table.kind, table.position),
  ],
);

export type WorkflowRuleRow = typeof workflowRules.$inferSelect;
export type NewWorkflowRuleRow = typeof workflowRules.$inferInsert;

/**
 * The execution log (M3-03): one row per rule per ticket per event, applied,
 * skipped, stopped by the depth guard, or failed.
 *
 * **Department-scoped** like every child of a ticket (DOMAIN-RULES §1.3): a
 * run names the ticket and says what it found on it, and a Team Leader of
 * Billing has no business reading that about a Returns ticket. The department
 * is the ticket's at the moment of the run, written by the engine; a run is a
 * record of what happened then, so a later move does not rewrite it.
 *
 * `rule_name` is a snapshot, so the log still reads after a rename; `chain`
 * is the ids of the rules that ran before this one in the same chain.
 * `details` holds the failed group of a skip or the action outcomes of an
 * apply, as `workflowRunSchema` describes them.
 *
 * `match_key` is set on the applied runs of a time-based rule: the moment the
 * ticket entered the status it matched in. The unique index makes "a ticket is
 * acted on once per match" a constraint rather than a hope — a second tick that
 * finds the same ticket still waiting cannot act on it again, and a customer
 * reply, which moves the ticket's status, starts a new match.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => workflowRules.id, { onDelete: 'cascade' }),
    ruleName: varchar('rule_name', { length: 120 }).notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** A `ruleTriggerSchema` value, or `schedule`. */
    trigger: varchar('trigger', { length: 40 }).notNull(),
    result: workflowRunResultEnum('result').notNull(),
    /** `cycle` or `depth` on a stopped run. */
    stopReason: varchar('stop_reason', { length: 10 }),
    depth: integer('depth').notNull(),
    chain: uuid('chain').array().notNull().default(sql`'{}'::uuid[]`),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    matchKey: text('match_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The log's read, newest first, and the list's "last run / runs in 30 d".
    index('workflow_runs_brand_created_idx').on(table.brandId, table.createdAt),
    index('workflow_runs_rule_created_idx').on(table.ruleId, table.createdAt),
    uniqueIndex('workflow_runs_rule_ticket_match_key')
      .on(table.ruleId, table.ticketId, table.matchKey)
      .where(sql`${table.matchKey} IS NOT NULL`),
  ],
);

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;
