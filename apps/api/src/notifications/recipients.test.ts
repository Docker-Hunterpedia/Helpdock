import { NOTIFICATION_PREFERENCE_DEFAULTS } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  canSeeDepartment,
  channelsFor,
  eligibleRecipients,
  mentionedStaff,
  mentionHandles,
  resolveMention,
  type StaffFacts,
} from './recipients.js';

const SUPPORT = '01937f5e-7e53-7000-8000-0000000000d1';
const BILLING = '01937f5e-7e53-7000-8000-0000000000d2';

const staff = (
  userId: string,
  name: string,
  email: string,
  departmentIds: StaffFacts['departmentIds'] = 'all',
  deactivated = false,
): StaffFacts => ({ userId, name, email, departmentIds, deactivated });

const lina = staff('u-lina', 'Lina Haddad', 'lina@helpdock.test');
const omar = staff('u-omar', 'Omar Nasser', 'o.nasser@helpdock.test', [SUPPORT]);
const omar2 = staff('u-omar2', 'Omar Farouk', 'o.farouk@helpdock.test', [SUPPORT]);
const bo = staff('u-bo', 'Bo Lindqvist', 'bo@helpdock.test', [BILLING]);
const gone = staff('u-gone', 'Gone Person', 'gone@helpdock.test', 'all', true);
const members = [lina, omar, omar2, bo, gone];

describe('canSeeDepartment', () => {
  it('follows the department scope, and a deactivated account sees nothing', () => {
    expect(canSeeDepartment(lina, BILLING)).toBe(true);
    expect(canSeeDepartment(omar, SUPPORT)).toBe(true);
    expect(canSeeDepartment(omar, BILLING)).toBe(false);
    expect(canSeeDepartment(gone, SUPPORT)).toBe(false);
  });
});

describe('eligibleRecipients', () => {
  const ids = (list: readonly StaffFacts[]) => list.map((member) => member.userId);

  it('keeps members who can see the ticket, once each, in order', () => {
    expect(
      ids(
        eligibleRecipients({
          candidateIds: ['u-omar', 'u-lina', 'u-omar'],
          members,
          departmentId: SUPPORT,
          actorId: null,
        }),
      ),
    ).toEqual(['u-omar', 'u-lina']);
  });

  it('drops the actor, people outside the department, the deactivated and strangers', () => {
    expect(
      ids(
        eligibleRecipients({
          candidateIds: ['u-lina', 'u-bo', 'u-gone', 'u-nobody', 'u-omar'],
          members,
          departmentId: SUPPORT,
          actorId: 'u-lina',
        }),
      ),
    ).toEqual(['u-omar']);
  });
});

describe('mentionHandles', () => {
  it('finds handles in any script, once each, without trailing punctuation', () => {
    expect(mentionHandles('@Lina can you check? cc @لينا and @lina.haddad. Thanks @Lina')).toEqual([
      'lina',
      'لينا',
      'lina.haddad',
    ]);
  });

  it('does not read an email address as a mention', () => {
    expect(mentionHandles('Mail lina@helpdock.test about it')).toEqual([]);
  });
});

describe('resolveMention', () => {
  it('matches the email local part first', () => {
    expect(resolveMention('o.farouk', members)).toBe(omar2);
  });

  it('matches a whole name without spaces', () => {
    expect(resolveMention('OmarNasser', members)).toBe(omar);
  });

  it('matches a first name only when one person has it', () => {
    expect(resolveMention('lina', members)).toBe(lina);
    expect(resolveMention('omar', members)).toBeUndefined();
  });

  it('matches nobody for a handle nobody has', () => {
    expect(resolveMention('zed', members)).toBeUndefined();
  });
});

describe('mentionedStaff', () => {
  it('resolves every mention, and a person mentioned twice is one person', () => {
    expect(
      mentionedStaff('@Lina and @lina please; @Omar (which one?) and @bo', members).map(
        (member) => member.userId,
      ),
    ).toEqual(['u-lina', 'u-bo']);
  });
});

describe('channelsFor', () => {
  it('uses the defaults for somebody who never saved preferences', () => {
    expect(channelsFor(undefined, 'sla_warning', { pushConfigured: true })).toEqual({
      inApp: true,
      email: false,
      push: false,
      any: true,
    });
  });

  it('turns push off when the install has no VAPID keys, whatever the preference', () => {
    expect(
      channelsFor(NOTIFICATION_PREFERENCE_DEFAULTS, 'assigned', { pushConfigured: false }).push,
    ).toBe(false);
  });

  it('says there is nothing to write when every channel is off', () => {
    const preferences = {
      ...NOTIFICATION_PREFERENCE_DEFAULTS,
      replied: { inApp: false, email: false, push: true },
    };

    expect(channelsFor(preferences, 'replied', { pushConfigured: false }).any).toBe(false);
    expect(channelsFor(preferences, 'replied', { pushConfigured: true }).any).toBe(true);
  });
});
