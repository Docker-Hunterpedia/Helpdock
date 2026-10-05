import { describe, expect, it } from 'vitest';
import {
  csvCell,
  csvLine,
  REPORT_MAX_DAYS,
  reportExportFileName,
  reportQuerySchema,
  reportRangeDays,
  reportSummarySchema,
} from './reports.js';

describe('reportQuerySchema', () => {
  it('accepts a range with optional department and channel filters', () => {
    const query = reportQuerySchema.parse({
      from: '2026-09-01',
      to: '2026-09-30',
      departmentId: '01924f00-0000-7000-8000-0000000000aa',
      channel: 'email',
    });

    expect(query.channel).toBe('email');
  });

  it('refuses a range that ends before it starts', () => {
    expect(reportQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(
      false,
    );
  });

  it('refuses a range longer than a year and a leap day', () => {
    expect(reportQuerySchema.safeParse({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(
      false,
    );
    expect(reportRangeDays('2025-01-01', '2026-01-01')).toBe(366);
    expect(REPORT_MAX_DAYS).toBe(366);
  });

  it('counts both ends of a range', () => {
    expect(reportRangeDays('2026-10-05', '2026-10-05')).toBe(1);
  });
});

describe('csvCell', () => {
  it.each(['=SUM(A1:A9)', '+1', '-1+2', '@cmd', '\tvalue', '\rvalue'])(
    'makes %j text rather than a formula',
    (value) => {
      expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves numbers alone, even negative ones a report never produces', () => {
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(12)).toBe('12');
  });

  it('quotes a cell with a comma, a quote or a line break', () => {
    expect(csvCell('refund, please')).toBe('"refund, please"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('quotes a neutralised formula that also needs quoting', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('writes null as an empty cell', () => {
    expect(csvCell(null)).toBe('');
  });
});

describe('csvLine', () => {
  it('joins cells with commas and ends the line with CRLF', () => {
    expect(csvLine(['day', 1, null])).toBe('day,1,\r\n');
  });
});

describe('reportSummarySchema', () => {
  it('reads AI as unavailable rather than zero until the AI subsystem records calls', () => {
    const ai = reportSummarySchema.shape.ai.parse({ available: false });

    expect(ai).toEqual({ available: false });
  });
});

describe('reportExportFileName', () => {
  it('names the file after the report and the range, with dashes for underscores', () => {
    expect(reportExportFileName('busiest_hours', '2026-09-01', '2026-09-30')).toBe(
      'helpdock-busiest-hours-2026-09-01-2026-09-30.csv',
    );
  });
});
