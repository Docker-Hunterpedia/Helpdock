/**
 * What the bytes actually are (REQUIREMENTS §5.1: "MIME sniffing, not trusting
 * the extension"; ARCHITECTURE §9: "sniff MIME (magic bytes), reject
 * mismatch").
 *
 * **Why a table here and not the `file-type` package.** The allow-list a brand
 * may choose from is closed and small — four image formats, two video, three
 * audio, five file types — and every entry on it has to have a path through the
 * pipeline anyway. A table for exactly those is about a hundred lines, is read
 * in one sitting by anyone auditing the upload path, and adds nothing to the
 * dependency tree of a security-critical step. `file-type` would still not
 * answer the two questions this file has to answer on its own: `text/plain` has
 * no signature at all, and `.docx`, `.xlsx` and `.zip` are the same four bytes.
 * See [ADR 0009](../../../../docs/decisions/0009-magic-byte-sniffing.md).
 *
 * The contract is narrow on purpose. This does **not** say "what is this
 * file?"; it says "could these bytes be the type that was declared?", and it is
 * one of two defences rather than the only one. Images are re-encoded by sharp,
 * which is what actually kills a polyglot: a file that is a valid PNG *and* a
 * valid JavaScript program passes the PNG signature check here — as it must,
 * since it really is a PNG — and comes out of sharp as a WebP with none of the
 * appended payload left.
 */

/** How many bytes a caller has to read for every check below to be decidable. */
export const MAGIC_BYTES_PROBE = 64;

const ascii = (text: string): readonly number[] => [...text].map((c) => c.codePointAt(0) ?? 0);

interface Signature {
  readonly offset: number;
  readonly bytes: readonly number[];
}

const at = (offset: number, bytes: readonly number[]): Signature => ({ offset, bytes });

const matches = (buffer: Uint8Array, { offset, bytes }: Signature): boolean => {
  if (buffer.length < offset + bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => buffer[offset + index] === byte);
};

/**
 * The families the pipeline recognises. A family is what a `Content-Type` can
 * honestly be narrowed to from the first bytes alone:
 *
 * - `zip` covers `.docx`, `.xlsx` and `.zip`, because all three are Zip
 *   archives and telling them apart means reading the central directory. Not
 *   distinguishing them is safe here and deliberate: all three are served as
 *   `Content-Disposition: attachment`, none is ever rendered, and the scanner
 *   sees the same bytes either way.
 * - `isobmff` covers `.mp4` for both video and audio, because a `MediaRecorder`
 *   voice note on Safari is an MP4.
 * - `text` is what is left when nothing matched and the bytes look like text.
 */
export type ByteFamily =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'webm'
  | 'isobmff'
  | 'ogg'
  | 'pdf'
  | 'zip'
  | 'text'
  | 'unknown';

const SIGNATURES: readonly (readonly [ByteFamily, Signature])[] = [
  ['png', at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['jpeg', at(0, [0xff, 0xd8, 0xff])],
  ['gif', at(0, ascii('GIF87a'))],
  ['gif', at(0, ascii('GIF89a'))],
  // Matroska and WebM share the EBML header; the DocType that follows says
  // which, and the pipeline does not need to know.
  ['webm', at(0, [0x1a, 0x45, 0xdf, 0xa3])],
  ['ogg', at(0, ascii('OggS'))],
  ['pdf', at(0, ascii('%PDF-'))],
  // Local file header, empty archive, and spanned archive. An `.xlsx` written
  // by Excel is the first; the other two exist and are still Zip.
  ['zip', at(0, [0x50, 0x4b, 0x03, 0x04])],
  ['zip', at(0, [0x50, 0x4b, 0x05, 0x06])],
  ['zip', at(0, [0x50, 0x4b, 0x07, 0x08])],
];

/** RIFF containers name their form at offset 8; only `WEBP` is an image. */
const RIFF = at(0, ascii('RIFF'));
const WEBP_FORM = at(8, ascii('WEBP'));

/** ISO base media: a size-prefixed `ftyp` box at offset 4. */
const FTYP = at(4, ascii('ftyp'));

/** Decodes strictly, so anything that is not valid UTF-8 throws. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * How many trailing bytes may be dropped before giving up on a decode. The
 * caller reads a fixed-size probe, so the last character in it is very likely
 * cut in half; a UTF-8 sequence is at most four bytes, so three is every case.
 */
const MAX_TRUNCATED_BYTES = 3;

/**
 * Whether the bytes are valid UTF-8 with no NUL and no C0 control characters
 * other than tab, newline and carriage return.
 *
 * Deliberately strict, because `text/plain` is the one declared type with no
 * signature to check: the check it gets instead is "these bytes cannot be a
 * binary format pretending". A byte sequence that is not valid UTF-8 — which
 * most binary is, since `0x89` and friends are not legal UTF-8 lead bytes — is
 * not text, so a client cannot upload an arbitrary blob as a `.txt`.
 */
const looksLikeText = (buffer: Uint8Array): boolean => {
  if (buffer.length === 0) {
    return false;
  }

  for (const byte of buffer) {
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if ((byte < 0x20 && !isAllowedControl) || byte === 0x7f) {
      return false;
    }
  }

  for (let dropped = 0; dropped <= MAX_TRUNCATED_BYTES; dropped += 1) {
    const candidate = buffer.subarray(0, buffer.length - dropped);
    if (candidate.length === 0) {
      return false;
    }
    try {
      strictUtf8.decode(candidate);
      return true;
    } catch {
      // A character cut in half by the probe. Try one byte shorter.
    }
  }

  return false;
};

/** The family of the first bytes of a file. */
export const sniffFamily = (buffer: Uint8Array): ByteFamily => {
  if (matches(buffer, RIFF) && matches(buffer, WEBP_FORM)) {
    return 'webp';
  }
  if (matches(buffer, FTYP)) {
    return 'isobmff';
  }

  for (const [family, signature] of SIGNATURES) {
    if (matches(buffer, signature)) {
      return family;
    }
  }

  return looksLikeText(buffer) ? 'text' : 'unknown';
};

/**
 * Which families a declared MIME type may legitimately be. A type not on this
 * map cannot be uploaded at all: the content policy's allow-list is validated
 * against it, so a brand cannot allow something the worker has no way to check.
 */
const ALLOWED_FAMILIES: Readonly<Record<string, readonly ByteFamily[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'video/mp4': ['isobmff'],
  'video/webm': ['webm'],
  'audio/mp4': ['isobmff'],
  'audio/webm': ['webm'],
  'audio/ogg': ['ogg'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'text/plain': ['text'],
};

/** Every MIME type the pipeline can verify, which is what a policy may allow. */
export const SNIFFABLE_MIME_TYPES: readonly string[] = Object.keys(ALLOWED_FAMILIES);

export const isSniffableMime = (mime: string): boolean => Object.hasOwn(ALLOWED_FAMILIES, mime);

/**
 * Whether these bytes could be the type that was declared.
 *
 * A declared type this file cannot verify is refused, never waved through: the
 * only way to reach that state is a policy that named a type outside
 * {@link SNIFFABLE_MIME_TYPES}, and the safe answer to "I have no way to check
 * this" is no.
 */
export const bytesMatchMime = (buffer: Uint8Array, declaredMime: string): boolean => {
  const allowed = ALLOWED_FAMILIES[declaredMime];
  if (allowed === undefined) {
    return false;
  }

  return allowed.includes(sniffFamily(buffer));
};
