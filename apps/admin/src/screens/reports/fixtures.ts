import type { ReportQuery, ReportSummary } from '@helpdock/schemas';
import type { ReportsApi } from '../../reports/api.js';
import { daysOf, isoDay } from './report-range.js';

/**
 * A month of reports for one brand, as `GET /api/brands/:brandId/reports`
 * answers it. The unit tests and the Playwright stubs both build from it, so
 * the contract breaks both in one place.
 */

const SUPPORT_STATUS = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';
const WAITING_STATUS = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';

export const LINA = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
export const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

export const reportSummary = (
  query: Pick<ReportQuery, 'from' | 'to'> = { from: '2026-09-05', to: '2026-10-04' },
  overrides: Partial<ReportSummary> = {},
): ReportSummary => {
  const days = daysOf(query);

  return {
    range: { from: query.from, to: query.to, timezone: 'Asia/Amman' },
    filters: { departmentId: null, channel: null, agentId: null },
    computedAt: '2026-10-04T04:00:00.000Z',
    volume: {
      created: days.length * 34,
      resolved: days.length * 30,
      byDay: days.map((day, index) => ({ day, created: 30 + (index % 9), resolved: 30 })),
      byChannel: [
        { channel: 'email', created: days.length * 15, resolved: days.length * 13 },
        { channel: 'chat', created: days.length * 12, resolved: days.length * 11 },
        { channel: 'telegram', created: days.length * 7, resolved: days.length * 6 },
      ],
      byPriority: [
        { priority: 'urgent', created: days.length * 3, resolved: days.length * 3 },
        { priority: 'medium', created: days.length * 31, resolved: days.length * 27 },
      ],
      byStatus: [
        { statusId: SUPPORT_STATUS, name: 'Open', systemState: 'open', tickets: 142 },
        { statusId: WAITING_STATUS, name: 'Closed', systemState: 'closed', tickets: 896 },
      ],
      byDayAndChannel: days.flatMap((day, index) => [
        { day, channel: 'email' as const, created: 15 },
        { day, channel: 'chat' as const, created: 12 },
        { day, channel: 'telegram' as const, created: 3 + (index % 9) },
      ]),
      byDayAndPriority: days.flatMap((day, index) => [
        { day, priority: 'urgent' as const, created: 3 },
        { day, priority: 'medium' as const, created: 27 + (index % 9) },
      ]),
      byDayAndStatus: days.flatMap((day, index) => [
        { day, statusId: SUPPORT_STATUS, tickets: 4 },
        { day, statusId: WAITING_STATUS, tickets: 26 + (index % 9) },
      ]),
    },
    firstResponse: { count: 980, medianMs: 42 * 60_000, p90Ms: 190 * 60_000 },
    resolution: { count: 860, medianMs: 495 * 60_000, p90Ms: 2320 * 60_000 },
    sla: {
      response: { met: 597, breached: 31, compliance: 597 / 628 },
      resolution: { met: 520, breached: 48, compliance: 520 / 568 },
      byPriority: [
        { priority: 'urgent', met: 81, breached: 13, compliance: 81 / 94 },
        { priority: 'medium', met: 566, breached: 32, compliance: 566 / 598 },
      ],
      countsReopens: false,
    },
    backlog: days.map((day, index) => ({ day, open: 128 + Math.round(index / 2) })),
    csat: {
      responses: 212,
      average: 4.5,
      satisfied: 182 / 212,
      distribution: [
        { rating: 5, responses: 141 },
        { rating: 4, responses: 41 },
        { rating: 3, responses: 14 },
        { rating: 2, responses: 7 },
        { rating: 1, responses: 9 },
      ],
    },
    agents: [
      {
        agentId: LINA,
        name: 'Lina Haddad',
        replies: 486,
        resolved: 214,
        assignedOpen: 18,
        firstResponse: { count: 230, medianMs: 31 * 60_000 },
        resolution: { count: 214, medianMs: 440 * 60_000 },
        sla: { met: 410, breached: 21, compliance: 410 / 431 },
        csat: { responses: 61, average: 4.7 },
      },
      {
        agentId: OMAR,
        name: 'Omar',
        replies: 452,
        resolved: 198,
        assignedOpen: 24,
        firstResponse: { count: 0, medianMs: null },
        resolution: { count: 198, medianMs: 545 * 60_000 },
        sla: { met: 0, breached: 0, compliance: null },
        csat: { responses: 0, average: null },
      },
    ],
    unassignedOpen: 57,
    agentChoices: [
      { agentId: LINA, name: 'Lina Haddad' },
      { agentId: OMAR, name: 'Omar' },
    ],
    busiestHours: [
      { weekday: 1, hour: 10, created: 26 },
      { weekday: 1, hour: 11, created: 20 },
      { weekday: 4, hour: 14, created: 12 },
    ],
    searches: {
      top: [
        { query: 'refund policy', locale: 'en', searches: 214, openedRate: 0.68 },
        { query: 'إرجاع المنتج', locale: 'ar', searches: 81, openedRate: 0.63 },
      ],
      zeroResult: [{ query: 'gift card balance', locale: 'en', searches: 22 }],
    },
    ai: { available: false },
    ...overrides,
  };
};

/** The month before, a little quieter and a little slower. */
export const previousSummary = (query: Pick<ReportQuery, 'from' | 'to'>): ReportSummary => {
  const summary = reportSummary(query);

  return {
    ...summary,
    volume: { ...summary.volume, created: Math.round(summary.volume.created / 1.08) },
    firstResponse: { ...summary.firstResponse, medianMs: 48 * 60_000 },
    sla: {
      ...summary.sla,
      response: { met: 600, breached: 20, compliance: 600 / 620 },
      resolution: { met: 530, breached: 40, compliance: 530 / 570 },
    },
  };
};

/**
 * Answers a range ending today as the current period and any other as the
 * one before it, as the page asks for both.
 */
export const fakeReportsApi = (overrides: Partial<ReportsApi> = {}): ReportsApi => ({
  summary: async (_brandId, query) =>
    query.to === isoDay(new Date()) ? reportSummary(query) : previousSummary(query),
  exportCsv: async () => new Blob(['day,created\r\n'], { type: 'text/csv' }),
  ...overrides,
});
