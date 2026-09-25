import type { RetentionSettingsRow } from '@helpdock/db';
import { defaultRetentionSettings } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  lastRunFrom,
  retentionCutoffs,
  rowValuesFrom,
  runDateOf,
  settingsFromRow,
} from './retention-rules.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const NOW = new Date('2026-09-24T03:00:00.000Z');

const row = (changes: Partial<RetentionSettingsRow> = {}): RetentionSettingsRow => ({
  brandId: BRAND,
  closedTicketDays: 730,
  spamTicketDays: 30,
  aiCallDays: 90,
  searchLogDays: 180,
  auditLogDays: 730,
  visitorSessionDays: 30,
  updatedBy: null,
  updatedAt: NOW,
  lastRunAt: null,
  lastRunCounts: {},
  ...changes,
});

describe('settingsFromRow', () => {
  it('keeps a brand with no row under the DOMAIN-RULES §11 defaults', () => {
    expect(settingsFromRow(undefined)).toEqual(defaultRetentionSettings());
  });

  it('reads a null closed-ticket window as "never"', () => {
    expect(settingsFromRow(row({ closedTicketDays: null })).closedTickets).toEqual({
      kind: 'never',
    });
  });

  it('round-trips through the row values', () => {
    const settings = settingsFromRow(row());

    expect(settingsFromRow(row(rowValuesFrom(settings)))).toEqual(settings);
    expect(rowValuesFrom(settingsFromRow(row({ closedTicketDays: null }))).closedTicketDays).toBe(
      null,
    );
  });
});

describe('retentionCutoffs', () => {
  it('skips closed tickets entirely when the brand keeps them forever', () => {
    expect(retentionCutoffs(defaultRetentionSettings(), NOW).closedTickets).toBeNull();
  });

  it('puts each cutoff its own number of days before now', () => {
    const cutoffs = retentionCutoffs(
      { ...defaultRetentionSettings(), closedTickets: { kind: 'days', days: 10 } },
      NOW,
    );

    expect(cutoffs.closedTickets?.toISOString()).toBe('2026-09-14T03:00:00.000Z');
    expect(cutoffs.spamTickets.toISOString()).toBe('2026-08-25T03:00:00.000Z');
    expect(cutoffs.auditLog.toISOString()).toBe('2024-09-24T03:00:00.000Z');
  });

  it('keeps the outbox on the fixed seven days, whatever the brand chose', () => {
    expect(retentionCutoffs(defaultRetentionSettings(), NOW).outbox.toISOString()).toBe(
      '2026-09-17T03:00:00.000Z',
    );
  });
});

describe('lastRunFrom', () => {
  it('is null before the job has ever run for the brand', () => {
    expect(lastRunFrom(undefined)).toBeNull();
    expect(lastRunFrom(row())).toBeNull();
  });

  it('reports when the run finished and what it removed in total', () => {
    const lastRun = lastRunFrom(
      row({ lastRunAt: NOW, lastRunCounts: { closedTickets: 12, spamTickets: 62 } }),
    );

    expect(lastRun).toEqual({
      at: NOW.toISOString(),
      counts: { closedTickets: 12, spamTickets: 62 },
      total: 74,
    });
  });

  it('shows no counts rather than failing when the column holds something else', () => {
    expect(lastRunFrom(row({ lastRunAt: NOW, lastRunCounts: { bogus: -1 } }))?.total).toBe(0);
  });
});

describe('runDateOf', () => {
  it('is the UTC calendar date, so every replica agrees on which night it is', () => {
    expect(runDateOf(new Date('2026-09-24T23:59:59.000-05:00'))).toBe('2026-09-25');
  });
});
