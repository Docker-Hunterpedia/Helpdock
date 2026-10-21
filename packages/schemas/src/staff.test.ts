import { describe, expect, it } from 'vitest';
import {
  JOB_TITLE_MAX_LENGTH,
  PUBLIC_NAME_MAX_LENGTH,
  profileUpdateRequestSchema,
  staffRefusalSchema,
} from './staff.js';

describe('profileUpdateRequestSchema (M14-12)', () => {
  it('accepts one field alone and leaves the rest undefined, so they are kept', () => {
    expect(profileUpdateRequestSchema.parse({ publicName: 'Lina' })).toEqual({
      publicName: 'Lina',
    });
  });

  it('refuses a request that changes nothing', () => {
    expect(profileUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('turns a blank text field into null, which clears it', () => {
    expect(
      profileUpdateRequestSchema.parse({ publicName: '   ', jobTitleEn: '', phone: ' ' }),
    ).toEqual({ publicName: null, jobTitleEn: null, phone: null });
  });

  it('trims what it keeps', () => {
    expect(profileUpdateRequestSchema.parse({ jobTitleAr: '  أخصائية  ' }).jobTitleAr).toBe(
      'أخصائية',
    );
  });

  it('refuses a name or a title over its cap', () => {
    expect(
      profileUpdateRequestSchema.safeParse({ publicName: 'x'.repeat(PUBLIC_NAME_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      profileUpdateRequestSchema.safeParse({ jobTitleEn: 'x'.repeat(JOB_TITLE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('takes an IANA time zone or null, and refuses anything else', () => {
    expect(profileUpdateRequestSchema.parse({ timeZone: 'Asia/Riyadh' }).timeZone).toBe(
      'Asia/Riyadh',
    );
    expect(profileUpdateRequestSchema.parse({ timeZone: null }).timeZone).toBeNull();
    expect(profileUpdateRequestSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('still takes the security page’s name and language', () => {
    expect(profileUpdateRequestSchema.parse({ name: ' Lina H. ', locale: 'ar' })).toEqual({
      name: 'Lina H.',
      locale: 'ar',
    });
  });
});

describe('staffRefusalSchema', () => {
  it('names the profile refusals the screen has sentences for', () => {
    expect(staffRefusalSchema.options).toEqual(
      expect.arrayContaining([
        'invalid-phone',
        'photo-missing',
        'photo-too-large',
        'photo-unsupported-type',
        'photo-unreadable',
      ]),
    );
  });
});
