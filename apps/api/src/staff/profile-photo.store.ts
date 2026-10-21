import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isUuid, uuidv7 } from '@helpdock/db';
import type { ProfilePhoto } from '@helpdock/schemas';
import type { Logger } from '../logging/logger.js';
import type { ObjectStorage } from '../media/storage.js';
import { withTempDir } from '../media/temp-dir.js';
import type { EncodedPhoto } from './profile-photo.js';

/**
 * Where a person's photo lives in the bucket and how it is read back.
 *
 * ```
 * install/users/<user id>/<photo id>/256.webp
 * install/users/<user id>/<photo id>/64.webp
 * ```
 *
 * The prefix is the install's, not a brand's: a person belongs to the install
 * and may work in several brands, so the `brands/<id>/` prefix that brand
 * deletion empties (`media/brand-objects.ts`) must not hold their face. Every
 * segment is a UUID this api generated, so nothing a caller typed reaches a key.
 *
 * Reading is by presigned GET only. Callers decide who may be shown a photo
 * (the person themselves, or a customer of a brand the person works in) before
 * they ask for one; this class never answers "who".
 */

const LARGE = '256.webp';
const SMALL = '64.webp';
const CONTENT_TYPE = 'image/webp';

const folderOf = (userId: string, photoId: string): string => {
  if (!isUuid(userId) || !isUuid(photoId)) {
    throw new TypeError('A photo folder needs UUID user and photo ids');
  }

  return `install/users/${userId.toLowerCase()}/${photoId.toLowerCase()}/`;
};

export class ProfilePhotoStore {
  readonly #storage: ObjectStorage;

  constructor(storage: ObjectStorage) {
    this.#storage = storage;
  }

  /** Writes both sizes under a fresh folder and returns the folder (what `users.photo_key` holds). */
  async save(userId: string, photo: EncodedPhoto): Promise<string> {
    const folder = folderOf(userId, uuidv7());

    await withTempDir(async (dir) => {
      for (const [name, bytes] of [
        [LARGE, photo.large],
        [SMALL, photo.small],
      ] as const) {
        const file = path.join(dir, name);
        await writeFile(file, bytes);
        await this.#storage.upload({
          key: `${folder}${name}`,
          path: file,
          contentType: CONTENT_TYPE,
        });
      }
    });

    return folder;
  }

  /** Both sizes as five-minute URLs, or null when there is no photo. */
  async urls(folder: string | null): Promise<ProfilePhoto | null> {
    if (folder === null) {
      return null;
    }

    return { large: await this.#sign(folder, LARGE), small: await this.#sign(folder, SMALL) };
  }

  /** Just the 64 px, for a customer surface that draws a small avatar. */
  async smallUrl(folder: string | null): Promise<string | null> {
    return folder === null ? null : this.#sign(folder, SMALL);
  }

  /** Deleting what is not there succeeds, so this is safe to repeat. */
  async remove(folder: string): Promise<void> {
    await this.#storage.remove(`${folder}${LARGE}`);
    await this.#storage.remove(`${folder}${SMALL}`);
  }

  /**
   * Removing a folder nobody points at any more must not fail the request that
   * dropped it: the worst case is two orphaned objects, which is better than a
   * person who cannot change or delete their photo because the bucket hiccuped.
   */
  async removeQuietly(folder: string | null, logger: Logger): Promise<void> {
    if (folder === null) {
      return;
    }
    try {
      await this.remove(folder);
    } catch (error) {
      logger.warn({ err: error, folder }, 'A replaced profile photo could not be deleted');
    }
  }

  async #sign(folder: string, name: string): Promise<string> {
    const { url } = await this.#storage.presignDownload({
      key: `${folder}${name}`,
      contentType: CONTENT_TYPE,
      fileName: 'photo.webp',
      inline: true,
    });

    return url;
  }
}
