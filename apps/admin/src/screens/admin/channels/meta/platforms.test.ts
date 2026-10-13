import { describe, expect, it } from 'vitest';
import { accountLabel, accountSublabel, PLATFORM_ICONS } from './platforms.js';

describe('PLATFORM_ICONS', () => {
  it('uses the three icons DESIGN §5 picks', () => {
    expect(
      Object.fromEntries(
        Object.entries(PLATFORM_ICONS).map(([platform, icon]) => [platform, icon.displayName]),
      ),
    ).toEqual({ whatsapp: 'Phone', messenger: 'MessagesSquare', instagram: 'Camera' });
  });
});

describe('accountLabel', () => {
  it('is the number, the Page’s name and the handle', () => {
    expect(
      accountLabel({
        platform: 'whatsapp',
        displayPhone: '+1 555 0142',
        username: null,
        displayName: 'Helpdock Support',
      }),
    ).toBe('+1 555 0142');
    expect(
      accountLabel({
        platform: 'messenger',
        displayPhone: null,
        username: 'Helpdock',
        displayName: 'Helpdock',
      }),
    ).toBe('Helpdock');
    expect(
      accountLabel({
        platform: 'instagram',
        displayPhone: null,
        username: 'helpdock',
        displayName: 'Helpdock',
      }),
    ).toBe('@helpdock');
  });

  it('falls back to the display name when Meta gave no number or handle', () => {
    expect(
      accountLabel({
        platform: 'whatsapp',
        displayPhone: null,
        username: null,
        displayName: 'Helpdock Support',
      }),
    ).toBe('Helpdock Support');
    expect(
      accountLabel({
        platform: 'instagram',
        displayPhone: null,
        username: null,
        displayName: 'Helpdock',
      }),
    ).toBe('Helpdock');
  });
});

describe('accountSublabel', () => {
  it('names the number, and the kind of a Page or account', () => {
    expect(accountSublabel({ platform: 'whatsapp', displayName: 'Helpdock Support' }, 'x')).toBe(
      'Helpdock Support',
    );
    expect(
      accountSublabel({ platform: 'messenger', displayName: 'Helpdock' }, 'Facebook Page'),
    ).toBe('Facebook Page');
  });
});
