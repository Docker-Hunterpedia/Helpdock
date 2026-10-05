import type { EmailDelivery, EmailOutboundSettings } from '@helpdock/db';

/** Rows for the email module's unit tests. Not imported by production code. */

export const BRAND = '0190a8a5-7c1e-7000-8000-00000000b001';
export const BILLING = '0190a8a5-7c1e-7000-8000-00000000d001';
export const REFUNDS = '0190a8a5-7c1e-7000-8000-00000000d002';
export const TICKET = '0190a8a5-7c1e-7000-8000-00000000a001';
export const MESSAGE = '0190a8a5-7c1e-7000-8000-00000000e001';
export const DELIVERY = '0190a8a5-7c1e-7000-8000-00000000f001';
/** Three more delivery ids, for the tests that need several rows. */
export const ROW_A = '0190a8a5-7c1e-7000-8000-0000000001a0';
export const ROW_B = '0190a8a5-7c1e-7000-8000-0000000001b0';
export const ROW_C = '0190a8a5-7c1e-7000-8000-0000000001c0';
export const USER = '0190a8a5-7c1e-7000-8000-00000000c001';

export const settingsRow = (
  overrides: Partial<EmailOutboundSettings> = {},
): EmailOutboundSettings => ({
  brandId: BRAND,
  smtpHost: null,
  smtpPort: null,
  smtpTls: null,
  smtpUser: null,
  smtpPassword: null,
  smtpUpdatedAt: null,
  smtpUpdatedBy: null,
  defaultFromName: 'Helpdock Support',
  defaultFromAddress: 'support@helpdock.io',
  departmentSenders: [
    {
      departmentId: BILLING,
      fromName: 'Helpdock Billing',
      fromAddress: 'billing@helpdock.io',
      replyTo: 'billing-replies@helpdock.io',
    },
  ],
  acknowledgmentEnabled: false,
  outOfHoursEnabled: false,
  autoReplyTemplates: {},
  autoReplyHourlyCap: 3,
  updatedAt: new Date('2026-09-20T10:00:00Z'),
  ...overrides,
});

export const deliveryRow = (overrides: Partial<EmailDelivery> = {}): EmailDelivery => ({
  id: DELIVERY,
  brandId: BRAND,
  departmentId: BILLING,
  ticketId: TICKET,
  ticketMessageId: MESSAGE,
  csatResponseId: null,
  kind: 'reply',
  fromName: 'Helpdock Billing',
  fromAddress: 'billing@helpdock.io',
  replyTo: 'billing-replies@helpdock.io',
  toName: 'Mona Khalil',
  toAddress: 'mona@example.com',
  ccAddresses: ['karim@acme.de'],
  locale: 'en',
  messageId: `<hd.m.${MESSAGE}@helpdock.io>`,
  status: 'queued',
  attempts: 0,
  lastError: null,
  sentAt: null,
  failedAt: null,
  createdAt: new Date('2026-09-20T10:00:00Z'),
  updatedAt: new Date('2026-09-20T10:00:00Z'),
  ...overrides,
});
