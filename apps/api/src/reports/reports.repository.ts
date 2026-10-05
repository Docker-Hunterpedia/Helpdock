import type { DbTransaction } from '@helpdock/db';
import type { ReportQuery, TicketChannel, TicketPriority } from '@helpdock/schemas';
import { type SQL, sql } from 'drizzle-orm';

/**
 * The reads behind Reports (M8-04). Every one runs in the request's
 * transaction, so row-level security narrows the rollups to the brand and —
 * because `report_daily` and `report_agent_daily` are department-scoped — to
 * the departments the reader may see (DOMAIN-RULES §1.2). The filters below
 * narrow further; they can never widen.
 */

export interface ReportScope {
  readonly brandId: string;
  readonly query: ReportQuery;
  readonly timezone: string;
}

type Numeric = number | string | null;
const num = (value: Numeric): number => (value === null ? 0 : Number(value));
const nullableNum = (value: Numeric): number | null => (value === null ? null : Number(value));

/** The rows of `report_daily` the query asks for. */
const dailyWhere = ({ brandId, query }: ReportScope, alias = 'r'): SQL => {
  const table = sql.raw(alias);
  return sql.join(
    [
      sql`${table}.brand_id = ${brandId}`,
      sql`${table}.day BETWEEN ${query.from}::date AND ${query.to}::date`,
      ...(query.departmentId === undefined
        ? []
        : [sql`${table}.department_id = ${query.departmentId}`]),
      ...(query.channel === undefined ? [] : [sql`${table}.channel = ${query.channel}`]),
    ],
    sql` AND `,
  );
};

export interface DayRow {
  readonly day: string;
  readonly created: number;
  readonly resolved: number;
  readonly backlog: number;
}

export interface SliceRow<K extends string> {
  readonly key: K;
  readonly created: number;
  readonly resolved: number;
}

export interface Totals {
  readonly computedAt: Date | null;
  readonly slaResponseMet: number;
  readonly slaResponseBreached: number;
  readonly slaResolutionMet: number;
  readonly slaResolutionBreached: number;
  /** Ratings 1 to 5, in order. */
  readonly csat: readonly number[];
}

export interface Durations {
  readonly count: number;
  readonly medianMs: number | null;
  readonly p90Ms: number | null;
}

export interface StatusRow {
  readonly statusId: string;
  readonly name: string;
  readonly systemState: 'open' | 'on_hold' | 'escalated' | 'closed';
  readonly tickets: number;
}

export interface AgentRow {
  readonly agentId: string;
  readonly name: string | null;
  readonly replies: number;
  readonly resolved: number;
  readonly assignedOpen: number;
}

export interface HourRow {
  readonly weekday: number;
  readonly hour: number;
  readonly created: number;
}

export interface SearchRow {
  readonly query: string;
  readonly locale: 'en' | 'ar';
  readonly searches: number;
  readonly zeroResults: number;
  readonly opened: number;
}

/** One `report_daily` slice with its own percentiles: the export's row. */
export interface DailyDetailRow {
  readonly day: string;
  readonly department: string | null;
  readonly channel: TicketChannel;
  readonly priority: TicketPriority;
  readonly created: number;
  readonly resolved: number;
  readonly backlog: number;
  readonly firstResponse: Durations;
  readonly resolution: Durations;
  readonly slaResponseMet: number;
  readonly slaResponseBreached: number;
  readonly slaResolutionMet: number;
  readonly slaResolutionBreached: number;
  readonly csat: readonly number[];
}

export class ReportsRepository {
  async byDay(tx: DbTransaction, scope: ReportScope): Promise<DayRow[]> {
    const rows = await tx.execute<{
      day: string;
      created: Numeric;
      resolved: Numeric;
      backlog: Numeric;
    }>(sql`
      SELECT r.day::text AS day, sum(r.created) AS created, sum(r.resolved) AS resolved,
        sum(r.backlog) AS backlog
      FROM report_daily r WHERE ${dailyWhere(scope)}
      GROUP BY r.day ORDER BY r.day`);

    return rows.map((row) => ({
      day: row.day,
      created: num(row.created),
      resolved: num(row.resolved),
      backlog: num(row.backlog),
    }));
  }

  async byChannel(tx: DbTransaction, scope: ReportScope): Promise<SliceRow<TicketChannel>[]> {
    return this.#slice(tx, scope, sql.raw('channel'));
  }

  async byPriority(tx: DbTransaction, scope: ReportScope): Promise<SliceRow<TicketPriority>[]> {
    return this.#slice(tx, scope, sql.raw('priority'));
  }

  async #slice<K extends string>(
    tx: DbTransaction,
    scope: ReportScope,
    column: SQL,
  ): Promise<SliceRow<K>[]> {
    const rows = await tx.execute<{ key: K; created: Numeric; resolved: Numeric }>(sql`
      SELECT r.${column}::text AS key, sum(r.created) AS created, sum(r.resolved) AS resolved
      FROM report_daily r WHERE ${dailyWhere(scope)}
      GROUP BY r.${column} ORDER BY sum(r.created) DESC, r.${column}`);

    return rows.map((row) => ({
      key: row.key,
      created: num(row.created),
      resolved: num(row.resolved),
    }));
  }

  async totals(tx: DbTransaction, scope: ReportScope): Promise<Totals> {
    const [row] = await tx.execute<Record<string, Numeric | Date>>(sql`
      SELECT min(r.computed_at) AS computed_at,
        sum(r.sla_response_met) AS rsp_met, sum(r.sla_response_breached) AS rsp_breached,
        sum(r.sla_resolution_met) AS res_met, sum(r.sla_resolution_breached) AS res_breached,
        sum(r.csat_1) AS c1, sum(r.csat_2) AS c2, sum(r.csat_3) AS c3,
        sum(r.csat_4) AS c4, sum(r.csat_5) AS c5
      FROM report_daily r WHERE ${dailyWhere(scope)}`);
    const value = (key: string): number => num((row?.[key] ?? null) as Numeric);
    const computedAt = row?.computed_at;

    return {
      computedAt:
        computedAt === null || computedAt === undefined ? null : new Date(computedAt as Date),
      slaResponseMet: value('rsp_met'),
      slaResponseBreached: value('rsp_breached'),
      slaResolutionMet: value('res_met'),
      slaResolutionBreached: value('res_breached'),
      csat: ['c1', 'c2', 'c3', 'c4', 'c5'].map(value),
    };
  }

  async durations(
    tx: DbTransaction,
    scope: ReportScope,
    which: 'first_response_ms' | 'resolution_ms',
  ): Promise<Durations> {
    const [row] = await tx.execute<{ count: Numeric; median: Numeric; p90: Numeric }>(sql`
      SELECT count(ms) AS count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ms) AS p90
      FROM report_daily r, unnest(r.${sql.raw(which)}) AS ms
      WHERE ${dailyWhere(scope)}`);

    return {
      count: num(row?.count ?? null),
      medianMs: nullableNum(row?.median ?? null),
      p90Ms: nullableNum(row?.p90 ?? null),
    };
  }

  /** ISO weekday and local hour of every ticket created in the range; empty cells left out. */
  async busiestHours(tx: DbTransaction, scope: ReportScope): Promise<HourRow[]> {
    const rows = await tx.execute<{ weekday: Numeric; hour: Numeric; created: Numeric }>(sql`
      SELECT extract(isodow FROM r.day)::int AS weekday, (h.ord - 1)::int AS hour,
        sum(h.n) AS created
      FROM report_daily r, unnest(r.created_by_hour) WITH ORDINALITY AS h(n, ord)
      WHERE ${dailyWhere(scope)}
      GROUP BY 1, 2 HAVING sum(h.n) > 0
      ORDER BY 1, 2`);

    return rows.map((row) => ({
      weekday: num(row.weekday),
      hour: num(row.hour),
      created: num(row.created),
    }));
  }

  /**
   * Tickets created in the range by the status they are in now. A current
   * state, so it is read from `tickets` rather than a rollup; the same tickets
   * count as in the rollups (`rollup.repository.ts`).
   */
  async byStatus(tx: DbTransaction, scope: ReportScope): Promise<StatusRow[]> {
    const { brandId, query, timezone } = scope;
    const rows = await tx.execute<{
      status_id: string;
      name: string;
      system_state: StatusRow['systemState'];
      tickets: Numeric;
    }>(sql`
      SELECT s.id AS status_id, s.name, s.system_state::text AS system_state, count(*) AS tickets
      FROM tickets t
      JOIN ticket_statuses s ON s.id = t.status_id
      WHERE t.brand_id = ${brandId}
        AND t.created_at >= (${query.from}::date)::timestamp AT TIME ZONE ${timezone}
        AND t.created_at < ((${query.to}::date) + 1)::timestamp AT TIME ZONE ${timezone}
        AND t.deleted_at IS NULL AND t.merged_into_id IS NULL AND NOT s.excluded_from_reports
        ${query.departmentId === undefined ? sql`` : sql`AND t.department_id = ${query.departmentId}`}
        ${query.channel === undefined ? sql`` : sql`AND t.channel = ${query.channel}`}
      GROUP BY s.id, s.name, s.system_state, s.sort_order
      ORDER BY s.sort_order, s.name`);

    return rows.map((row) => ({
      statusId: row.status_id,
      name: row.name,
      systemState: row.system_state,
      tickets: num(row.tickets),
    }));
  }

  /**
   * Each agent's replies and resolutions over the range, and the open tickets
   * assigned to them at its end. A name is read from `users` (a global table);
   * an account that no longer exists has none.
   */
  async agents(tx: DbTransaction, scope: ReportScope, limit: number | null): Promise<AgentRow[]> {
    const rows = await tx.execute<{
      agent_id: string;
      name: string | null;
      replies: Numeric;
      resolved: Numeric;
      assigned_open: Numeric;
    }>(sql`
      SELECT a.agent_id, u.name, sum(a.replies) AS replies, sum(a.resolved) AS resolved,
        coalesce(sum(a.assigned_open) FILTER (WHERE a.day = ${scope.query.to}::date), 0)
          AS assigned_open
      FROM report_agent_daily a
      LEFT JOIN users u ON u.id = a.agent_id
      WHERE ${dailyWhere(scope, 'a')}
      GROUP BY a.agent_id, u.name
      ORDER BY sum(a.replies) DESC, sum(a.resolved) DESC, a.agent_id
      ${limit === null ? sql`` : sql`LIMIT ${limit}`}`);

    return rows.map((row) => ({
      agentId: row.agent_id,
      name: row.name,
      replies: num(row.replies),
      resolved: num(row.resolved),
      assignedOpen: num(row.assigned_open),
    }));
  }

  /**
   * Help center searches over the range, by query and language. Searches
   * have no department or channel, so those filters do not apply here.
   */
  async searches(
    tx: DbTransaction,
    { brandId, query }: ReportScope,
    order: 'searches' | 'zero_results',
    limit: number | null,
  ): Promise<SearchRow[]> {
    const rows = await tx.execute<{
      query: string;
      locale: 'en' | 'ar';
      searches: Numeric;
      zero_results: Numeric;
      opened: Numeric;
    }>(sql`
      SELECT s.query, s.locale::text AS locale, sum(s.searches) AS searches,
        sum(s.zero_results) AS zero_results, sum(s.opened) AS opened
      FROM report_search_daily s
      WHERE s.brand_id = ${brandId} AND s.day BETWEEN ${query.from}::date AND ${query.to}::date
      GROUP BY s.query, s.locale
      ${order === 'zero_results' ? sql`HAVING sum(s.zero_results) > 0` : sql``}
      ORDER BY ${order === 'zero_results' ? sql`sum(s.zero_results)` : sql`sum(s.searches)`} DESC,
        s.query, s.locale
      ${limit === null ? sql`` : sql`LIMIT ${limit}`}`);

    return rows.map((row) => ({
      query: row.query,
      locale: row.locale,
      searches: num(row.searches),
      zeroResults: num(row.zero_results),
      opened: num(row.opened),
    }));
  }

  /** Every slice of every day, with the department's name: what the exports write. */
  async dailyDetail(tx: DbTransaction, scope: ReportScope): Promise<DailyDetailRow[]> {
    const percentiles = (column: string): SQL => sql`(
      SELECT jsonb_build_array(count(ms),
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ms),
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ms))
      FROM unnest(r.${sql.raw(column)}) AS ms)`;
    const rows = await tx.execute<{
      day: string;
      department: string | null;
      channel: TicketChannel;
      priority: TicketPriority;
      created: number;
      resolved: number;
      backlog: number;
      frt: [Numeric, Numeric, Numeric];
      res: [Numeric, Numeric, Numeric];
      rsp_met: number;
      rsp_breached: number;
      res_met: number;
      res_breached: number;
      csat: number[];
    }>(sql`
      SELECT r.day::text AS day, d.name AS department, r.channel::text AS channel,
        r.priority::text AS priority, r.created, r.resolved, r.backlog,
        ${percentiles('first_response_ms')} AS frt, ${percentiles('resolution_ms')} AS res,
        r.sla_response_met AS rsp_met, r.sla_response_breached AS rsp_breached,
        r.sla_resolution_met AS res_met, r.sla_resolution_breached AS res_breached,
        ARRAY[r.csat_1, r.csat_2, r.csat_3, r.csat_4, r.csat_5] AS csat
      FROM report_daily r
      LEFT JOIN departments d ON d.id = r.department_id
      WHERE ${dailyWhere(scope)}
      ORDER BY r.day, d.name, r.channel, r.priority`);
    const durations = ([count, median, p90]: [Numeric, Numeric, Numeric]): Durations => ({
      count: num(count),
      medianMs: nullableNum(median),
      p90Ms: nullableNum(p90),
    });

    return rows.map((row) => ({
      day: row.day,
      department: row.department,
      channel: row.channel,
      priority: row.priority,
      created: row.created,
      resolved: row.resolved,
      backlog: row.backlog,
      firstResponse: durations(row.frt),
      resolution: durations(row.res),
      slaResponseMet: row.rsp_met,
      slaResponseBreached: row.rsp_breached,
      slaResolutionMet: row.res_met,
      slaResolutionBreached: row.res_breached,
      csat: row.csat,
    }));
  }
}
