import { describe, expect, it } from 'vitest';
import { BILLING, REFUNDS, settingsRow } from '../testing/email-fixtures.js';
import { defaultAutoReplyTemplate } from './email-copy.js';
import {
  autoRepliesFrom,
  DEFAULT_HOURLY_CAP,
  resolveSender,
  selectedSenderKey,
  senderOptions,
  sendersFrom,
  smtpFrom,
  storedTemplatesFrom,
  templatesFor,
} from './outgoing-settings.js';

const install = { name: 'Install', address: 'noreply@install.example' };

describe('autoRepliesFrom', () => {
  it('gives a brand that never saved both replies off, the catalog wording and a cap of three', () => {
    const replies = autoRepliesFrom(undefined);

    expect(replies.acknowledgment.enabled).toBe(false);
    expect(replies.outOfHours.enabled).toBe(false);
    expect(replies.perSenderHourlyCap).toBe(DEFAULT_HOURLY_CAP);
    expect(replies.acknowledgment.templates.en).toEqual(
      defaultAutoReplyTemplate('acknowledgment', 'en'),
    );
  });

  it("uses a brand's own wording where it has one, and the catalog elsewhere", () => {
    const own = { subject: 'Got it', body: 'We have it.' };
    const templates = templatesFor(
      settingsRow({ autoReplyTemplates: { acknowledgment: { ar: own } } }),
      'acknowledgment',
    );

    expect(templates.ar).toEqual(own);
    expect(templates.en).toEqual(defaultAutoReplyTemplate('acknowledgment', 'en'));
  });
});

describe('storedTemplatesFrom', () => {
  it('stores only the wording that differs from the catalog', () => {
    const replies = autoRepliesFrom(undefined);
    const own = { subject: 'Got it', body: 'We have it.' };

    expect(storedTemplatesFrom(replies)).toEqual({});
    expect(
      storedTemplatesFrom({
        ...replies,
        outOfHours: {
          ...replies.outOfHours,
          templates: { ...replies.outOfHours.templates, en: own },
        },
      }),
    ).toEqual({ outOfHours: { en: own } });
  });
});

describe('sendersFrom', () => {
  it('leaves out the sender of a department that no longer exists', () => {
    const senders = sendersFrom(settingsRow(), new Set([REFUNDS]));

    expect(senders.defaultFrom).toEqual({
      name: 'Helpdock Support',
      address: 'support@helpdock.io',
    });
    expect(senders.departments).toEqual([]);
  });

  it('has no default sender until one is saved', () => {
    expect(sendersFrom(undefined, new Set()).defaultFrom).toBeNull();
  });
});

describe('smtpFrom', () => {
  it('is null for a brand that sends through the install', () => {
    expect(smtpFrom(settingsRow(), null)).toBeNull();
  });

  it('says a password is stored without saying what it is', () => {
    const smtp = smtpFrom(
      settingsRow({
        smtpHost: 'smtp.fastmail.com',
        smtpPort: 465,
        smtpTls: 'tls',
        smtpUser: 'support@helpdock.io',
        smtpPassword: 'v1.key.envelope',
        smtpUpdatedAt: new Date('2026-09-14T09:00:00Z'),
      }),
      'Lina Haddad',
    );

    expect(smtp).toEqual({
      host: 'smtp.fastmail.com',
      port: 465,
      tls: 'tls',
      user: 'support@helpdock.io',
      passwordSet: true,
      updatedAt: '2026-09-14T09:00:00.000Z',
      updatedByName: 'Lina Haddad',
    });
  });

  it('reads an unknown TLS mode as STARTTLS, the safe default', () => {
    expect(
      smtpFrom(settingsRow({ smtpHost: 'h', smtpPort: 25, smtpTls: 'weird' }), null)?.tls,
    ).toBe('starttls');
  });
});

describe('resolveSender', () => {
  const row = settingsRow();

  it("sends as the ticket's department when it has a sender", () => {
    expect(resolveSender(row, { departmentId: BILLING }, install)).toEqual({
      from: { name: 'Helpdock Billing', address: 'billing@helpdock.io' },
      replyTo: 'billing-replies@helpdock.io',
    });
  });

  it("falls back to the brand's default, then to the install's", () => {
    expect(resolveSender(row, { departmentId: REFUNDS }, install)?.from.address).toBe(
      'support@helpdock.io',
    );
    expect(resolveSender(undefined, { departmentId: REFUNDS }, install)?.from).toEqual(install);
    expect(resolveSender(undefined, { departmentId: REFUNDS }, undefined)).toBeUndefined();
  });

  it('honours an explicit choice from the composer', () => {
    expect(
      resolveSender(row, { departmentId: BILLING, key: 'default' }, install)?.from.address,
    ).toBe('support@helpdock.io');
    expect(resolveSender(row, { departmentId: REFUNDS, key: BILLING }, install)?.from.address).toBe(
      'billing@helpdock.io',
    );
  });
});

describe('senderOptions and selectedSenderKey', () => {
  it("offers the default first and preselects the department's own", () => {
    const options = senderOptions(settingsRow(), install);

    expect(options.map((option) => option.key)).toEqual(['default', BILLING]);
    expect(selectedSenderKey(BILLING, options)).toBe(BILLING);
    expect(selectedSenderKey(REFUNDS, options)).toBe('default');
  });

  it("offers the install's sender when the brand has none, and nothing when neither does", () => {
    expect(senderOptions(undefined, install)).toEqual([{ key: 'default', from: install }]);
    expect(selectedSenderKey(BILLING, senderOptions(undefined, undefined))).toBeNull();
  });
});
