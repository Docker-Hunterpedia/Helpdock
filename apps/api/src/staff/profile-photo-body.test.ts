import { PROFILE_PHOTO_MAX_BYTES } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { PROFILE_PHOTO_FIELD, PROFILE_PHOTO_ROUTE, readPhotoUpload } from './profile-photo-body.js';
import { StaffFailure } from './staff-failure.js';

const multipart = async (build: (form: FormData) => void) => {
  const form = new FormData();
  build(form);
  const request = new Request('http://upload.test', { method: 'POST', body: form });

  return {
    contentType: request.headers.get('content-type') ?? '',
    body: Buffer.from(await request.arrayBuffer()),
  };
};

const reasonOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof StaffFailure ? error.reason : 'not a StaffFailure'),
  );

describe('PROFILE_PHOTO_ROUTE', () => {
  it('matches the upload path, with or without a query, and nothing else', () => {
    expect(PROFILE_PHOTO_ROUTE.matches('/api/me/profile/photo')).toBe(true);
    expect(PROFILE_PHOTO_ROUTE.matches('/api/me/profile/photo?x=1')).toBe(true);
    expect(PROFILE_PHOTO_ROUTE.matches('/api/me/profile')).toBe(false);
    expect(PROFILE_PHOTO_ROUTE.matches('/api/me/profile/photos')).toBe(false);
    expect(PROFILE_PHOTO_ROUTE.matches('/x/api/me/profile/photo')).toBe(false);
  });

  it('leaves room for the multipart envelope around a file at the cap', () => {
    expect(PROFILE_PHOTO_ROUTE.bodyLimit).toBeGreaterThan(PROFILE_PHOTO_MAX_BYTES);
    expect(PROFILE_PHOTO_ROUTE.bodyLimit).toBeLessThan(PROFILE_PHOTO_MAX_BYTES * 1.1);
  });
});

describe('readPhotoUpload', () => {
  it('returns the photo file with its declared type', async () => {
    const { body, contentType } = await multipart((form) => {
      form.append(
        PROFILE_PHOTO_FIELD,
        new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' }),
      );
    });

    const upload = await readPhotoUpload(body, contentType);

    expect([...upload.bytes]).toEqual([1, 2, 3]);
    expect(upload.declaredMime).toBe('image/png');
  });

  it.each([
    ['a body that is not bytes', undefined],
    ['a JSON body', { photo: 'x' }],
  ])('refuses %s', async (_name, body) => {
    expect(await reasonOf(readPhotoUpload(body, 'application/json'))).toBe('photo-missing');
  });

  it('refuses a multipart body whose file is under another field', async () => {
    const { body, contentType } = await multipart((form) => {
      form.append('avatar', new File(['x'], 'me.png', { type: 'image/png' }));
    });

    expect(await reasonOf(readPhotoUpload(body, contentType))).toBe('photo-missing');
  });

  it('refuses a photo field that is text, not a file', async () => {
    const { body, contentType } = await multipart((form) => {
      form.append(PROFILE_PHOTO_FIELD, 'not a file');
    });

    expect(await reasonOf(readPhotoUpload(body, contentType))).toBe('photo-missing');
  });

  it('refuses bytes that are not a multipart body', async () => {
    expect(
      await reasonOf(readPhotoUpload(Buffer.from('garbage'), 'multipart/form-data; boundary=x')),
    ).toBe('photo-missing');
    expect(await reasonOf(readPhotoUpload(Buffer.from('garbage'), undefined))).toBe(
      'photo-missing',
    );
  });
});
