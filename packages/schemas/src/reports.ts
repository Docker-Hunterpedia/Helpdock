import { z } from 'zod';
import { localeSchema } from './brand.js';
import { CSAT_RATING_MAX, CSAT_RATING_MIN } from './csat.js';
import { ticketChannelSchema, ticketPrioritySchema } from './ticket.js';

/**
 * Reports (M8-04, REQUIREMENTS §4.8): what `GET /api/brands/:brandId/reports`
 * answers and the CSV exports beside it.
 *
 * Days are the brand's local calendar days, inclusive at both ends, because
 * "yesterday" means the brand's yesterday to the people reading the report.
 * Every number comes from the rollups `stats.rollup` writes, except tickets by
 * status, which is a current state rather than something that happened on a
 * day, and is read from the tickets themselves.
 */

/** The longest range one request may ask for: a year and a leap day. */
export const REPORT_MAX_DAYS = 366;

/** Rows a ranked list (agents, searches) returns. The CSV export has them all. */
export const REPORT_LIST_ROWS = 20;

const DAY_MS = 86_400_000;

/** Inclusive days between two ISO dates. */
export const reportRangeDays = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

export const reportQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    departmentId: z.uuid().optional(),
    channel: ticketChannelSchema.optional(),
    /**
     * The ticket's assignee for ticket figures, the agent for Agent workload.
     * Help center searches and AI cost have no agent and ignore it.
     */
    agentId: z.uuid().optional(),
  })
  .refine((query) => query.from <= query.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine((query) => reportRangeDays(query.from, query.to) <= REPORT_MAX_DAYS, {
    message: `A report covers at most ${REPORT_MAX_DAYS} days`,
    path: ['to'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const REPORT_EXPORTS = [
  'volume',
  'volume_by_status',
  'response_times',
  'sla',
  'backlog',
  'csat',
  'agents',
  'busiest_hours',
  'searches',
] as const;
export const reportExportSchema = z.enum(REPORT_EXPORTS);
export type ReportExport = z.infer<typeof reportExportSchema>;

/**
 * `helpdock-volume-2026-09-01-2026-09-30.csv`: what the export route names its
 * attachment and what the admin saves the download as.
 */
export const reportExportFileName = (report: ReportExport, from: string, to: string): string =>
  `helpdock-${report.replaceAll('_', '-')}-${from}-${to}.csv`;

export const reportExportParamSchema = z.object({
  brandId: z.uuid(),
  report: reportExportSchema,
});
export type ReportExportParam = z.infer<typeof reportExportParamSchema>;

const count = z.int().nonnegative();
/** A share between 0 and 1, or null when there was nothing to divide by. */
const share = z.number().min(0).max(1).nullable();

export const durationStatsSchema = z.object({
  /** How many responses or resolutions the percentiles are over. */
  count,
  medianMs: z.number().nonnegative().nullable(),
  p90Ms: z.number().nonnegative().nullable(),
});
export type DurationStats = z.infer<typeof durationStatsSchema>;

export const slaOutcomeSchema = z.object({
  met: count,
  breached: count,
  compliance: share,
});
export type SlaOutcome = z.infer<typeof slaOutcomeSchema>;

/** A median over the range, with how many samples it is over. */
const medianSchema = z.object({ count, medianMs: z.number().nonnegative().nullable() });

/**
 * AI deflection and cost. `available: false` until the AI subsystem (M7)
 * records calls, rather than zeroes that would read as "the AI did nothing".
 */
export const reportAiSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    deflection: z.object({ eligible: count, deflected: count, rate: share }),
    cost: z.object({
      calls: count,
      tokensIn: count,
      tokensOut: count,
      costUsd: z.number().nonnegative(),
    }),
  }),
]);
export type ReportAi = z.infer<typeof reportAiSchema>;

export const reportSummarySchema = z.object({
  range: z.object({ from: z.iso.date(), to: z.iso.date(), timezone: z.string().min(1) }),
  filters: z.object({
    departmentId: z.uuid().nullable(),
    channel: ticketChannelSchema.nullable(),
    agentId: z.uuid().nullable(),
  }),
  /** When the oldest rollup in the range was written; null when the range has none yet. */
  computedAt: z.iso.datetime().nullable(),
  volume: z.object({
    created: count,
    resolved: count,
    byDay: z.array(z.object({ day: z.iso.date(), created: count, resolved: count })),
    /** Tickets created per day and channel, for the stacked columns; zero cells left out. */
    byDayAndChannel: z.array(
      z.object({ day: z.iso.date(), channel: ticketChannelSchema, created: count }),
    ),
    byDayAndPriority: z.array(
      z.object({ day: z.iso.date(), priority: ticketPrioritySchema, created: count }),
    ),
    /** Tickets created per day by the status they are in now; zero cells left out. */
    byDayAndStatus: z.array(z.object({ day: z.iso.date(), statusId: z.uuid(), tickets: count })),
    byChannel: z.array(z.object({ channel: ticketChannelSchema, created: count, resolved: count })),
    byPriority: z.array(
      z.object({ priority: ticketPrioritySchema, created: count, resolved: count }),
    ),
    /** Tickets created in the range, by the status they are in now. */
    byStatus: z.array(
      z.object({
        statusId: z.uuid(),
        name: z.string(),
        systemState: z.enum(['open', 'on_hold', 'escalated', 'closed']),
        tickets: count,
      }),
    ),
  }),
  firstResponse: durationStatsSchema,
  resolution: durationStatsSchema,
  sla: z.object({
    response: slaOutcomeSchema,
    resolution: slaOutcomeSchema,
    /** Both clocks together, per priority, most urgent first; priorities with no outcome left out. */
    byPriority: z.array(slaOutcomeSchema.extend({ priority: ticketPrioritySchema })),
    /** The brand's `slaCountReopens` (DOMAIN-RULES §3.5) at the time of the rollup. */
    countsReopens: z.boolean(),
  }),
  backlog: z.array(z.object({ day: z.iso.date(), open: count })),
  csat: z.object({
    responses: count,
    average: z.number().min(CSAT_RATING_MIN).max(CSAT_RATING_MAX).nullable(),
    /** Ratings of 4 and 5 over all ratings. */
    satisfied: share,
    distribution: z.array(
      z.object({ rating: z.int().min(CSAT_RATING_MIN).max(CSAT_RATING_MAX), responses: count }),
    ),
  }),
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      /** Null for an account that no longer exists. */
      name: z.string().nullable(),
      replies: count,
      resolved: count,
      /** Open tickets assigned to them at the end of the range. */
      assignedOpen: count,
      /** The times, SLA outcomes and ratings of the tickets assigned to them. */
      firstResponse: medianSchema,
      resolution: medianSchema,
      sla: slaOutcomeSchema,
      csat: z.object({
        responses: count,
        average: z.number().min(CSAT_RATING_MIN).max(CSAT_RATING_MAX).nullable(),
      }),
    }),
  ),
  /** Open tickets with no assignee at the end of the range: Agent workload's last row. */
  unassignedOpen: count,
  /**
   * Everyone with work or assigned tickets in the range under the other
   * filters, for the Agent filter: the list does not shrink to the one picked.
   */
  agentChoices: z.array(z.object({ agentId: z.uuid(), name: z.string().nullable() })),
  /** Tickets created per local weekday (ISO, 1 = Monday) and hour; empty cells left out. */
  busiestHours: z.array(
    z.object({ weekday: z.int().min(1).max(7), hour: z.int().min(0).max(23), created: count }),
  ),
  searches: z.object({
    top: z.array(
      z.object({ query: z.string(), locale: localeSchema, searches: count, openedRate: share }),
    ),
    zeroResult: z.array(z.object({ query: z.string(), locale: localeSchema, searches: count })),
  }),
  ai: reportAiSchema,
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/**
 * What a spreadsheet would run as a formula: a cell starting with `=`, `+`,
 * `-` or `@`, and the tab and carriage return OWASP adds because some
 * programs strip them first.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell, safe to open in a spreadsheet: quoted when it has to be, and
 * a value that would start a formula is prefixed with `'` so it is read as
 * text (OWASP, CSV injection).
 */
export const csvCell = (value: string | number | null): string => {
  if (value === null) {
    return '';
  }
  const text = typeof value === 'number' ? String(value) : value;
  const safe = typeof value === 'string' && FORMULA_START.test(text) ? `'${text}` : text;

  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** One CSV line, CRLF-terminated as RFC 4180 has it. */
export const csvLine = (cells: readonly (string | number | null)[]): string =>
  `${cells.map(csvCell).join(',')}\r\n`;
