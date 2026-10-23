import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging/logger.js';
import { FakeStorage } from '../testing/media.js';
import { ProfilePhotoStore } from './profile-photo.store.js';

const USER = '01937f5e-7e53-7000-8000-00000000000a';
const photo = { large: Buffer.from('large-bytes'), small: Buffer.from('small-bytes') };

describe('ProfilePhotoStore', () => {
  let dir: string;
  let storage: FakeStorage;
  let store: ProfilePhotoStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'helpdock-photo-test-'));
    storage = new FakeStorage(dir);
    store = new ProfilePhotoStore(storage);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps both sizes under the install prefix, in a folder of its own for each upload', async () => {
    const folder = await store.save(USER, photo);
    const again = await store.save(USER, photo);

    expect(folder).toMatch(new RegExp(`^install/users/${USER}/[0-9a-f-]{36}/$`));
    expect(again).not.toBe(folder);
    expect(await storage.read(`${folder}256.webp`)).toEqual(photo.large);
    expect(await storage.read(`${folder}64.webp`)).toEqual(photo.small);
  });

  it('refuses a user id that is not a UUID, so nothing typed reaches a key', async () => {
    await expect(store.save('../../brands/other', photo)).rejects.toThrow(TypeError);
  });

  it('signs a short-lived GET for each size, inline, and none without a photo', async () => {
    const folder = await store.save(USER, photo);

    const urls = await store.urls(folder);

    expect(urls?.large).toContain(encodeURIComponent(`${folder}256.webp`));
    expect(urls?.small).toContain(encodeURIComponent(`${folder}64.webp`));
    expect(storage.presignedDownloads).toEqual([
      expect.objectContaining({
        key: `${folder}256.webp`,
        contentType: 'image/webp',
        inline: true,
      }),
      expect.objectContaining({ key: `${folder}64.webp`, contentType: 'image/webp', inline: true }),
    ]);
    expect(await store.urls(null)).toBeNull();
    expect(await store.smallUrl(null)).toBeNull();
  });

  it('signs only the 64 px for a customer surface', async () => {
    const folder = await store.save(USER, photo);
    storage.presignedDownloads.length = 0;

    expect(await store.smallUrl(folder)).toContain(encodeURIComponent(`${folder}64.webp`));
    expect(storage.presignedDownloads).toHaveLength(1);
  });

  it('removes both objects, and removing twice is fine', async () => {
    const folder = await store.save(USER, photo);

    await store.remove(folder);
    await store.remove(folder);

    expect(storage.removed).toEqual([
      `${folder}256.webp`,
      `${folder}64.webp`,
      `${folder}256.webp`,
      `${folder}64.webp`,
    ]);
  });

  describe('removeQuietly', () => {
    const logger = { warn: vi.fn() } as unknown as Logger;

    it('does nothing for no photo', async () => {
      await store.removeQuietly(null, logger);

      expect(storage.removed).toEqual([]);
    });

    it('logs and carries on when the bucket refuses, so a request is not failed by it', async () => {
      vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('bucket down'));

      await expect(store.removeQuietly('install/users/x/y/', logger)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
