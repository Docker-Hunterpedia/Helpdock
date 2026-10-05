import { describe, expect, it } from 'vitest';
import {
  agentSummary,
  csatAverage,
  csatSummary,
  fillDays,
  openedRate,
  slaOutcome,
} from './report-math.js';

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
