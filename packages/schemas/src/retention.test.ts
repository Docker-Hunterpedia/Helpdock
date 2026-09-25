import { describe, expect, it } from 'vitest';
import {
  AUDIT_LOG_MIN_DAYS,
  defaultRetentionSettings,
  RETENTION_MAX_DAYS,
  retentionSettingsSchema,
  retentionTotal,
  retentionUpdateRequestSchema,
} from './retention.js';

const WHOLE_FORM = {
  closedTickets: { kind: 'days', days: 730 },
  spamTicketDays: 30,
  aiCallDays: 90,
  searchLogDays: 180,
  auditLogDays: 730,
  visitorSessionDays: 30,
} as const;

describe('retentionSettingsSchema', () => {
  it('fills in the DOMAIN-RULES §11 defaults for a brand that never saved the form', () => {
    expect(defaultRetentionSettings()).toEqual({
      closedTickets: { kind: 'never' },
      spamTicketDays: 30,
      aiCallDays: 90,
      searchLogDays: 180,
      auditLogDays: 730,
      visitorSessionDays: 30,
    });
  });

  it('keeps a stored value that predates a key and fills only the missing key', () => {
    expect(retentionSettingsSchema.parse({ spamTicketDays: 14 })).toMatchObject({
      spamTicketDays: 14,
      auditLogDays: 730,
    });
  });
});

describe('retentionUpdateRequestSchema', () => {
  it('accepts the whole form', () => {
    expect(retentionUpdateRequestSchema.parse(WHOLE_FORM)).toEqual(WHOLE_FORM);
  });

  it('accepts "never" for closed tickets', () => {
    const parsed = retentionUpdateRequestSchema.parse({
      ...WHOLE_FORM,
      closedTickets: { kind: 'never' },
    });

    expect(parsed.closedTickets).toEqual({ kind: 'never' });
  });

  it('refuses an audit log window shorter than the 90-day minimum', () => {
    const result = retentionUpdateRequestSchema.safeParse({
      ...WHOLE_FORM,
      auditLogDays: AUDIT_LOG_MIN_DAYS - 1,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['auditLogDays']);
  });

  it.each([
    ['zero days', { spamTicketDays: 0 }],
    ['a fraction of a day', { aiCallDays: 1.5 }],
    ['more than ten years', { searchLogDays: RETENTION_MAX_DAYS + 1 }],
    ['a closed-ticket window of no days', { closedTickets: { kind: 'days', days: 0 } }],
  ])('refuses %s', (_label, change) => {
    expect(retentionUpdateRequestSchema.safeParse({ ...WHOLE_FORM, ...change }).success).toBe(
      false,
    );
  });

  it('refuses a half-sent form rather than resetting what it left out', () => {
    const { visitorSessionDays: _omitted, ...partial } = WHOLE_FORM;

    expect(retentionUpdateRequestSchema.safeParse(partial).success).toBe(false);
  });
});

describe('retentionTotal', () => {
  it('adds up a run across categories', () => {
    expect(retentionTotal({ closedTickets: 12, spamTickets: 62, auditLog: 0 })).toBe(74);
  });

  it('is zero for a run that removed nothing', () => {
    expect(retentionTotal({})).toBe(0);
  });
});
