import {
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_MIME_TYPES,
  PROFILE_PHOTO_SIZES,
} from '@helpdock/schemas';
import sharp from 'sharp';
import { bytesMatchMime } from '../media/magic-bytes.js';
import { IMAGE_QUALITY } from '../media/variants.js';

/**
 * A profile photo through the same gates as any other image the api keeps
 * (ARCHITECTURE §9, AGENTS.md "Uploads"): the size cap, the declared type
 * against the magic bytes, and a sharp re-encode that is the only thing ever
 * stored, so EXIF (including location) and anything a polyglot hid after the
 * image are gone with the original.
 *
 * The photo is cropped to a square from the centre and written twice, 256 and
 * 64 px. Both are WebP: an avatar is never animated, and one format keeps the
 * stored objects and the presigned content type identical.
 */

export type PhotoRefusalReason = 'missing' | 'too-large' | 'unsupported-type' | 'unreadable';

/** Why a photo was not kept. The controller maps each reason to an HTTP status. */
export class PhotoRefusal extends Error {
  readonly reason: PhotoRefusalReason;

  constructor(reason: PhotoRefusalReason) {
    super(`The profile photo was refused: ${reason}`);
    this.name = 'PhotoRefusal';
    this.reason = reason;
  }
}

/** sharp's decompression-bomb ceiling, as for attachments: 64 megapixels. */
const MAX_INPUT_PIXELS = 64_000_000;

export interface EncodedPhoto {
  readonly small: Buffer;
  readonly large: Buffer;
}

const isAllowedType = (mime: string): boolean =>
  (PROFILE_PHOTO_MIME_TYPES as readonly string[]).includes(mime);

export const encodeProfilePhoto = async (
  bytes: Uint8Array,
  declaredMime: string,
): Promise<EncodedPhoto> => {
  if (bytes.length === 0) {
    throw new PhotoRefusal('missing');
  }
  if (bytes.length > PROFILE_PHOTO_MAX_BYTES) {
    throw new PhotoRefusal('too-large');
  }
  // The declared type is a claim; the first bytes are the evidence.
  if (!isAllowedType(declaredMime) || !bytesMatchMime(bytes, declaredMime)) {
    throw new PhotoRefusal('unsupported-type');
  }

  const square = async (edge: number): Promise<Buffer> =>
    sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      // Applies the EXIF orientation, which the re-encode then drops.
      .rotate()
      .resize(edge, edge, { fit: 'cover', position: 'centre' })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();

  try {
    return {
      large: await square(PROFILE_PHOTO_SIZES.large),
      small: await square(PROFILE_PHOTO_SIZES.small),
    };
  } catch {
    throw new PhotoRefusal('unreadable');
  }
};
