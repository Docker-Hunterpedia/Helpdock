import type { DownloadVariant } from '@helpdock/schemas';

/**
 * Where an attachment's objects live in the bucket.
 *
 * ```
 * brands/<brandId>/tickets/<ticketId>/<attachmentId>/<variant>
 * ```
 *
 * Three properties, and each of them is a security property rather than a
 * tidiness one.
 *
 * **Nothing a caller typed appears in a key.** Every segment is a uuid this api
 * generated or a variant name from a closed set, so `../`, a NUL byte and a
 * filename that is really a path cannot reach the bucket's namespace at all.
 * The uploaded filename is kept in a column and used only in the
 * `Content-Disposition` of a download.
 *
 * **The brand prefix is first.** DOMAIN-RULES §11 deletes a brand by purging
 * "every row, S3 prefix, Redis key and Caddy domain"; a prefix that leads with
 * the brand is one `ListObjectsV2` and one delete loop.
 *
 * **The ticket is second**, for the same reason: closed-ticket retention
 * deletes attachments with the ticket, and the objects of a ticket are
 * contiguous.
 */

/** The object the client uploaded to, before anything was made of it. */
export const ORIGINAL_VARIANT = 'original';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A key segment that is not a uuid is a bug in the caller, not input to defend
 * against — but it is the difference between an object in this attachment's
 * folder and an object anywhere in the bucket, so it is checked rather than
 * assumed.
 */
const uuidSegment = (name: string, value: string): string => {
  if (!UUID.test(value)) {
    throw new TypeError(`The ${name} in an object key must be a UUID`);
  }
  return value.toLowerCase();
};

export interface AttachmentKeyParts {
  readonly brandId: string;
  readonly ticketId: string;
  readonly attachmentId: string;
}

/**
 * The prefix every object of one attachment shares, with its trailing slash.
 *
 * The two prefixes above it — a brand's and a ticket's — are deliberately not
 * built here. The retention purge of M1-14 deletes a closed ticket's objects by
 * naming each key (`media/object-purge.ts`), which needs no bucket listing; a
 * prefix delete belongs to brand deletion, which is its own deliverable.
 */
export const attachmentPrefix = ({ brandId, ticketId, attachmentId }: AttachmentKeyParts): string =>
  `brands/${uuidSegment('brand id', brandId)}/tickets/${uuidSegment('ticket id', ticketId)}/${uuidSegment('attachment id', attachmentId)}/`;

/**
 * The key of one object. `variant` is `original` or one of the names in
 * `attachmentVariantNameSchema`, so it is a closed set and needs no escaping.
 */
export const attachmentKey = (parts: AttachmentKeyParts, variant: DownloadVariant): string =>
  `${attachmentPrefix(parts)}${variant}`;
