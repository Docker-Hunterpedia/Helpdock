import { describe, expect, it } from 'vitest';
import {
  agentSummary,
  backlogByStatus,
  csatAverage,
  csatSummary,
  fillDays,
  openedRate,
  rankTags,
  slaOutcome,
} from './report-math.js';
import type { OpenStatusRow, TagRow } from './reports.repository.js';

describe('slaOutcome', () => {
  it('is met over every outcome', () => {
    expect(slaOutcome(3, 1)).toEqual({ met: 3, breached: 1, compliance: 0.75 });
  });

  it('has no compliance, rather than 0 %, when nothing ended', () => {
    expect(slaOutcome(0, 0).compliance).toBeNull();
  });
});

describe('csatSummary', () => {
  it('averages the ratings and counts 4 and 5 as satisfied', () => {
    const csat = csatSummary([1, 0, 0, 1, 2]);

    expect(csat.responses).toBe(4);
    expect(csat.average).toBe((1 + 4 + 5 + 5) / 4);
    expect(csat.satisfied).toBe(0.75);
    expect(csat.distribution).toEqual([
      { rating: 1, responses: 1 },
      { rating: 2, responses: 0 },
      { rating: 3, responses: 0 },
      { rating: 4, responses: 1 },
      { rating: 5, responses: 2 },
    ]);
  });

  it('has no average when nobody rated', () => {
    const csat = csatSummary([0, 0, 0, 0, 0]);

    expect(csat.average).toBeNull();
    expect(csat.satisfied).toBeNull();
  });
});

describe('fillDays', () => {
  it('gives every day of the range a row, zero where the rollups have none', () => {
    const days = fillDays('2026-10-01', '2026-10-03', [
      { day: '2026-10-02', created: 4, resolved: 1, backlog: 3 },
    ]);

    expect(days).toEqual([
      { day: '2026-10-01', created: 0, resolved: 0, backlog: 0 },
      { day: '2026-10-02', created: 4, resolved: 1, backlog: 3 },
      { day: '2026-10-03', created: 0, resolved: 0, backlog: 0 },
    ]);
  });
});

describe('openedRate', () => {
  it('is opened over searched, capped at one, and null for no searches', () => {
    expect(openedRate(1, 4)).toBe(0.25);
    expect(openedRate(5, 4)).toBe(1);
    expect(openedRate(0, 0)).toBeNull();
  });
});

describe('agentSummary', () => {
  const row = {
    agentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1',
    name: 'Omar',
    replies: 4,
    resolved: 2,
    assignedOpen: 1,
    firstResponse: { count: 2, medianMs: 60_000 },
    resolution: { count: 0, medianMs: null },
    slaMet: 3,
    slaBreached: 1,
    csatResponses: 2,
    csatPoints: 9,
  };

  it('turns the sums into an SLA share and a CSAT average', () => {
    expect(agentSummary(row)).toMatchObject({
      sla: { met: 3, breached: 1, compliance: 0.75 },
      csat: { responses: 2, average: 4.5 },
      resolution: { count: 0, medianMs: null },
    });
  });

  it('has no average, rather than zero, for an agent nobody rated', () => {
    expect(csatAverage(0, 0)).toBeNull();
    expect(agentSummary({ ...row, csatResponses: 0, csatPoints: 0 }).csat.average).toBeNull();
  });
});

describe('rankTags', () => {
  const tag = (name: string, tickets: number, tagId = `id-${name}`): TagRow => ({
    tagId,
    name,
    nameAr: null,
    tickets,
  });

  it('puts the most used tag first, and breaks a tie by name, then by id', () => {
    const ranked = rankTags(
      [tag('vip', 4), tag('shipping', 9), tag('refund', 9), tag('vip', 4, 'id-a')],
      null,
    );

    expect(ranked.map((row) => [row.name, row.tagId])).toEqual([
      ['refund', 'id-refund'],
      ['shipping', 'id-shipping'],
      ['vip', 'id-a'],
      ['vip', 'id-vip'],
    ]);
  });

  it('cuts at the limit, keeping the most used, and keeps every tag without one', () => {
    const rows = Array.from({ length: 23 }, (_unused, index) => tag(`t${index}`, index + 1));

    const top = rankTags(rows, 20);

    expect(top).toHaveLength(20);
    expect(top[0]?.tickets).toBe(23);
    expect(top.at(-1)?.tickets).toBe(4);
    expect(rankTags(rows, null)).toHaveLength(23);
  });

  it('leaves the rows it was given in their order', () => {
    const rows = [tag('a', 1), tag('b', 2)];

    rankTags(rows, 1);

    expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
  });
});

describe('backlogByStatus', () => {
  const status = (name: string, open: number, unassigned: number): OpenStatusRow => ({
    statusId: `id-${name}`,
    name,
    nameAr: null,
    systemState: 'open',
    open,
    unassigned,
  });

  it('totals the open and unassigned tickets and gives the unassigned share', () => {
    const backlog = backlogByStatus([
      status('Open', 64, 12),
      status('Awaiting customer', 38, 0),
      status('On hold', 9, 2),
      status('Snoozed', 7, 0),
    ]);

    expect(backlog).toMatchObject({ open: 118, unassigned: 14 });
    expect(backlog.unassignedShare).toBeCloseTo(14 / 118, 10);
    expect(backlog.byStatus.map((row) => row.name)).toEqual([
      'Open',
      'Awaiting customer',
      'On hold',
      'Snoozed',
    ]);
  });

  it('has no share, rather than 0 %, when nothing is open', () => {
    expect(backlogByStatus([])).toEqual({
      open: 0,
      unassigned: 0,
      unassignedShare: null,
      byStatus: [],
    });
  });

  it('is a share of 1 when every open ticket is unassigned', () => {
    expect(backlogByStatus([status('Open', 3, 3)]).unassignedShare).toBe(1);
  });
});
