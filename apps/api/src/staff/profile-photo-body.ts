import { PROFILE_PHOTO_MAX_BYTES } from '@helpdock/schemas';
import type { FormBodyRoute } from '../channels/inbound/inbound-parse-body.js';
import { StaffFailure } from './staff-failure.js';

/** The multipart field the photo travels in. */
export const PROFILE_PHOTO_FIELD = 'photo';

/** The multipart envelope around a file at the cap: boundaries and part headers. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * `POST /api/me/profile/photo` takes a multipart body, which the api accepts as
 * raw bytes on a few named routes only (`registerFormBodies`). The body limit
 * is the photo cap plus the envelope, so a file over the cap reaches
 * {@link readPhotoUpload} and is refused with a reason, while a body far past it
 * never leaves the socket.
 */
export const PROFILE_PHOTO_ROUTE: FormBodyRoute = {
  matches: (url) => /^\/api\/me\/profile\/photo(?:\?|$)/.test(url),
  bodyLimit: PROFILE_PHOTO_MAX_BYTES + ENVELOPE_BYTES,
};

export interface PhotoUpload {
  readonly bytes: Uint8Array;
  readonly declaredMime: string;
}

/** The `photo` file of a multipart body, or a `photo-missing` refusal. */
export const readPhotoUpload = async (
  body: unknown,
  contentType: string | undefined,
): Promise<PhotoUpload> => {
  if (!Buffer.isBuffer(body)) {
    throw new StaffFailure('photo-missing');
  }

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), {
      headers: { 'content-type': contentType ?? '' },
    }).formData();
  } catch {
    throw new StaffFailure('photo-missing');
  }

  const file = form.get(PROFILE_PHOTO_FIELD);
  if (file === null || typeof file === 'string') {
    throw new StaffFailure('photo-missing');
  }

  return { bytes: new Uint8Array(await file.arrayBuffer()), declaredMime: file.type };
};
