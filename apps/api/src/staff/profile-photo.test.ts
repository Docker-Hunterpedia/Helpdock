import { PROFILE_PHOTO_MAX_BYTES } from '@helpdock/schemas';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { encodeProfilePhoto, PhotoRefusal } from './profile-photo.js';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } });

const refusalOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof PhotoRefusal ? error.reason : 'not a PhotoRefusal'),
  );

describe('encodeProfilePhoto', () => {
  it('writes a 256 and a 64 px square WebP, cropped from the centre', async () => {
    const wide = await solid(900, 300).png().toBuffer();

    const { large, small } = await encodeProfilePhoto(wide, 'image/png');
    const largeMeta = await sharp(large).metadata();
    const smallMeta = await sharp(small).metadata();

    expect([largeMeta.format, largeMeta.width, largeMeta.height]).toEqual(['webp', 256, 256]);
    expect([smallMeta.format, smallMeta.width, smallMeta.height]).toEqual(['webp', 64, 64]);
  });

  it('takes a JPEG and a WebP as well', async () => {
    const jpeg = await solid(100, 100).jpeg().toBuffer();
    const webp = await solid(100, 100).webp().toBuffer();

    await expect(encodeProfilePhoto(jpeg, 'image/jpeg')).resolves.toMatchObject({});
    await expect(encodeProfilePhoto(webp, 'image/webp')).resolves.toMatchObject({});
  });

  it('keeps no EXIF, location included, because only the re-encode is stored', async () => {
    const tagged = await solid(120, 120)
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret owner' }, IFD3: { GPSLatitudeRef: 'N' } })
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const { large, small } = await encodeProfilePhoto(tagged, 'image/jpeg');

    expect((await sharp(large).metadata()).exif).toBeUndefined();
    expect((await sharp(small).metadata()).exif).toBeUndefined();
    expect(large.includes(Buffer.from('secret owner'))).toBe(false);
  });

  it('refuses an empty upload', async () => {
    expect(await refusalOf(encodeProfilePhoto(new Uint8Array(), 'image/png'))).toBe('missing');
  });

  it('refuses a file over the cap before reading it as an image', async () => {
    const huge = new Uint8Array(PROFILE_PHOTO_MAX_BYTES + 1);

    expect(await refusalOf(encodeProfilePhoto(huge, 'image/png'))).toBe('too-large');
  });

  it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', ''])(
    'refuses a declared type of %j',
    async (mime) => {
      const png = await solid(10, 10).png().toBuffer();

      expect(await refusalOf(encodeProfilePhoto(png, mime))).toBe('unsupported-type');
    },
  );

  it('refuses bytes that are not the image the type claims', async () => {
    const png = await solid(10, 10).png().toBuffer();
    const script = Buffer.from('<html><script>alert(1)</script></html>');

    expect(await refusalOf(encodeProfilePhoto(script, 'image/png'))).toBe('unsupported-type');
    expect(await refusalOf(encodeProfilePhoto(png, 'image/jpeg'))).toBe('unsupported-type');
  });

  it('refuses a polyglot whose first bytes are an image but whose body will not decode', async () => {
    const truncated = (await solid(400, 400).png().toBuffer()).subarray(0, 60);

    expect(await refusalOf(encodeProfilePhoto(truncated, 'image/png'))).toBe('unreadable');
  });

  it('refuses a decompression bomb by its pixel count, not its size', async () => {
    const bomb = await sharp({
      create: { width: 9000, height: 9000, channels: 3, background: '#000000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(PROFILE_PHOTO_MAX_BYTES);

    expect(await refusalOf(encodeProfilePhoto(bomb, 'image/png'))).toBe('unreadable');
  });
});
