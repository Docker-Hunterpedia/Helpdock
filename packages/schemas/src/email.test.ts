import { describe, expect, it } from 'vitest';
import {
  autoRepliesSchema,
  emailSenderKeySchema,
  emailSendersSchema,
  emailSignatureSchema,
  outgoingSmtpUpdateSchema,
} from './email.js';

const DEPARTMENT = '0190a8a5-7c1e-7000-8000-000000000001';

describe('outgoingSmtpUpdateSchema', () => {
  it('keeps the stored password when none is sent', () => {
    const parsed = outgoingSmtpUpdateSchema.parse({
      host: ' smtp.example.com ',
      port: 465,
      tls: 'tls',
      user: 'support@example.com',
    });

    expect(parsed).toEqual({
      host: 'smtp.example.com',
      port: 465,
      tls: 'tls',
      user: 'support@example.com',
    });
  });

  it('refuses a port outside 1–65535', () => {
    expect(
      outgoingSmtpUpdateSchema.safeParse({ host: 'h', port: 0, tls: 'none', user: '' }).success,
    ).toBe(false);
  });
});

describe('emailSendersSchema', () => {
  const row = {
    departmentId: DEPARTMENT,
    from: { name: 'Billing', address: 'billing@example.com' },
    replyTo: null,
  };

  it('accepts one sender per department', () => {
    expect(emailSendersSchema.safeParse({ defaultFrom: null, departments: [row] }).success).toBe(
      true,
    );
  });

  it('refuses two senders for one department', () => {
    expect(
      emailSendersSchema.safeParse({ defaultFrom: null, departments: [row, row] }).success,
    ).toBe(false);
  });
});

describe('emailSignatureSchema', () => {
  it('drops trailing blank lines before counting', () => {
    expect(emailSignatureSchema.parse({ en: 'Lina\nBilling\n\n', ar: '' })).toEqual({
      en: 'Lina\nBilling',
      ar: '',
    });
  });

  it('refuses a seventh line', () => {
    const result = emailSignatureSchema.safeParse({ en: '1\n2\n3\n4\n5\n6\n7', ar: '' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('too-many-lines');
  });
});

describe('autoRepliesSchema', () => {
  const template = { subject: 'We received it', body: 'Thanks.' };
  const templates = { en: template, ar: template };

  it('bounds the per-sender cap', () => {
    const base = {
      acknowledgment: { enabled: true, templates },
      outOfHours: { enabled: false, templates },
    };

    expect(autoRepliesSchema.safeParse({ ...base, perSenderHourlyCap: 3 }).success).toBe(true);
    expect(autoRepliesSchema.safeParse({ ...base, perSenderHourlyCap: 0 }).success).toBe(false);
    expect(autoRepliesSchema.safeParse({ ...base, perSenderHourlyCap: 51 }).success).toBe(false);
  });
});

describe('emailSenderKeySchema', () => {
  it('is the word default or a department id', () => {
    expect(emailSenderKeySchema.safeParse('default').success).toBe(true);
    expect(emailSenderKeySchema.safeParse(DEPARTMENT).success).toBe(true);
    expect(emailSenderKeySchema.safeParse('billing').success).toBe(false);
  });
});
