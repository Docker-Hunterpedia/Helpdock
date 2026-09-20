import type { AttachmentKind, DerivedVariantName, DownloadVariant } from '@helpdock/schemas';

/**
 * What the worker makes of each kind, and what a client may then ask for
 * (ARCHITECTURE §9).
 *
 * | Kind | Derived | `original` kept |
 * |---|---|---|
 * | image | `webp`, `thumb320`, `thumb960` | only with `keepOriginals` |
 * | audio | `opus` | only with `keepOriginals` |
 * | video | `poster` | always — v1 does not transcode video |
 * | file | nothing | always |
 *
 * The asymmetry is the point. An image and a voice note are *replaced* by
 * something this install produced, which is what strips EXIF and disarms a
 * polyglot (REQUIREMENTS §5.1); a video and a file keep the bytes that arrived,
 * so their protection is the size cap, the sniff, the scanner and the fact that
 * they are only ever served as a download.
 */

/** Long edge of the WebP an image is re-encoded to (ARCHITECTURE §9). */
export const IMAGE_MAX_EDGE = 2048;
/** WebP quality. §9 fixes it at 82. */
export const IMAGE_QUALITY = 82;

/** The two thumbnail widths §9 names. */
export const THUMBNAIL_WIDTHS = Object.freeze({ thumb320: 320, thumb960: 960 } as const);

export type ThumbnailVariant = keyof typeof THUMBNAIL_WIDTHS;

/** Opus, 48 kHz, mono, 32 kbps — the normalisation §9 fixes for voice notes. */
export const OPUS_SAMPLE_RATE = 48_000;
export const OPUS_CHANNELS = 1;
export const OPUS_BITRATE = '32k';

/** Where in a video the poster frame is taken from. §9 says one second. */
export const POSTER_AT_SECONDS = 1;

/** The three an image gets, in the order the worker writes them. */
export const IMAGE_VARIANTS = ['webp', 'thumb320', 'thumb960'] as const;

const PLANS: Readonly<Record<AttachmentKind, readonly DerivedVariantName[]>> = {
  image: IMAGE_VARIANTS,
  audio: ['opus'],
  video: ['poster'],
  file: [],
};

/** The variants the worker will write for a kind, in the order it writes them. */
export const variantsFor = (kind: AttachmentKind): readonly DerivedVariantName[] => PLANS[kind];

/**
 * Whether the uploaded object survives processing.
 *
 * A video and a file always keep theirs: there is nothing else to serve. An
 * image and a voice note keep theirs only when the brand asked for it, because
 * the re-encoded copy is the one that is safe to hand back and the original is
 * the one that carried whatever was in it.
 */
export const keepsOriginal = (kind: AttachmentKind, keepOriginals: boolean): boolean =>
  kind === 'video' || kind === 'file' || keepOriginals;

/**
 * Whether a variant may be served with `Content-Disposition: inline`.
 *
 * Only what this install encoded. REQUIREMENTS §5.1 asks for `attachment` on
 * everything that is not an image, and "an image" here means a WebP sharp
 * produced — never the uploaded object, whatever its type claims, because bytes
 * this install did not write are bytes it cannot vouch for. An uploaded PNG is
 * therefore downloaded and its WebP is what a thread renders.
 */
export const servesInline = (variant: DownloadVariant): boolean => variant !== 'original';

/** The content type a derived variant is stored and served with. */
export const VARIANT_MIME: Readonly<Record<DerivedVariantName, string>> = Object.freeze({
  webp: 'image/webp',
  thumb320: 'image/webp',
  thumb960: 'image/webp',
  poster: 'image/webp',
  opus: 'audio/ogg',
});

/** The extension a derived variant is offered to a browser under. */
export const VARIANT_EXTENSION: Readonly<Record<DerivedVariantName, string>> = Object.freeze({
  webp: 'webp',
  thumb320: 'webp',
  thumb960: 'webp',
  poster: 'webp',
  opus: 'ogg',
});
