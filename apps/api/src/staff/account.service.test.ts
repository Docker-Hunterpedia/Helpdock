import type { DbTransaction, User } from '@helpdock/db';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import type { SessionService } from '../auth/session/session.service.js';
import { silentLogger } from '../testing/silent-logger.js';
import { AccountService } from './account.service.js';
import type { ProfilePhotoStore } from './profile-photo.store.js';
import type { StaffRepository } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';

/**
 * Your account's profile for customers (M14-12), with the repository and the
 * bucket as doubles. What the database does with the columns is
 * `profile.integration.test.ts`; this is the rules around them.
 */

const USER = '01937f5e-7e53-7000-8000-00000000000a';
const tx = {} as DbTransaction;

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: USER,
    email: 'lina@helpdock.com',
    name: 'Lina Haddad',
    locale: 'en',
    totpEnabled: false,
    recoveryCodesHashed: [],
    publicName: null,
    jobTitleEn: null,
    jobTitleAr: null,
    publicPhone: null,
    photoKey: null,
    timeZone: null,
    ...overrides,
  }) as User;

let row: User;
let staff: {
  findUser: ReturnType<typeof vi.fn>;
  updateProfile: ReturnType<typeof vi.fn>;
  replacePhoto: ReturnType<typeof vi.fn>;
};
let photos: {
  urls: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  removeQuietly: ReturnType<typeof vi.fn>;
};
let service: AccountService;

beforeEach(() => {
  row = user();
  staff = {
    findUser: vi.fn(async () => row),
    updateProfile: vi.fn(async () => undefined),
    replacePhoto: vi.fn(async () => null),
  };
  photos = {
    urls: vi.fn(async (folder: string | null) =>
      folder === null
        ? null
        : { small: `https://b.test/${folder}64`, large: `https://b.test/${folder}256` },
    ),
    save: vi.fn(async () => 'install/users/u/new/'),
    removeQuietly: vi.fn(async () => undefined),
  };
  service = new AccountService({
    staff: staff as unknown as StaffRepository,
    auth: { secondFactorRequiredFor: async () => false } as unknown as AuthService,
    sessions: {} as SessionService,
    photos: photos as unknown as ProfilePhotoStore,
    logger: silentLogger(),
  });
});

describe('profile', () => {
  it('shows the first name as what customers see until a public name is set', async () => {
    const profile = await service.profile(tx, USER);

    expect(profile).toMatchObject({
      name: 'Lina Haddad',
      publicName: null,
      displayName: 'Lina',
      photo: null,
    });
  });

  it('shows the public name, the titles, the phone, the zone and presigned photo URLs', async () => {
    row = user({
      publicName: 'Lina H',
      jobTitleEn: 'Billing specialist',
      jobTitleAr: 'أخصائية الفوترة',
      publicPhone: '+966551234567',
      timeZone: 'Asia/Riyadh',
      photoKey: 'install/users/u/p/',
    });

    expect(await service.profile(tx, USER)).toMatchObject({
      displayName: 'Lina H',
      jobTitleEn: 'Billing specialist',
      jobTitleAr: 'أخصائية الفوترة',
      phone: '+966551234567',
      timeZone: 'Asia/Riyadh',
      photo: {
        small: 'https://b.test/install/users/u/p/64',
        large: 'https://b.test/install/users/u/p/256',
      },
    });
  });

  it('never carries the bucket key of the photo', async () => {
    row = user({ photoKey: 'install/users/u/p/' });

    expect(JSON.stringify(await service.profile(tx, USER))).not.toContain('photoKey');
  });
});

describe('updateProfile', () => {
  it('writes only the fields that were sent, and a null clears one', async () => {
    await service.updateProfile(tx, USER, { publicName: 'Lina H', jobTitleEn: null });

    expect(staff.updateProfile).toHaveBeenCalledWith(tx, USER, {
      publicName: 'Lina H',
      jobTitleEn: null,
    });
  });

  it('keeps the phone in E.164, however it was typed', async () => {
    await service.updateProfile(tx, USER, { phone: '٠٠966 (55) 123-4567' });

    expect(staff.updateProfile).toHaveBeenCalledWith(tx, USER, { publicPhone: '+966551234567' });
  });

  it('clears the phone on null', async () => {
    await service.updateProfile(tx, USER, { phone: null });

    expect(staff.updateProfile).toHaveBeenCalledWith(tx, USER, { publicPhone: null });
  });

  it.each(['0551234567', 'call me', '+12'])(
    'refuses %j as a phone and changes nothing',
    async (phone) => {
      await expect(service.updateProfile(tx, USER, { name: 'New', phone })).rejects.toMatchObject({
        reason: 'invalid-phone',
      });
      expect(staff.updateProfile).not.toHaveBeenCalled();
    },
  );

  it('stores the time zone as sent', async () => {
    await service.updateProfile(tx, USER, { timeZone: 'Asia/Riyadh' });

    expect(staff.updateProfile).toHaveBeenCalledWith(tx, USER, { timeZone: 'Asia/Riyadh' });
  });
});

describe('setPhoto', () => {
  const png = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();

  it('stores the re-encoded photo, points the account at it and deletes the one it replaced', async () => {
    staff.replacePhoto.mockResolvedValueOnce('install/users/u/old/');

    await service.setPhoto(tx, USER, await png(), 'image/png');

    expect(photos.save).toHaveBeenCalledWith(USER, {
      large: expect.any(Buffer),
      small: expect.any(Buffer),
    });
    expect(staff.replacePhoto).toHaveBeenCalledWith(tx, USER, 'install/users/u/new/');
    expect(photos.removeQuietly).toHaveBeenCalledWith('install/users/u/old/', expect.anything());
  });

  it.each([
    ['text posing as a PNG', Buffer.from('hello'), 'image/png', 'photo-unsupported-type'],
    ['an empty file', Buffer.alloc(0), 'image/png', 'photo-missing'],
    ['a type that is not an image', Buffer.from('x'), 'application/pdf', 'photo-unsupported-type'],
  ])(
    'refuses %s without touching the bucket or the account',
    async (_name, bytes, mime, reason) => {
      const refusal = await service
        .setPhoto(tx, USER, bytes, mime)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(StaffFailure);
      expect(refusal).toMatchObject({ reason });
      expect(photos.save).not.toHaveBeenCalled();
      expect(staff.replacePhoto).not.toHaveBeenCalled();
    },
  );
});

describe('removePhoto', () => {
  it('clears the photo and deletes its objects', async () => {
    staff.replacePhoto.mockResolvedValueOnce('install/users/u/old/');

    await service.removePhoto(tx, USER);

    expect(staff.replacePhoto).toHaveBeenCalledWith(tx, USER, null);
    expect(photos.removeQuietly).toHaveBeenCalledWith('install/users/u/old/', expect.anything());
  });
});
