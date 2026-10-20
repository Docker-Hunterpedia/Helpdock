import { describe, expect, it } from 'vitest';
import { addressWrittenTo, arrivalOf, recordedArrival, requestArrival } from './arrival.js';

const DEPARTMENT = '0199f4b2-0000-7000-8000-0000000000d1';

describe('arrivalOf', () => {
  it('refuses an arrival the trail could not read back', () => {
    expect(() =>
      arrivalOf({
        entry: 'mailbox',
        entryId: 'm-1',
        departmentId: 'support',
        reason: 'entry_department',
      }),
    ).toThrow();
  });

  it('round-trips through what a creation row stores', () => {
    const to = {
      subject: 'Hello',
      ...arrivalOf({
        entry: 'mailbox',
        entryId: 'm-1',
        address: 'billing@acme.test',
        departmentId: DEPARTMENT,
        reason: 'entry_department',
      }),
    };

    expect(recordedArrival(to)).toEqual(to.arrival);
    expect(recordedArrival({ subject: 'Before 1.1' })).toBeUndefined();
    expect(recordedArrival(null)).toBeUndefined();
  });
});

describe('requestArrival', () => {
  it('reads an API key as naming the department, and a person as choosing it', () => {
    expect(requestArrival({ actorType: 'apikey', actorId: 'key-1' }, DEPARTMENT)).toEqual({
      entry: 'api_key',
      entryId: 'key-1',
      departmentId: DEPARTMENT,
      reason: 'named_by_api',
    });
    expect(requestArrival({ actorType: 'staff', actorId: 'ada' }, DEPARTMENT)).toEqual({
      entry: 'staff',
      entryId: 'ada',
      departmentId: DEPARTMENT,
      reason: 'chosen_by_staff',
    });
  });
});

describe('addressWrittenTo', () => {
  it('prefers the mailbox among the recipients, whatever case the mailbox was saved in', () => {
    expect(
      addressWrittenTo(
        ['ceo@acme.test', 'billing@acme.test'],
        'Billing@acme.test',
        'alias@acme.test',
      ),
    ).toBe('billing@acme.test');
  });

  it('uses Delivered-To when the mailbox is absent from To/Cc', () => {
    expect(
      addressWrittenTo(['colleague@acme.test'], 'inbox@helpdock.test', 'alias@acme.test'),
    ).toBe('alias@acme.test');
  });

  it.each([
    ['only third parties in To/Cc', ['colleague@acme.test', 'cc@acme.test'], undefined],
    ['no recipients', [], undefined],
    ['an oversized delivery header', ['colleague@acme.test'], 'a'.repeat(321)],
  ])('records the mailbox for %s', (_scenario, recipients, deliveredTo) => {
    expect(addressWrittenTo(recipients, 'Inbox@helpdock.test', deliveredTo)).toBe(
      'inbox@helpdock.test',
    );
  });

  it('accepts a delivery header at the 320-character limit', () => {
    expect(addressWrittenTo([], 'inbox@helpdock.test', 'a'.repeat(320))).toBe('a'.repeat(320));
  });
});
