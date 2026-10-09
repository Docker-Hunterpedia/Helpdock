import type { DbTransaction } from '@helpdock/db';
import { defaultWeeklyHours } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { BusinessHoursService } from './business-hours.service.js';
import type { CalendarRows, SlaRepository } from './sla.repository.js';
import type { SlaService } from './sla.service.js';

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const SUPPORT = '01937f5e-7e53-7000-8000-0000000000d1';
const SALES = '01937f5e-7e53-7000-8000-0000000000d2';
const tx = {} as DbTransaction;

// Sunday to Thursday, 09:00–17:00, in Riyadh: the Gulf working week.
const gulfWeek = Array.from({ length: 7 }, (_, day) =>
  day <= 4 ? [{ start: '09:00', end: '17:00' }] : [],
);

const serviceOver = (rows: CalendarRows) => {
  const calendarRows = vi.fn().mockResolvedValue(rows);
  const service = new BusinessHoursService(
    { calendarRows } as unknown as SlaRepository,
    {} as SlaService,
  );
  return { calendarRows, service };
};

describe('BusinessHoursService.calendarsFor', () => {
  const rows: CalendarRows = {
    brandTimezone: 'Europe/Berlin',
    brandWeekly: null,
    overrides: new Map([[SUPPORT, { timezone: 'Asia/Riyadh', weekly: gulfWeek }]]),
    holidays: [
      { startsOn: '2026-12-25', endsOn: '2026-12-25', departmentId: null },
      { startsOn: '2026-12-26', endsOn: '2026-12-26', departmentId: SALES },
    ],
  };

  it('reads the calendar rows once, however many departments it is asked about', async () => {
    const { calendarRows, service } = serviceOver(rows);

    const calendarOf = await service.calendarsFor(BRAND, tx);
    calendarOf(SUPPORT);
    calendarOf(SALES);

    expect(calendarRows).toHaveBeenCalledTimes(1);
    expect(calendarRows).toHaveBeenCalledWith(tx, BRAND);
  });

  it('gives a department its own hours and zone when it has an override', async () => {
    const { service } = serviceOver(rows);

    const calendar = (await service.calendarsFor(BRAND, tx))(SUPPORT);

    expect(calendar).toMatchObject({ timezone: 'Asia/Riyadh', weekly: gulfWeek });
  });

  it('falls back to the brand’s zone, the default week and the holidays that apply', async () => {
    const { service } = serviceOver(rows);

    const calendar = (await service.calendarsFor(BRAND, tx))(SALES);

    expect(calendar.timezone).toBe('Europe/Berlin');
    expect(calendar.weekly).toEqual(defaultWeeklyHours());
    expect(calendar.holidays).toEqual([
      { startsOn: '2026-12-25', endsOn: '2026-12-25', departmentId: null },
      { startsOn: '2026-12-26', endsOn: '2026-12-26', departmentId: SALES },
    ]);
  });

  it('answers with the same calendar as calendarFor for that department', async () => {
    const { service } = serviceOver(rows);

    const fromList = (await service.calendarsFor(BRAND, tx))(SUPPORT);

    expect(fromList).toEqual(await service.calendarFor(BRAND, SUPPORT, tx));
  });
});
