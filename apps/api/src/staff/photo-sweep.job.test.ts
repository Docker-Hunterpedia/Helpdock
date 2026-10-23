import type { Db } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  createPhotoSweepProcessor,
  folderOfKey,
  type PhotoFolders,
  sweepUserPhotos,
} from './photo-sweep.job.js';

/**
 * What the sweep removes and what it spares, over doubles: which folders count
 * as unreferenced, the grace window that keeps a mid-flight upload safe, and
 * the key parsing everything rests on. The worker routing is
 * `retention.job.test.ts`'s pattern.
 */

const USER = '01937f5e-7e53-7000-8000-000000000001';

const key = (userId: string, photoId: string, name = '64.webp'): string =>
  `install/users/${userId}/${photoId}/${name}`;

const dbWith = (photoKeys: readonly (string | null)[]): Db =>
  ({
    select: () => ({
      from: async () => photoKeys.map((photoKey) => ({ photoKey })),
    }),
  }) as unknown as Db;

describe('folderOfKey', () => {
  it('names the folder of a photo key, lower-cased', () => {
    expect(folderOfKey(key(USER, '01937f5e-7e53-7000-8000-0000000000AA'))).toBe(
      `install/users/${USER}/01937f5e-7e53-7000-8000-0000000000aa/`,
    );
  });

  it.each([
    ['a brand key', 'brands/abc/tickets/def/original'],
    ['a folder short a segment', 'install/users/only-user/'],
    ['an extra segment', key(USER, '01937f5e-7e53-7000-8000-000000000002', 'nested/64.webp')],
    ['a non-uuid user', 'install/users/lina/01937f5e-7e53-7000-8000-000000000002/64.webp'],
    ['a non-uuid photo', `install/users/${USER}/photo-1/64.webp`],
  ])('refuses %s', (_what, bad) => {
    expect(folderOfKey(bad)).toBeNull();
  });
});

describe('sweepUserPhotos', () => {
  const LIVE = `install/users/${USER}/01937f5e-7e53-7000-8000-00000000000a/`;
  const ORPHAN = `install/users/${USER}/01937f5e-7e53-7000-8000-00000000000b/`;
  const FRESH = `install/users/${USER}/01937f5e-7e53-7000-8000-00000000000c/`;

  const foldersWith = (folders: { folder: string; lastModified: Date }[]): PhotoFolders => ({
    list: async function* () {
      for (const folder of folders) {
        yield folder;
      }
    },
    remove: vi.fn(async () => 2),
  });

  const HOUR = 60 * 60 * 1000;
  const now = (): Date => new Date(1_800_000_000_000);

  it('removes the folders no photo_key names, past the grace window', async () => {
    const folders = foldersWith([
      { folder: LIVE, lastModified: new Date(now().getTime() - 5 * HOUR) },
      { folder: ORPHAN, lastModified: new Date(now().getTime() - 5 * HOUR) },
    ]);

    const result = await sweepUserPhotos({
      db: dbWith([LIVE, null]),
      folders,
      log: silentLogger,
      now,
    });

    expect(result).toEqual({ removed: 2 });
    expect(folders.remove).toHaveBeenCalledExactlyOnceWith(ORPHAN);
  });

  it('spares a live folder whatever its age, and an orphan still inside the grace window', async () => {
    const folders = foldersWith([
      { folder: LIVE, lastModified: new Date(now().getTime() - 5 * HOUR) },
      { folder: FRESH, lastModified: new Date(now().getTime() - HOUR / 2) },
      { folder: ORPHAN, lastModified: new Date(now().getTime() - HOUR + 60_000) },
    ]);

    const result = await sweepUserPhotos({
      db: dbWith([LIVE.toUpperCase()]),
      folders,
      log: silentLogger,
      now,
    });

    expect(result).toEqual({ removed: 0 });
    expect(folders.remove).not.toHaveBeenCalled();
  });
});

describe('the photo sweep processor', () => {
  const processor = createPhotoSweepProcessor({
    db: {} as Db,
    folders: {
      list: async function* () {},
      remove: async () => 0,
    },
    log: silentLogger,
  });

  const job = (name: string, data: unknown = {}): Job =>
    ({ name, data, id: 'job-1' }) as unknown as Job;

  it('answers nothing for a job that is not its own', () => {
    expect(processor(job('maintenance.retention'))).toBeUndefined();
  });

  it('runs its own job, and fails for good on a payload that cannot be valid', async () => {
    const own = createPhotoSweepProcessor({
      db: dbWith([]),
      folders: { list: async function* () {}, remove: async () => 0 },
      log: silentLogger,
    });

    await expect(own(job('maintenance.photo_sweep'))).resolves.toEqual({ removed: 0 });
    expect(() => own(job('maintenance.photo_sweep', { nope: 1 }))).toThrow();
  });
});
