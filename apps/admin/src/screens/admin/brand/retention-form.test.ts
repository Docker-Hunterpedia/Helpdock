import { defaultRetentionSettings, type RetentionSettings } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOSED_DAYS,
  draftFrom,
  invalidFields,
  isDirty,
  minimumFor,
  requestFrom,
} from './retention-form.js';

const SAVED: RetentionSettings = {
  ...defaultRetentionSettings(),
  closedTickets: { kind: 'days', days: 365 },
};

describe('draftFrom', () => {
  it('holds every window as the text its input shows', () => {
    expect(draftFrom(SAVED)).toMatchObject({
      closedMode: 'days',
      closedDays: '365',
      auditLogDays: '730',
    });
  });

  it('offers a sensible number of days to a brand that keeps closed tickets forever', () => {
    expect(draftFrom(defaultRetentionSettings()).closedDays).toBe(String(DEFAULT_CLOSED_DAYS));
  });
});

describe('invalidFields and requestFrom', () => {
  it('turns a valid draft into the whole request', () => {
    expect(requestFrom(draftFrom(SAVED))).toEqual(SAVED);
  });

  it('sends "never" and ignores the day count while "Forever" is picked', () => {
    const draft = { ...draftFrom(SAVED), closedMode: 'never' as const, closedDays: '' };

    expect(invalidFields(draft)).toEqual([]);
    expect(requestFrom(draft)?.closedTickets).toEqual({ kind: 'never' });
  });

  it.each([
    ['an audit log below the 90-day minimum', { auditLogDays: '89' }, 'auditLogDays'],
    ['an emptied field', { spamTicketDays: '' }, 'spamTicketDays'],
    ['a fraction', { aiCallDays: '1.5' }, 'aiCallDays'],
    ['more than ten years', { searchLogDays: '3651' }, 'searchLogDays'],
    ['zero closed-ticket days', { closedDays: '0' }, 'closedDays'],
  ])('refuses %s', (_label, change, field) => {
    const draft = { ...draftFrom(SAVED), ...change };

    expect(invalidFields(draft)).toContain(field);
    expect(requestFrom(draft)).toBeUndefined();
  });

  it('names the minimum each field is checked against', () => {
    expect(minimumFor('auditLogDays')).toBe(90);
    expect(minimumFor('spamTicketDays')).toBe(1);
  });
});

describe('isDirty', () => {
  it('is clean until something changes', () => {
    expect(isDirty(draftFrom(SAVED), SAVED)).toBe(false);
    expect(isDirty({ ...draftFrom(SAVED), spamTicketDays: '14' }, SAVED)).toBe(true);
  });

  it('ignores the hidden day count while both sides say "Forever"', () => {
    const saved = defaultRetentionSettings();

    expect(isDirty({ ...draftFrom(saved), closedDays: '12' }, saved)).toBe(false);
  });
});
