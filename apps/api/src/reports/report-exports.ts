import type { DbTransaction } from '@helpdock/db';
import { csvLine, type ReportExport } from '@helpdock/schemas';
import { fillDays } from './report-math.js';
import type { ReportScope, ReportsRepository } from './reports.repository.js';

/**
 * The CSV exports of Reports (M8-04): one file per report, with every row
 * rather than the summary's top twenty. Each cell goes through `csvCell`, so
 * a department named `=HYPERLINK(…)` or a search for `+1 555` opens in a
 * spreadsheet as text, never as a formula.
 *
 * The header names are English column keys rather than catalog strings: a
 * CSV is read by a spreadsheet or a script as often as by a person, and a
 * column that changes name with the reader's language breaks the script.
 */

interface ExportContext {
  readonly tx: DbTransaction;
  readonly scope: ReportScope;
  readonly repository: ReportsRepository;
}

type Cell = string | number | null;

const SLICE = ['day', 'department', 'channel', 'priority'] as const;

const rowsOf = async (
  report: ReportExport,
  { tx, scope, repository }: ExportContext,
): Promise<{ header: readonly string[]; rows: readonly (readonly Cell[])[] }> => {
  switch (report) {
    case 'volume': {
      const detail = await repository.dailyDetail(tx, scope);
      return {
        header: [...SLICE, 'created', 'resolved', 'backlog'],
        rows: detail.map((r) => [
          r.day,
          r.department,
          r.channel,
          r.priority,
          r.created,
          r.resolved,
          r.backlog,
        ]),
      };
    }
    case 'response_times': {
      const detail = await repository.dailyDetail(tx, scope);
      return {
        header: [
          ...SLICE,
          'first_responses',
          'first_response_median_ms',
          'first_response_p90_ms',
          'resolutions',
          'resolution_median_ms',
          'resolution_p90_ms',
        ],
        rows: detail.map((r) => [
          r.day,
          r.department,
          r.channel,
          r.priority,
          r.firstResponse.count,
          r.firstResponse.medianMs,
          r.firstResponse.p90Ms,
          r.resolution.count,
          r.resolution.medianMs,
          r.resolution.p90Ms,
        ]),
      };
    }
    case 'sla': {
      const detail = await repository.dailyDetail(tx, scope);
      return {
        header: [
          ...SLICE,
          'response_met',
          'response_breached',
          'resolution_met',
          'resolution_breached',
        ],
        rows: detail.map((r) => [
          r.day,
          r.department,
          r.channel,
          r.priority,
          r.slaResponseMet,
          r.slaResponseBreached,
          r.slaResolutionMet,
          r.slaResolutionBreached,
        ]),
      };
    }
    case 'csat': {
      const detail = await repository.dailyDetail(tx, scope);
      return {
        header: [...SLICE, 'rating_1', 'rating_2', 'rating_3', 'rating_4', 'rating_5'],
        rows: detail.map((r) => [r.day, r.department, r.channel, r.priority, ...r.csat]),
      };
    }
    case 'backlog': {
      const days = fillDays(scope.query.from, scope.query.to, await repository.byDay(tx, scope));
      return { header: ['day', 'open'], rows: days.map((d) => [d.day, d.backlog]) };
    }
    case 'agents': {
      const agents = await repository.agents(tx, scope, null);
      return {
        header: ['agent_id', 'agent', 'replies', 'resolved', 'assigned_open'],
        rows: agents.map((a) => [a.agentId, a.name, a.replies, a.resolved, a.assignedOpen]),
      };
    }
    case 'busiest_hours': {
      const hours = await repository.busiestHours(tx, scope);
      return {
        header: ['weekday', 'hour', 'created'],
        rows: hours.map((h) => [h.weekday, h.hour, h.created]),
      };
    }
    case 'searches': {
      const searches = await repository.searches(tx, scope, 'searches', null);
      return {
        header: ['query', 'locale', 'searches', 'zero_results', 'opened'],
        rows: searches.map((s) => [s.query, s.locale, s.searches, s.zeroResults, s.opened]),
      };
    }
  }
};

export const exportLines = async (
  report: ReportExport,
  context: ExportContext,
): Promise<readonly string[]> => {
  const { header, rows } = await rowsOf(report, context);

  return [csvLine(header), ...rows.map(csvLine)];
};
