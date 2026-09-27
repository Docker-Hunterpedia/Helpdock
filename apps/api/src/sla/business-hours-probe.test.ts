import type { DbTransaction } from '@helpdock/db';
import type { BusinessCalendar } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { businessHoursProbe } from './business-hours-probe.js';

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const DEPARTMENT = '01937f5e-7e53-7000-8000-0000000000d1';
const tx = {} as DbTransaction;

// Sunday 10:00–14:00 in Riyadh (UTC+3), nothing else.
const calendar: BusinessCalendar = {
  timezone: 'Asia/Riyadh',
  weekly: [[{ start: '10:00', end: '14:00' }], [], [], [], [], [], []],
  holidays: [],
};

const probeFor = () => {
  const calendarFor = vi.fn().mockResolvedValue(calendar);
  return { calendarFor, probe: businessHoursProbe({ calendarFor }) };
};

describe('businessHoursProbe', () => {
  it("reads the department's calendar in the caller's transaction", async () => {
    const { calendarFor, probe } = probeFor();

    await probe.isOpen(tx, { brandId: BRAND, departmentId: DEPARTMENT, at: new Date() });

    expect(calendarFor).toHaveBeenCalledWith(BRAND, DEPARTMENT, tx);
  });

  it('is open inside the hours', async () => {
    const { probe } = probeFor();
    // Sunday 2027-01-03 11:00 Riyadh.
    const at = new Date('2027-01-03T08:00:00Z');

    await expect(probe.isOpen(tx, { brandId: BRAND, departmentId: DEPARTMENT, at })).resolves.toBe(
      true,
    );
  });

  it('is closed outside them', async () => {
    const { probe } = probeFor();
    // Monday 2027-01-04 11:00 Riyadh.
    const at = new Date('2027-01-04T08:00:00Z');

    await expect(probe.isOpen(tx, { brandId: BRAND, departmentId: DEPARTMENT, at })).resolves.toBe(
      false,
    );
  });
});
