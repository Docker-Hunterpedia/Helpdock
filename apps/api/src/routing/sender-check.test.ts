import { describe, expect, it } from 'vitest';
import type { ResolvedEntry } from './entry-points.js';
import { isAutomated, senderIdentity } from './sender-check.js';

const entry = (overrides: Partial<ResolvedEntry>): ResolvedEntry => ({
  entry: 'mailbox',
  entryId: '0199f4b2-0000-7000-8000-0000000000a1',
  label: 'billing@helpdock.test',
  platform: null,
  externalId: null,
  channel: 'email',
  departmentId: '0199f4b2-0000-7000-8000-0000000000d1',
  reason: 'entry_department',
  enabled: true,
  automatedAllowlist: [],
  ...overrides,
});

describe('senderIdentity', () => {
  it('knows an email sender by the normalised address', () => {
    expect(senderIdentity(entry({}), ' Rania@Globex.COM ')).toEqual({
      kind: 'email',
      value: 'rania@globex.com',
    });
  });

  it('knows a Telegram sender by chat id', () => {
    expect(
      senderIdentity(entry({ entry: 'telegram_bot', channel: 'telegram' }), '700100200'),
    ).toEqual({ kind: 'telegram', value: '700100200' });
  });

  it('knows a Messenger sender by the account and the customer, as the inbound gate does', () => {
    const messenger = entry({
      entry: 'meta_account',
      channel: 'messenger',
      platform: 'messenger',
      externalId: 'page-1',
    });

    expect(senderIdentity(messenger, 'psid-9')).toEqual({
      kind: 'messenger',
      value: 'page-1:psid-9',
    });
  });

  it('has no identifier for a sample that gave none usable', () => {
    expect(senderIdentity(entry({}), 'not an address').value).toBeNull();
    expect(senderIdentity(entry({}), '').value).toBeNull();
  });
});

describe('isAutomated', () => {
  it('treats a noreply@ sender as automated on a mailbox', () => {
    expect(isAutomated(entry({}), { kind: 'email', value: 'noreply@shop.example' })).toBe(true);
    expect(isAutomated(entry({}), { kind: 'email', value: 'mailer-daemon@shop.example' })).toBe(
      true,
    );
  });

  it('lets the mailbox’s allow-list through, and people through', () => {
    const allowing = entry({ automatedAllowlist: ['noreply@status.example.com'] });

    expect(isAutomated(allowing, { kind: 'email', value: 'noreply@status.example.com' })).toBe(
      false,
    );
    expect(isAutomated(entry({}), { kind: 'email', value: 'rania@globex.com' })).toBe(false);
  });

  it('judges only mailboxes, and only a usable address', () => {
    expect(
      isAutomated(entry({ entry: 'web_form', channel: 'form' }), {
        kind: 'email',
        value: 'noreply@shop.example',
      }),
    ).toBe(false);
    expect(isAutomated(entry({}), { kind: 'email', value: null })).toBe(false);
  });
});
