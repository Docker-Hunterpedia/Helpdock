import { canSeeDepartment, type StaffFacts } from './recipients.js';

/**
 * The send-time re-check of DOMAIN-RULES §20, for one row of one batch. A
 * batch may wait minutes, hours or a day; everything that could have changed
 * since the notification was made is asked again here, and a row that fails
 * is marked with the reason and never sent later.
 */

export type EmailSchedule = 'immediate' | 'hourly' | 'daily' | 'off';

/** The person's email choices, as `notification_prefs` holds them, with defaults for no row. */
export interface EmailPreferences {
  readonly schedule: EmailSchedule;
  readonly digestHour: number;
  readonly pausedUntil: Date | null;
  readonly unsubscribedAt: Date | null;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = Object.freeze({
  schedule: 'immediate',
  digestHour: 8,
  pausedUntil: null,
  unsubscribedAt: null,
});

export const isPaused = (preferences: EmailPreferences, now: Date): boolean =>
  preferences.pausedUntil !== null && preferences.pausedUntil > now;

/** Off by choice: the schedule is Off, or they unsubscribed (M14-11). */
export const isEmailOff = (preferences: EmailPreferences): boolean =>
  preferences.schedule === 'off' || preferences.unsubscribedAt !== null;

export interface RowFacts {
  readonly readAt: Date | null;
  /** The row's own `email` flag: the choice in force when it was made. */
  readonly email: boolean;
  /** The ticket's department, or null when the ticket is gone. */
  readonly ticketDepartmentId: string | null;
}

export type RowVerdict =
  | 'send'
  | 'skipped_scope'
  | 'skipped_read'
  | 'skipped_off'
  | 'skipped_paused';

/**
 * Whether one row may still be emailed. Scope comes first: a person who may
 * no longer see the ticket is told nothing about it, whatever else is true.
 * `recipient` is undefined when they no longer hold a role in the brand.
 */
export const verdictFor = ({
  row,
  recipient,
  preferences,
  now,
}: {
  readonly row: RowFacts;
  readonly recipient: StaffFacts | undefined;
  readonly preferences: EmailPreferences;
  readonly now: Date;
}): RowVerdict => {
  if (
    recipient === undefined ||
    row.ticketDepartmentId === null ||
    !canSeeDepartment(recipient, row.ticketDepartmentId)
  ) {
    return 'skipped_scope';
  }
  if (row.readAt !== null) {
    return 'skipped_read';
  }
  if (!row.email || isEmailOff(preferences)) {
    return 'skipped_off';
  }
  if (isPaused(preferences, now)) {
    return 'skipped_paused';
  }

  return 'send';
};
