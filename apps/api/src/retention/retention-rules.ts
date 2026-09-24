import type { NewRetentionSettingsRow, RetentionSettingsRow } from '@helpdock/db';
import { RETENTION_DAYS, retentionCutoff } from '@helpdock/jobs';
import {
  defaultRetentionSettings,
  type RetentionCounts,
  type RetentionLastRun,
  type RetentionSettings,
  retentionCountsSchema,
  retentionTotal,
} from '@helpdock/schemas';

/**
 * The arithmetic of DOMAIN-RULES §11, as pure functions of values the caller
 * has already read: the row ↔ settings mapping, and "older than what?" for each
 * category. Apart from the repository and the job so the rules can be read
 * next to §11 and tested without a database.
 */

/** A brand with no row is kept under the defaults; see `retention_settings`. */
export const settingsFromRow = (row: RetentionSettingsRow | undefined): RetentionSettings => {
  if (row === undefined) {
    return defaultRetentionSettings();
  }

  return {
    closedTickets:
      row.closedTicketDays === null
        ? { kind: 'never' }
        : { kind: 'days', days: row.closedTicketDays },
    spamTicketDays: row.spamTicketDays,
    aiCallDays: row.aiCallDays,
    searchLogDays: row.searchLogDays,
    auditLogDays: row.auditLogDays,
    visitorSessionDays: row.visitorSessionDays,
  };
};

export const rowValuesFrom = (
  settings: RetentionSettings,
): Omit<NewRetentionSettingsRow, 'brandId'> => ({
  closedTicketDays: settings.closedTickets.kind === 'never' ? null : settings.closedTickets.days,
  spamTicketDays: settings.spamTicketDays,
  aiCallDays: settings.aiCallDays,
  searchLogDays: settings.searchLogDays,
  auditLogDays: settings.auditLogDays,
  visitorSessionDays: settings.visitorSessionDays,
});

/**
 * The instant before which each category is purged. `closedTickets` is null
 * for "never", which is §11's default and means the category is skipped
 * entirely rather than purged with an infinitely old cutoff.
 *
 * AI calls, the search log and visitor sessions are absent: their tables do not
 * exist yet (M7, M5, M4). Their windows are stored so the form is whole, and
 * the milestone that creates each table adds its cutoff here.
 */
export interface RetentionCutoffs {
  readonly closedTickets: Date | null;
  readonly spamTickets: Date;
  readonly auditLog: Date;
  readonly outbox: Date;
}

export const retentionCutoffs = (settings: RetentionSettings, now: Date): RetentionCutoffs => ({
  closedTickets:
    settings.closedTickets.kind === 'never'
      ? null
      : retentionCutoff(settings.closedTickets.days, now),
  spamTickets: retentionCutoff(settings.spamTicketDays, now),
  auditLog: retentionCutoff(settings.auditLogDays, now),
  // Fixed by DOMAIN-RULES §6, not by the brand.
  outbox: retentionCutoff(RETENTION_DAYS, now),
});

/**
 * What the form's footer reads. A column an operator edited into something
 * else is treated as "no counts" rather than a 500: the footer is a courtesy.
 */
export const lastRunFrom = (row: RetentionSettingsRow | undefined): RetentionLastRun | null => {
  if (row?.lastRunAt === null || row?.lastRunAt === undefined) {
    return null;
  }

  const parsed = retentionCountsSchema.safeParse(row.lastRunCounts);
  const counts: RetentionCounts = parsed.success ? parsed.data : {};

  return { at: row.lastRunAt.toISOString(), counts, total: retentionTotal(counts) };
};

/** The night a run belongs to: the UTC calendar date of `now`. */
export const runDateOf = (now: Date): string => now.toISOString().slice(0, 10);
