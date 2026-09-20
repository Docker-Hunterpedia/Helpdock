import { describe, expect, it } from 'vitest';
import {
  bytesMatchMime,
  isSniffableMime,
  MAGIC_BYTES_PROBE,
  SNIFFABLE_MIME_TYPES,
  sniffFamily,
} from './magic-bytes.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF = ascii('GIF89a');
const WEBP = concat(ascii('RIFF'), bytes(0x1a, 0x00, 0x00, 0x00), ascii('WEBP'));
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3);
const OGG = ascii('OggS');
const PDF = ascii('%PDF-1.7');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const MP4 = concat(bytes(0x00, 0x00, 0x00, 0x20), ascii('ftypisom'));

describe('sniffFamily', () => {
  it.each([
    [PNG, 'png'],
    [JPEG, 'jpeg'],
    [GIF, 'gif'],
    [WEBP, 'webp'],
    [WEBM, 'webm'],
    [OGG, 'ogg'],
    [PDF, 'pdf'],
    [ZIP, 'zip'],
    [MP4, 'isobmff'],
    [ascii('hello, world\n'), 'text'],
  ])('recognises %#', (sample, family) => {
    expect(sniffFamily(sample)).toBe(family);
  });

  it('does not mistake another RIFF form for a WebP', () => {
    // A .wav is also RIFF. Reading only the first four bytes would call it an
    // image, and an image is the one thing served inline.
    const wav = concat(ascii('RIFF'), bytes(0x1a, 0, 0, 0), ascii('WAVE'));

    expect(sniffFamily(wav)).toBe('unknown');
  });

  it('calls bytes with a NUL in them binary, however much text surrounds them', () => {
    expect(sniffFamily(concat(ascii('plain text'), bytes(0x00), ascii('more')))).toBe('unknown');
  });

  it('calls an empty file unknown rather than text', () => {
    expect(sniffFamily(new Uint8Array(0))).toBe('unknown');
  });

  it('calls a truncated signature unknown rather than guessing', () => {
    expect(sniffFamily(PNG.subarray(0, 4))).toBe('unknown');
  });

  it('will not call arbitrary binary text just because it has no NUL in it', () => {
    // `text/plain` is the one allowed type with no signature, so the check it
    // gets instead is that the bytes decode as UTF-8. Most binary does not.
    expect(sniffFamily(bytes(0x89, 0xfe, 0xff, 0x41))).toBe('unknown');
  });

  it('calls Arabic text text, even when the probe cuts a character in half', () => {
    const arabic = ascii('مرحبا بالعالم');

    expect(sniffFamily(arabic)).toBe('text');
    // The probe is a fixed number of bytes, so the last character is very
    // likely incomplete; that must not make a text file binary.
    expect(sniffFamily(arabic.subarray(0, arabic.byteLength - 1))).toBe('text');
  });
});

describe('bytesMatchMime', () => {
  it('accepts bytes that are what was declared', () => {
    expect(bytesMatchMime(PNG, 'image/png')).toBe(true);
    expect(bytesMatchMime(MP4, 'video/mp4')).toBe(true);
    // A voice note from Safari is an MP4 and from Chromium a WebM.
    expect(bytesMatchMime(MP4, 'audio/mp4')).toBe(true);
    expect(bytesMatchMime(WEBM, 'audio/webm')).toBe(true);
  });

  it('refuses bytes that are not', () => {
    expect(bytesMatchMime(PNG, 'image/jpeg')).toBe(false);
    expect(bytesMatchMime(ZIP, 'application/pdf')).toBe(false);
    expect(bytesMatchMime(ascii('<script>alert(1)</script>'), 'image/png')).toBe(false);
  });

  it('accepts the three Zip-based types as one family, which is all bytes can say', () => {
    // A .docx, an .xlsx and a .zip are the same four bytes. All three are
    // served as downloads and scanned, so telling them apart buys nothing.
    for (const mime of [
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(bytesMatchMime(ZIP, mime), mime).toBe(true);
    }
  });

  it('refuses a declared type it has no way to verify, rather than waving it through', () => {
    expect(bytesMatchMime(ascii('<svg/>'), 'image/svg+xml')).toBe(false);
    expect(bytesMatchMime(ascii('<html>'), 'text/html')).toBe(false);
    expect(isSniffableMime('image/svg+xml')).toBe(false);
  });

  it('accepts a PNG/JavaScript polyglot as a PNG, because that is what it is', () => {
    // The point of the check is that the declaration matches the bytes, not
    // that a file has only one reading. A file whose PNG header is genuine and
    // whose tail is a script passes here — and is then re-encoded by sharp,
    // which is what actually disarms it (REQUIREMENTS §5.1). The assertion is
    // that it is never mistaken for the *script* it also is.
    const polyglot = concat(PNG, ascii('\n/*'), new Uint8Array(32).fill(0x41), ascii('*/alert(1)'));

    expect(bytesMatchMime(polyglot, 'image/png')).toBe(true);
    expect(bytesMatchMime(polyglot, 'text/plain')).toBe(false);
    expect(sniffFamily(polyglot)).toBe('png');
  });

  it('refuses a script that merely mentions a PNG signature later in the file', () => {
    const disguised = concat(ascii('alert(1);//'), PNG);

    expect(bytesMatchMime(disguised, 'image/png')).toBe(false);
  });

  it('refuses text that claims to be an archive', () => {
    expect(bytesMatchMime(ascii('not really a zip'), 'application/zip')).toBe(false);
  });
});

describe('the sniffable set', () => {
  it('covers every type the shipped content policy allows', () => {
    // A brand may only allow what the worker can verify; `checkUpload` refuses
    // anything else, and this is the list it refuses against.
    for (const mime of [
      'image/webp',
      'image/jpeg',
      'image/png',
      'image/gif',
      'video/mp4',
      'video/webm',
      'audio/ogg',
      'audio/webm',
      'audio/mp4',
      'application/pdf',
      'text/plain',
      'application/zip',
    ]) {
      expect(SNIFFABLE_MIME_TYPES, mime).toContain(mime);
    }
  });

  it('reads far enough ahead for every signature it knows', () => {
    // The longest check is the RIFF form at offset 8; the probe is generous so
    // a new signature does not silently need a bigger read.
    expect(MAGIC_BYTES_PROBE).toBeGreaterThanOrEqual(12);
  });
});
