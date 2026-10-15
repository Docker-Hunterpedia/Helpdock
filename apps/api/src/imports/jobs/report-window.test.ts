import { describe, expect, it } from 'vitest';
import { importReportWindow, nextImportReportChunk } from './report-window.js';

describe('import report windows', () => {
  it('caps old history at 400 inclusive local days unless explicitly opted in', () => {
    expect(
      importReportWindow({ firstDay: '2019-01-01', today: '2026-10-14', rebuildAllReports: false }),
    ).toEqual({ from: '2025-09-10', to: '2026-10-14', clipped: true });
    expect(
      importReportWindow({ firstDay: '2019-01-01', today: '2026-10-14', rebuildAllReports: true }),
    ).toEqual({ from: '2019-01-01', to: '2026-10-14', clipped: false });
  });
  it('keeps recent history and handles runs without tickets', () => {
    expect(
      importReportWindow({ firstDay: '2026-10-13', today: '2026-10-14', rebuildAllReports: false }),
    ).toEqual({ from: '2026-10-13', to: '2026-10-14', clipped: false });
    expect(
      importReportWindow({ firstDay: null, today: '2026-10-14', rebuildAllReports: true }),
    ).toEqual({ from: null, to: '2026-10-14', clipped: false });
  });
  it('cuts 31-day chunks across month boundaries without overlapping the next chunk', () => {
    const progress = {
      from: '2020-02-01',
      to: '2020-03-04',
      next: '2020-02-01',
      timezone: 'UTC',
      countReopens: false,
      clipped: false,
    };
    expect(nextImportReportChunk(progress)).toEqual({
      range: { from: '2020-02-01', to: '2020-03-02' },
      next: '2020-03-03',
    });
    expect(nextImportReportChunk({ ...progress, next: '2020-03-03' })).toEqual({
      range: { from: '2020-03-03', to: '2020-03-04' },
      next: null,
    });
    expect(nextImportReportChunk({ ...progress, next: null })).toBeNull();
  });
  it('refuses future source days and invalid or regressed checkpoint dates', () => {
    expect(() =>
      importReportWindow({ firstDay: '2026-10-15', today: '2026-10-14', rebuildAllReports: true }),
    ).toThrow('import.future-report-date');
    for (const next of ['2020-01-01', '2020-04-01', '2020-02-30']) {
      expect(() =>
        nextImportReportChunk({
          from: '2020-02-01',
          to: '2020-03-04',
          next,
          timezone: 'UTC',
          countReopens: false,
          clipped: false,
        }),
      ).toThrow();
    }
  });
});
