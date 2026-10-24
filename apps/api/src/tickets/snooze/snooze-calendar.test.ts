import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import type { CalendarRows } from '../../sla/sla.repository.js';
import { snoozePresetResolver } from './snooze-calendar.js';

const NOW = new Date('2026-10-01T10:00:00.000Z');
const DEPARTMENT = '0199f4b2-0000-7000-8000-0000000000d1';
const tx = {} as DbTransaction;

/** No business hours anywhere, so the presets fall back to 09:00 in a zone. */
const rows = (brandTimezone: string): CalendarRows =>
  ({ brandTimezone, brandWeekly: null, overrides: new Map() }) as unknown as CalendarRows;

const resolverFor = (brandTimezone: string) =>
  snoozePresetResolver({ calendarRows: async () => rows(brandTimezone) });

describe('snoozePresetResolver', () => {
  it('falls back to the brand’s zone for a rule, which runs as nobody', async () => {
    const until = await resolverFor('Asia/Riyadh').at(
      tx,
      'b',
      DEPARTMENT,
      'next_business_day',
      NOW,
    );

    expect(until.toISOString()).toBe('2026-10-02T06:00:00.000Z');
  });

  it('uses the applying person’s own zone for a macro when they have one', async () => {
    const until = await resolverFor('Asia/Riyadh').at(
      tx,
      'b',
      DEPARTMENT,
      'next_business_day',
      NOW,
      'America/New_York',
    );

    expect(until.toISOString()).toBe('2026-10-02T13:00:00.000Z');
  });

  it('falls back to the brand’s zone when the person has not chosen one', async () => {
    const until = await resolverFor('Asia/Riyadh').at(
      tx,
      'b',
      DEPARTMENT,
      'next_business_day',
      NOW,
      null,
    );

    expect(until.toISOString()).toBe('2026-10-02T06:00:00.000Z');
  });
});
