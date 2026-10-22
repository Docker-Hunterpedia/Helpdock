import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { type Db, isUuid, users } from '@helpdock/db';
import {
  type JobLogger,
  PHOTO_SWEEP_GRACE_MS,
  type PhotoSweepFolder,
  parseJobPayloadOrFail,
  photoSweepScheduleJob,
} from '@helpdock/jobs';
import type { Job } from 'bullmq';

/**
 * The hourly sweep behind {@link photoSweepScheduleJob}: every
 * `install/users/<user id>/<photo id>/` folder in the bucket that no
 * `users.photo_key` names goes away.
 *
 * **Why a sweep at all.** A replaced photo's old folder is deleted only after
 * the request's transaction commits (`context/after-commit.ts`), so a rollback
 * can never leave `photo_key` pointing at deleted objects. What a rollback (or
 * a process dying between the upload and the commit, or a best-effort delete
 * that failed) *does* leave is a folder no row references — invisible, small,
 * and nobody's to clean up but this job's.
 *
 * **Why the grace window.** A request uploads the new folder *before* the
 * transaction that points `photo_key` at it commits. A sweep that ran in that
 * window would delete the folder the request is about to reference, so a
 * folder whose newest object is younger than `PHOTO_SWEEP_GRACE_MS` is left
 * for the next hour. An orphan therefore lives at most a couple of hours; a
 * live photo is never touched.
 *
 * **Tenancy.** `users` is an install table with no row-level security, read
 * the way `sso.metadata_refresh` reads `sso_connections`: an explicit
 * install-system read that touches no tenant data.
 */

const PREFIX = 'install/users/';

/** S3 lists at most a thousand keys per call, as `brand-objects.ts` pages. */
const PAGE = 1_000;

/**
 * How the sweep sees the bucket, so the suite can hand it a double. A folder
 * carries the newest object's write time, which is what the grace window reads.
 */
export interface PhotoFolders {
  list(): AsyncIterable<PhotoSweepFolder>;
  /** Deletes both objects of a folder and says how many were removed. */
  remove(folder: string): Promise<number>;
}

/** A key must be `install/users/<uuid>/<uuid>/<name>` for the sweep to name its folder. */
export const folderOfKey = (key: string): string | null => {
  if (!key.startsWith(PREFIX)) {
    return null;
  }
  const segments = key.slice(PREFIX.length).split('/');
  const userId = segments[0];
  const photoId = segments[1];
  const name = segments[2];
  if (userId === undefined || photoId === undefined || name === undefined || name === '') {
    return null;
  }
  if (!isUuid(userId) || !isUuid(photoId)) {
    return null;
  }

  return `${PREFIX}${userId.toLowerCase()}/${photoId.toLowerCase()}/`;
};

export class S3UserPhotoFolders implements PhotoFolders {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  /**
   * Every folder under the install users prefix, as the newer of the write
   * times seen in it. Listing is paged, so a bucket with years of photos never
   * holds more than a page at a time.
   */
  async *list(): AsyncIterable<PhotoSweepFolder> {
    const newest = new Map<string, Date>();
    let token: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: PREFIX,
          MaxKeys: PAGE,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key === undefined) {
          continue;
        }
        const folder = folderOfKey(object.Key);
        if (folder === null) {
          continue;
        }
        const written = object.LastModified ?? new Date(0);
        const seen = newest.get(folder);
        if (seen === undefined || written > seen) {
          newest.set(folder, written);
        }
      }
      token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (token !== undefined);

    for (const [folder, lastModified] of newest) {
      yield { folder, lastModified };
    }
  }

  async remove(folder: string): Promise<number> {
    // Deleting what is not there succeeds, so this is safe to repeat.
    let removed = 0;
    for (const name of ['256.webp', '64.webp']) {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: `${folder}${name}` }),
      );
      removed += 1;
    }
    return removed;
  }
}

export async function sweepUserPhotos(options: {
  db: Db;
  folders: PhotoFolders;
  log: JobLogger;
  /** Injected for the suite; defaults to the real clock. */
  now?: () => Date;
}): Promise<{ removed: number }> {
  const now = options.now ?? (() => new Date());
  const live = new Set(
    (await options.db.select({ photoKey: users.photoKey }).from(users)).flatMap((row) =>
      row.photoKey === null ? [] : [row.photoKey.toLowerCase()],
    ),
  );

  let removed = 0;
  for await (const { folder, lastModified } of options.folders.list()) {
    if (live.has(folder)) {
      continue;
    }
    if (now().getTime() - lastModified.getTime() < PHOTO_SWEEP_GRACE_MS) {
      continue;
    }
    removed += await options.folders.remove(folder);
    options.log.info({ folder }, 'Removed an unreferenced profile photo folder');
  }

  return { removed };
}

export function createPhotoSweepProcessor(options: {
  db: Db;
  folders: PhotoFolders;
  log: JobLogger;
}) {
  return (job: Pick<Job, 'name' | 'data'>) => {
    if (job.name !== photoSweepScheduleJob.name) return undefined;
    parseJobPayloadOrFail(photoSweepScheduleJob, job.data);
    return sweepUserPhotos(options);
  };
}
