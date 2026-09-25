import type { RetentionSettings, RetentionUpdateRequest } from '@helpdock/schemas';
import { AUDIT_LOG_MIN_DAYS, RETENTION_MAX_DAYS } from '@helpdock/schemas';

/**
 * The Data retention form's state, apart from the component so the rules can
 * be tested without a DOM.
 *
 * The day counts are held as the strings the inputs hold: a field somebody has
 * just cleared is `''`, which is "not a number yet" rather than zero, and the
 * form says so instead of saving a zero-day window.
 */

export const DAY_FIELDS = [
  'spamTicketDays',
  'aiCallDays',
  'searchLogDays',
  'auditLogDays',
  'visitorSessionDays',
] as const;
export type DayField = (typeof DAY_FIELDS)[number];

export interface RetentionDraft {
  readonly closedMode: 'never' | 'days';
  /** Kept while "Forever" is picked, so flipping back does not lose it. */
  readonly closedDays: string;
  readonly spamTicketDays: string;
  readonly aiCallDays: string;
  readonly searchLogDays: string;
  readonly auditLogDays: string;
  readonly visitorSessionDays: string;
}

export type DraftField = DayField | 'closedDays';

/** What a closed-ticket window starts at when somebody switches away from "Forever". */
export const DEFAULT_CLOSED_DAYS = 730;

export const draftFrom = (settings: RetentionSettings): RetentionDraft => ({
  closedMode: settings.closedTickets.kind,
  closedDays: String(
    settings.closedTickets.kind === 'days' ? settings.closedTickets.days : DEFAULT_CLOSED_DAYS,
  ),
  spamTicketDays: String(settings.spamTicketDays),
  aiCallDays: String(settings.aiCallDays),
  searchLogDays: String(settings.searchLogDays),
  auditLogDays: String(settings.auditLogDays),
  visitorSessionDays: String(settings.visitorSessionDays),
});

/** The smallest window a field accepts: the audit log's 90 days, one for the rest. */
export const minimumFor = (field: DraftField): number =>
  field === 'auditLogDays' ? AUDIT_LOG_MIN_DAYS : 1;

const WHOLE_NUMBER = /^\d+$/;

const validDays = (value: string, min: number): number | undefined => {
  if (!WHOLE_NUMBER.test(value.trim())) {
    return undefined;
  }
  const days = Number(value);

  return days >= min && days <= RETENTION_MAX_DAYS ? days : undefined;
};

/** The fields whose value the api would refuse. The closed-ticket days only count while in use. */
export const invalidFields = (draft: RetentionDraft): DraftField[] => {
  const invalid: DraftField[] = DAY_FIELDS.filter(
    (field) => validDays(draft[field], minimumFor(field)) === undefined,
  );
  if (draft.closedMode === 'days' && validDays(draft.closedDays, 1) === undefined) {
    invalid.unshift('closedDays');
  }

  return invalid;
};

/** The request the form sends, or `undefined` while any field is invalid. */
export const requestFrom = (draft: RetentionDraft): RetentionUpdateRequest | undefined => {
  if (invalidFields(draft).length > 0) {
    return undefined;
  }

  return {
    closedTickets:
      draft.closedMode === 'never'
        ? { kind: 'never' }
        : { kind: 'days', days: Number(draft.closedDays) },
    spamTicketDays: Number(draft.spamTicketDays),
    aiCallDays: Number(draft.aiCallDays),
    searchLogDays: Number(draft.searchLogDays),
    auditLogDays: Number(draft.auditLogDays),
    visitorSessionDays: Number(draft.visitorSessionDays),
  };
};

/**
 * Whether the form differs from what is saved: the Discard and Save buttons
 * wake up on it. The hidden day count is not a difference while both sides
 * keep closed tickets forever, because it is not sent.
 */
export const isDirty = (draft: RetentionDraft, saved: RetentionSettings): boolean => {
  const original = draftFrom(saved);
  const closedDaysHidden = draft.closedMode === 'never' && original.closedMode === 'never';
  const compared = (Object.keys(original) as (keyof RetentionDraft)[]).filter(
    (key) => !(closedDaysHidden && key === 'closedDays'),
  );

  return compared.some((key) => draft[key] !== original[key]);
};
