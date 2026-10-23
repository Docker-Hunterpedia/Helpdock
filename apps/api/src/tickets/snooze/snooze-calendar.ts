import type { DbTransaction } from '@helpdock/db';
import type { BusinessCalendar, SnoozePresetKey } from '@helpdock/schemas';
import { buildCalendars } from '../../sla/calendars.js';
import type { CalendarRows, SlaRepository } from '../../sla/sla.repository.js';
import { snoozePresetAt } from './snooze-presets.js';

/**
 * The calendar the Snooze menu and the `snooze` action (#368) resolve against:
 * the department's own hours if anybody saved them, else none at all — never
 * the always-open default, which would make "Next business day" mean "tomorrow".
 * This is `SnoozeService.presets`' rule, kept beside the resolver so a rule
 * and the menu cannot drift.
 */
export const departmentCalendar = (
  rows: CalendarRows,
  departmentId: string,
): BusinessCalendar | null => {
  const configured = rows.overrides.has(departmentId) || rows.brandWeekly !== null;

  return configured ? buildCalendars(rows)('business', departmentId) : null;
};

/** What the resolver needs of the SLA repository, so a unit test can stand in. */
export interface CalendarReader {
  readonly calendarRows: (tx: DbTransaction, brandId: string) => Promise<CalendarRows>;
}

export interface SnoozeResolver {
  /**
   * One Snooze-menu preset for a ticket's department as an instant. Where the
   * menu falls back to the asking agent's zone, a rule or a macro — which run
   * as nobody — falls back to the brand's own.
   */
  at(
    tx: DbTransaction,
    brandId: string,
    departmentId: string,
    preset: SnoozePresetKey,
    now: Date,
  ): Promise<Date>;
}

export const snoozePresetResolver = (sla: Pick<SlaRepository, 'calendarRows'>): SnoozeResolver => ({
  at: async (tx, brandId, departmentId, preset, now) => {
    const rows = await sla.calendarRows(tx, brandId);

    return snoozePresetAt({
      now,
      preset,
      agentTimeZone: rows.brandTimezone,
      calendar: departmentCalendar(rows, departmentId),
    });
  },
});
