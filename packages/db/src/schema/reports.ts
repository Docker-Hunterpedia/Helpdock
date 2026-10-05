import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { localeEnum, ticketChannelEnum, ticketPriorityEnum } from './enums.js';

/**
 * The report rollups of M8-04 (REQUIREMENTS §4.8), written by the `stats.rollup`
 * job and read by the Reports routes. One row is one brand, one local day (in
 * the brand's time zone) and one slice of the filters a report offers.
 *
 * **Rebuilt, never incremented.** A run deletes the days it covers and writes
 * them again from the source rows, so a run that repeats or overlaps another
 * leaves the same rows behind (DOMAIN-RULES §6, idempotent jobs).
 *
 * **Durations are kept as samples, not sums.** A median or a p90 over a date
 * range cannot be built from per-day medians, so each row carries the
 * milliseconds of every response or resolution that ended that day and the
 * report takes its percentiles over the samples of the whole range.
 *
 * **No foreign key to `departments`.** A department deleted later still has a
 * history; the report shows it under the name it no longer has.
 */

const dayColumn = () => date('day', { mode: 'string' }).notNull();
const counter = (name: string) => integer(name).notNull().default(0);

/**
 * Ticket volume, times, SLA outcomes, CSAT and backlog per brand, day,
 * department, channel and priority. Department-scoped like the tickets it
 * describes (DOMAIN-RULES §1.3), so a Team Leader's report is their
 * departments' by row-level security, not by a `WHERE` somebody remembered.
 */
export const reportDaily = pgTable(
  'report_daily',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    day: dayColumn(),
    departmentId: uuid('department_id').notNull(),
    channel: ticketChannelEnum('channel').notNull(),
    priority: ticketPriorityEnum('priority').notNull(),
    created: counter('created'),
    resolved: counter('resolved'),
    /** Tickets open at the end of the day: the backlog trend's point. */
    backlog: counter('backlog'),
    firstResponseMs: bigint('first_response_ms', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    resolutionMs: bigint('resolution_ms', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    slaResponseMet: counter('sla_response_met'),
    slaResponseBreached: counter('sla_response_breached'),
    slaResolutionMet: counter('sla_resolution_met'),
    slaResolutionBreached: counter('sla_resolution_breached'),
    csat1: counter('csat_1'),
    csat2: counter('csat_2'),
    csat3: counter('csat_3'),
    csat4: counter('csat_4'),
    csat5: counter('csat_5'),
    /** Tickets created in each local hour, 0–23: the busiest-hours grid. */
    createdByHour: integer('created_by_hour').array().notNull().default(sql`'{}'::integer[]`),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('report_daily_brand_day_idx').on(table.brandId, table.day)],
);

/** Agent workload per brand, day, department, channel and assignee. Department-scoped. */
export const reportAgentDaily = pgTable(
  'report_agent_daily',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    day: dayColumn(),
    departmentId: uuid('department_id').notNull(),
    channel: ticketChannelEnum('channel').notNull(),
    /** No foreign key: a deleted account's work stays in the history as "Former staff". */
    agentId: uuid('agent_id').notNull(),
    replies: counter('replies'),
    resolved: counter('resolved'),
    /** Open tickets assigned to them at the end of the day. */
    assignedOpen: counter('assigned_open'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('report_agent_daily_brand_day_idx').on(table.brandId, table.day)],
);

/**
 * Help center searches per brand, day, language and query, kept after the
 * search log itself is purged (DOMAIN-RULES §11: "aggregates for reports
 * kept"). Brand-scoped: a search has no department.
 */
export const reportSearchDaily = pgTable(
  'report_search_daily',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    day: dayColumn(),
    locale: localeEnum('locale').notNull(),
    query: varchar('query', { length: 200 }).notNull(),
    searches: counter('searches'),
    zeroResults: counter('zero_results'),
    opened: counter('opened'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('report_search_daily_brand_day_idx').on(table.brandId, table.day)],
);

/**
 * Article views per brand and day, and how many were self-service in the
 * sense of DOMAIN-RULES §15: not followed by a ticket from the same visitor
 * within an hour. Only a view made in the widget names a visitor a ticket can
 * also name, so the measured population is the widget's views.
 */
export const reportHelpCenterDaily = pgTable(
  'report_help_center_daily',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    day: dayColumn(),
    articleViews: counter('article_views'),
    widgetViews: counter('widget_views'),
    widgetViewsFollowedByTicket: counter('widget_views_followed_by_ticket'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('report_help_center_daily_brand_day_idx').on(table.brandId, table.day)],
);

export type ReportDailyRow = typeof reportDaily.$inferSelect;
export type ReportAgentDailyRow = typeof reportAgentDaily.$inferSelect;
export type ReportSearchDailyRow = typeof reportSearchDaily.$inferSelect;
export type ReportHelpCenterDailyRow = typeof reportHelpCenterDaily.$inferSelect;
