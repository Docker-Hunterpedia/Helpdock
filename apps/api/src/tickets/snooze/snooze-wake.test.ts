import { describe, expect, it } from 'vitest';
import {
  SNOOZE_EVENTS,
  snoozeEndedPayloadSchema,
  ticketSnoozedPayloadSchema,
} from './snooze-events.js';
import { isSnoozedStatus, snoozeValues, WAKE_VALUES } from './snooze-wake.js';

const OPEN = '01937f5e-7e53-7000-8000-000000000021';
const AWAITING = '01937f5e-7e53-7000-8000-000000000022';
const SNOOZED = '01937f5e-7e53-7000-8000-000000000023';
const USER = '01937f5e-7e53-7000-8000-000000000001';
const UNTIL = new Date('2026-10-25T09:00:00.000Z');

describe('snoozeValues', () => {
  it('remembers the status the ticket is in when it is not yet snoozed', () => {
    expect(
      snoozeValues({
        ticket: { statusId: AWAITING, snoozeResumeStatusId: null, snoozedUntil: null },
        snoozedStatusId: SNOOZED,
        until: UNTIL,
        snoozedBy: USER,
      }),
    ).toEqual({
      statusId: SNOOZED,
      snoozedUntil: UNTIL,
      snoozedBy: USER,
      snoozeResumeStatusId: AWAITING,
    });
  });

  it('keeps the status before the first snooze when it is snoozed again, not Snoozed itself', () => {
    const values = snoozeValues({
      ticket: { statusId: SNOOZED, snoozeResumeStatusId: OPEN, snoozedUntil: UNTIL },
      snoozedStatusId: SNOOZED,
      until: new Date(UNTIL.getTime() + 3_600_000),
      snoozedBy: USER,
    });

    expect(values.snoozeResumeStatusId).toBe(OPEN);
  });

  it('records nobody when an api key snoozed it', () => {
    expect(
      snoozeValues({
        ticket: { statusId: OPEN, snoozeResumeStatusId: null, snoozedUntil: null },
        snoozedStatusId: SNOOZED,
        until: UNTIL,
        snoozedBy: null,
      }).snoozedBy,
    ).toBeNull();
  });
});

describe('snooze helpers', () => {
  it('clears all three columns on a wake', () => {
    expect(WAKE_VALUES).toEqual({
      snoozedUntil: null,
      snoozedBy: null,
      snoozeResumeStatusId: null,
    });
  });

  it('knows Snoozed by its key, not by its name', () => {
    expect(isSnoozedStatus({ systemKey: 'snoozed' })).toBe(true);
    expect(isSnoozedStatus({ systemKey: 'spam' })).toBe(false);
    expect(isSnoozedStatus({ systemKey: null })).toBe(false);
  });
});

describe('the snooze events', () => {
  it('names the two outbox events', () => {
    expect(SNOOZE_EVENTS).toEqual({ snoozed: 'ticket.snoozed', ended: 'ticket.snooze_ended' });
  });

  it('carries ids, a version and an instant, and nothing else a worker should not read', () => {
    const parsed = ticketSnoozedPayloadSchema.parse({
      ticketId: OPEN,
      departmentId: AWAITING,
      version: 2,
      snoozedUntil: UNTIL.toISOString(),
      subject: 'a secret subject',
    });

    expect(parsed).not.toHaveProperty('subject');
  });

  it('accepts a time or SLA ending, with nobody to tell as null, and refuses any other cause', () => {
    const base = { ticketId: OPEN, departmentId: AWAITING, snoozedBy: null };

    expect(snoozeEndedPayloadSchema.parse({ ...base, cause: 'sla' }).cause).toBe('sla');
    expect(() => snoozeEndedPayloadSchema.parse({ ...base, cause: 'customer_reply' })).toThrow();
  });
});
