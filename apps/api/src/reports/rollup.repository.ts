import {
  type DbTransaction,
  reportAgentDaily,
  reportDaily,
  reportHelpCenterDaily,
  reportSearchDaily,
} from '@helpdock/db';
import { and, between, eq, type SQL, sql } from 'drizzle-orm';
import type { DayRange } from './rollup-window.js';

/**
 * The statements `stats.rollup` runs (M8-04). Each one rebuilds a range of one
 * brand's local days from the source rows, inside the job's own transaction,
 * which is a system principal of that brand alone (DOMAIN-RULES §1.4): row-level
 * security keeps every read to the brand, and the brand is still named in each
 * `WHERE` so the statements read the same way without it.
 *
 * **What counts.** A ticket counts unless it is soft-deleted, merged into
 * another, or in a status excluded from reports — Spam and Merged (M1-11,
 * DOMAIN-RULES §2.1, `ticket_statuses.excluded_from_reports`). Every metric
 * is attributed to the ticket's department, channel, priority and assignee
 * *now*: a ticket moved last week reports under the department that has it,
 * and a reassigned ticket's times, SLA outcomes and rating are its new
 * assignee's (Agent workload, the Agent filter).
 *
 * **When it counts.** Each event lands on the local day it happened: created
 * on creation, resolved on `closed_at`, a response time on the response, a
 * rating on `rated_at`. The backlog is a snapshot: tickets created before a
 * day's end and not closed by it.
 *
 * **Durations** (DOMAIN-RULES §3):
 *
 * - From the ticket's SLA clocks when it has them: satisfied minus started,
 *   less `paused_total_ms` — time spent waiting on the customer is not time
 *   the desk took. Only the initial clocks (`cycle = 0`) count, unless the
 *   brand chose "count reopens" (`slaCountReopens`, §3.5), when the
 *   next-response and later resolution clocks count too.
 * - Without a clock (no SLA policy matched): the first public staff reply
 *   after creation, and `closed_at` minus creation.
 *
 * SLA compliance reads the same clocks: met when satisfied unbreached,
 * breached when breached, on the day of the outcome.
 */

export interface RollupScope {
  readonly brandId: string;
  readonly timezone: string;
  readonly range: DayRange;
  readonly countReopens: boolean;
}

/**
 * Stands in for "no assignee" while the day's events and its backlog are
 * joined: a FULL JOIN matches on equality, and NULL never equals NULL. It
 * goes back to NULL on the way into the table.
 */
const NO_ASSIGNEE = '00000000-0000-0000-0000-000000000000';
const assigneeKey = (column: SQL): SQL =>
  sql`coalesce(${column}, ${NO_ASSIGNEE}::uuid) AS assignee_key`;

/**
 * The grain `report_daily` rows are built at. 2 added the assignee
 * (`0044_report_daily_assignee`). Raise it whenever the grain or a column's
 * meaning changes: a brand with older rows in its backfill window is then
 * rebuilt in full by its next run, with no data rewritten in SQL.
 */
export const REPORT_ROLLUP_VERSION = 2;

/** Whether a brand's rollups exist, and whether they are at {@link REPORT_ROLLUP_VERSION}. */
export type RollupState = 'none' | 'stale' | 'current';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** `[from 00:00, to + 1 00:00)` on the brand's wall clock, as instants. */
const boundsCte = ({ timezone, range }: RollupScope): SQL => sql`
  bounds AS (
    SELECT (${range.from}::date)::timestamp AT TIME ZONE ${timezone} AS starts_at,
           ((${range.to}::date) + 1)::timestamp AT TIME ZONE ${timezone} AS ends_at
  ),
  days AS (
    SELECT d::date AS day, ((d::date) + 1)::timestamp AT TIME ZONE ${timezone} AS ends_at
    FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
  )`;

/** The tickets that count in reports; see the file comment. */
const countedCte = ({ brandId }: RollupScope): SQL => sql`
  counted AS (
    SELECT t.id, t.department_id, t.channel, t.priority, t.created_at, t.closed_at, t.assignee_id
    FROM tickets t
    JOIN ticket_statuses s ON s.id = t.status_id
    WHERE t.brand_id = ${brandId}
      AND t.deleted_at IS NULL
      AND t.merged_into_id IS NULL
      AND NOT s.excluded_from_reports
  )`;

/**
 * One row per ticket, clock kind and cycle. A clock replaced within a cycle
 * keeps its old row with `is_current = false`; the current one is the one
 * that speaks for the cycle.
 */
const clocksCte = ({ brandId, countReopens }: RollupScope): SQL => sql`
  clocks AS (
    SELECT DISTINCT ON (k.ticket_id, k.kind, k.cycle)
      k.ticket_id, k.kind::text AS kind, k.started_at, k.satisfied_at, k.breached_at,
      greatest(
        0,
        (extract(epoch FROM (k.satisfied_at - k.started_at)) * 1000)::bigint - k.paused_total_ms
      ) AS taken_ms
    FROM ticket_sla_clocks k
    WHERE k.brand_id = ${brandId} AND (${countReopens}::boolean OR k.cycle = 0)
    ORDER BY k.ticket_id, k.kind, k.cycle, k.is_current DESC, k.created_at DESC
  )`;

const hourCounts = (): SQL =>
  sql.join(
    HOURS.map(
      (hour) => sql`count(*) FILTER (WHERE created = 1 AND hour = ${sql.raw(String(hour))})::int`,
    ),
    sql`, `,
  );

const inRange = (
  table: typeof reportDaily | typeof reportAgentDaily | typeof reportSearchDaily,
  scope: RollupScope,
): SQL =>
  and(
    eq(table.brandId, scope.brandId),
    between(table.day, scope.range.from, scope.range.to),
  ) as SQL;

export class RollupRepository {
  /** Rebuilds every rollup of the brand for the range. */
  async rebuild(tx: DbTransaction, scope: RollupScope): Promise<void> {
    await this.#rebuildTickets(tx, scope);
    await this.#rebuildAgents(tx, scope);
    await this.#rebuildSearches(tx, scope);
    await this.#rebuildHelpCenter(tx, scope);
  }

  /**
   * `none` for a brand never rolled up, `stale` when a row from `since` on was
   * built at an older {@link REPORT_ROLLUP_VERSION}, `current` otherwise. Both
   * of the first two are backfilled. Rows before `since` are left out: the
   * backfill does not reach them, so they would read as stale for ever.
   */
  async rollupState(tx: DbTransaction, brandId: string, since: string): Promise<RollupState> {
    const [row] = await tx.execute<{ any_row: boolean; stale: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM report_daily WHERE brand_id = ${brandId}) AS any_row,
        EXISTS (
          SELECT 1 FROM report_daily
          WHERE brand_id = ${brandId} AND day >= ${since}::date
            AND rollup_version < ${REPORT_ROLLUP_VERSION}
        ) AS stale`);
    if (row?.any_row !== true) {
      return 'none';
    }

    return row.stale ? 'stale' : 'current';
  }

  /** The local day of the brand's first ticket, or null when it has none. */
  async firstActivityDay(
    tx: DbTransaction,
    brandId: string,
    timezone: string,
  ): Promise<string | null> {
    const [row] = await tx.execute<{ day: string | null }>(sql`
      SELECT ((min(created_at) AT TIME ZONE ${timezone})::date)::text AS day
      FROM tickets WHERE brand_id = ${brandId}`);

    return row?.day ?? null;
  }

  async #rebuildTickets(tx: DbTransaction, scope: RollupScope): Promise<void> {
    const { brandId, timezone } = scope;
    await tx.delete(reportDaily).where(inRange(reportDaily, scope));
    await tx.execute(sql`
      WITH ${boundsCte(scope)}, ${countedCte(scope)}, ${clocksCte(scope)},
      events AS (
        SELECT c.created_at AS at, c.department_id, c.channel, c.priority, c.assignee_id,
          1 AS created, 0 AS resolved, NULL::bigint AS frt, NULL::bigint AS res,
          0 AS rsp_met, 0 AS rsp_breached, 0 AS res_met, 0 AS res_breached, NULL::int AS rating
        FROM counted c
        UNION ALL
        SELECT c.closed_at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 1, NULL, NULL, 0, 0, 0, 0, NULL
        FROM counted c WHERE c.closed_at IS NOT NULL
        UNION ALL
        SELECT k.satisfied_at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 0, k.taken_ms, NULL, 0, 0, 0, 0, NULL
        FROM clocks k JOIN counted c ON c.id = k.ticket_id
        WHERE k.kind IN ('first_response', 'next_response') AND k.satisfied_at IS NOT NULL
        UNION ALL
        SELECT r.at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 0, (extract(epoch FROM (r.at - c.created_at)) * 1000)::bigint, NULL, 0, 0, 0, 0, NULL
        FROM counted c
        CROSS JOIN LATERAL (
          SELECT min(m.created_at) AS at FROM ticket_messages m
          WHERE m.ticket_id = c.id AND m.kind = 'public' AND m.author_type = 'staff'
        ) r
        WHERE r.at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM clocks k WHERE k.ticket_id = c.id AND k.kind = 'first_response'
          )
        UNION ALL
        SELECT k.satisfied_at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 0, NULL, k.taken_ms, 0, 0, 0, 0, NULL
        FROM clocks k JOIN counted c ON c.id = k.ticket_id
        WHERE k.kind = 'resolution' AND k.satisfied_at IS NOT NULL
        UNION ALL
        SELECT c.closed_at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 0, NULL, (extract(epoch FROM (c.closed_at - c.created_at)) * 1000)::bigint,
          0, 0, 0, 0, NULL
        FROM counted c
        WHERE c.closed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM clocks k WHERE k.ticket_id = c.id AND k.kind = 'resolution')
        UNION ALL
        SELECT k.satisfied_at, c.department_id, c.channel, c.priority, c.assignee_id, 0, 0, NULL, NULL,
          (k.kind <> 'resolution')::int, 0, (k.kind = 'resolution')::int, 0, NULL
        FROM clocks k JOIN counted c ON c.id = k.ticket_id
        WHERE k.satisfied_at IS NOT NULL AND k.breached_at IS NULL
        UNION ALL
        SELECT k.breached_at, c.department_id, c.channel, c.priority, c.assignee_id, 0, 0, NULL, NULL,
          0, (k.kind <> 'resolution')::int, 0, (k.kind = 'resolution')::int, NULL
        FROM clocks k JOIN counted c ON c.id = k.ticket_id
        WHERE k.breached_at IS NOT NULL
        UNION ALL
        SELECT r.rated_at, c.department_id, c.channel, c.priority, c.assignee_id,
          0, 0, NULL, NULL, 0, 0, 0, 0, r.rating::int
        FROM csat_responses r JOIN counted c ON c.id = r.ticket_id
        WHERE r.rating IS NOT NULL AND r.rated_at IS NOT NULL
      ),
      dated AS (
        SELECT (e.at AT TIME ZONE ${timezone})::date AS day,
          extract(hour FROM e.at AT TIME ZONE ${timezone})::int AS hour, e.*
        FROM events e, bounds b
        WHERE e.at >= b.starts_at AND e.at < b.ends_at
      ),
      grouped AS (
        SELECT day, department_id, channel, priority, ${assigneeKey(sql.raw('assignee_id'))},
          sum(created)::int AS created, sum(resolved)::int AS resolved,
          array_agg(frt ORDER BY frt) FILTER (WHERE frt IS NOT NULL) AS frt,
          array_agg(res ORDER BY res) FILTER (WHERE res IS NOT NULL) AS res,
          sum(rsp_met)::int AS rsp_met, sum(rsp_breached)::int AS rsp_breached,
          sum(res_met)::int AS res_met, sum(res_breached)::int AS res_breached,
          count(*) FILTER (WHERE rating = 1)::int AS csat_1,
          count(*) FILTER (WHERE rating = 2)::int AS csat_2,
          count(*) FILTER (WHERE rating = 3)::int AS csat_3,
          count(*) FILTER (WHERE rating = 4)::int AS csat_4,
          count(*) FILTER (WHERE rating = 5)::int AS csat_5,
          ARRAY[${hourCounts()}] AS hours
        FROM dated
        GROUP BY day, department_id, channel, priority, assignee_key
      ),
      backlog AS (
        SELECT d.day, c.department_id, c.channel, c.priority,
          ${assigneeKey(sql.raw('c.assignee_id'))}, count(*)::int AS open
        FROM days d
        JOIN counted c ON c.created_at < d.ends_at AND (c.closed_at IS NULL OR c.closed_at >= d.ends_at)
        GROUP BY d.day, c.department_id, c.channel, c.priority, assignee_key
      )
      INSERT INTO report_daily (
        brand_id, day, department_id, channel, priority, assignee_id, created, resolved, backlog,
        first_response_ms, resolution_ms, sla_response_met, sla_response_breached,
        sla_resolution_met, sla_resolution_breached, csat_1, csat_2, csat_3, csat_4, csat_5,
        created_by_hour, rollup_version
      )
      SELECT ${brandId}, day, department_id, channel, priority,
        nullif(assignee_key, ${NO_ASSIGNEE}::uuid),
        coalesce(g.created, 0), coalesce(g.resolved, 0), coalesce(b.open, 0),
        coalesce(g.frt, '{}'), coalesce(g.res, '{}'),
        coalesce(g.rsp_met, 0), coalesce(g.rsp_breached, 0),
        coalesce(g.res_met, 0), coalesce(g.res_breached, 0),
        coalesce(g.csat_1, 0), coalesce(g.csat_2, 0), coalesce(g.csat_3, 0),
        coalesce(g.csat_4, 0), coalesce(g.csat_5, 0),
        coalesce(g.hours, array_fill(0, ARRAY[24])), ${REPORT_ROLLUP_VERSION}
      FROM grouped g
      FULL JOIN backlog b USING (day, department_id, channel, priority, assignee_key)`);
  }

  async #rebuildAgents(tx: DbTransaction, scope: RollupScope): Promise<void> {
    const { brandId, timezone } = scope;
    await tx.delete(reportAgentDaily).where(inRange(reportAgentDaily, scope));
    await tx.execute(sql`
      WITH ${boundsCte(scope)}, ${countedCte(scope)},
      events AS (
        SELECT m.created_at AS at, c.department_id, c.channel,
          CASE WHEN m.author_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN m.author_id::uuid END AS agent_id,
          1 AS replies, 0 AS resolved
        FROM ticket_messages m
        JOIN counted c ON c.id = m.ticket_id, bounds b
        WHERE m.brand_id = ${brandId} AND m.kind = 'public' AND m.author_type = 'staff'
          AND m.created_at >= b.starts_at AND m.created_at < b.ends_at
        UNION ALL
        SELECT c.closed_at, c.department_id, c.channel, c.assignee_id, 0, 1
        FROM counted c, bounds b
        WHERE c.closed_at >= b.starts_at AND c.closed_at < b.ends_at AND c.assignee_id IS NOT NULL
      ),
      grouped AS (
        SELECT (at AT TIME ZONE ${timezone})::date AS day, department_id, channel, agent_id,
          sum(replies)::int AS replies, sum(resolved)::int AS resolved
        FROM events WHERE agent_id IS NOT NULL
        GROUP BY 1, 2, 3, 4
      ),
      assigned AS (
        SELECT d.day, c.department_id, c.channel, c.assignee_id AS agent_id, count(*)::int AS open
        FROM days d
        JOIN counted c ON c.assignee_id IS NOT NULL AND c.created_at < d.ends_at
          AND (c.closed_at IS NULL OR c.closed_at >= d.ends_at)
        GROUP BY d.day, c.department_id, c.channel, c.assignee_id
      )
      INSERT INTO report_agent_daily (
        brand_id, day, department_id, channel, agent_id, replies, resolved, assigned_open
      )
      SELECT ${brandId}, day, department_id, channel, agent_id,
        coalesce(g.replies, 0), coalesce(g.resolved, 0), coalesce(a.open, 0)
      FROM grouped g
      FULL JOIN assigned a USING (day, department_id, channel, agent_id)`);
  }

  async #rebuildSearches(tx: DbTransaction, scope: RollupScope): Promise<void> {
    const { brandId, timezone } = scope;
    await tx.delete(reportSearchDaily).where(inRange(reportSearchDaily, scope));
    await tx.execute(sql`
      WITH ${boundsCte(scope)}
      INSERT INTO report_search_daily (brand_id, day, locale, query, searches, zero_results, opened)
      SELECT ${brandId}, (l.created_at AT TIME ZONE ${timezone})::date, l.locale, l.query,
        count(*)::int, (count(*) FILTER (WHERE l.hits = 0))::int, count(l.opened_at)::int
      FROM hc_search_log l, bounds b
      WHERE l.brand_id = ${brandId} AND l.created_at >= b.starts_at AND l.created_at < b.ends_at
      GROUP BY 2, 3, 4`);
  }

  /**
   * A view in the widget is keyed `widget:<visitor id>` (M5-10), so hashing
   * each of the brand's widget visitors the way the view was hashed
   * (`help-center/feedback/visitor-key.ts`) finds the visitor behind it, and
   * with it any ticket they filed within the hour (DOMAIN-RULES §15).
   */
  async #rebuildHelpCenter(tx: DbTransaction, scope: RollupScope): Promise<void> {
    const { brandId, timezone } = scope;
    await tx
      .delete(reportHelpCenterDaily)
      .where(
        and(
          eq(reportHelpCenterDaily.brandId, brandId),
          between(reportHelpCenterDaily.day, scope.range.from, scope.range.to),
        ),
      );
    await tx.execute(sql`
      WITH ${boundsCte(scope)},
      widget AS (
        SELECT wv.id,
          encode(sha256(convert_to(wv.brand_id::text || ':widget:' || wv.id::text, 'UTF8')), 'hex')
            AS hash
        FROM widget_visitors wv WHERE wv.brand_id = ${brandId}
      )
      INSERT INTO report_help_center_daily (
        brand_id, day, article_views, widget_views, widget_views_followed_by_ticket
      )
      SELECT ${brandId}, (v.created_at AT TIME ZONE ${timezone})::date,
        count(*)::int, count(w.id)::int,
        (count(*) FILTER (WHERE w.id IS NOT NULL AND EXISTS (
          SELECT 1 FROM tickets t
          WHERE t.brand_id = ${brandId} AND t.visitor_id = w.id
            AND t.created_at >= v.created_at AND t.created_at < v.created_at + interval '1 hour'
        )))::int
      FROM hc_article_views v
      LEFT JOIN widget w ON w.hash = v.visitor_hash, bounds b
      WHERE v.brand_id = ${brandId} AND v.created_at >= b.starts_at AND v.created_at < b.ends_at
      GROUP BY 2`);
  }
}
