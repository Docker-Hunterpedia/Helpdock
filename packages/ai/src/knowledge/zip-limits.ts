import { inflateRawSync } from 'node:zlib';

/**
 * A DOCX is a ZIP, and mammoth (through JSZip) inflates every entry it reads
 * into memory, so a few hundred kilobytes can unpack to gigabytes (ASVS 12.1.2).
 * The 25 MB upload cap bounds the archive, not what is inside it. This reads
 * the archive's central directory the way JSZip does and refuses it before
 * mammoth sees it when it holds too many entries or declares too much data.
 *
 * A directory can lie, and JSZip notices only after it has inflated an entry
 * ("uncompressed data size mismatch"), so each entry is also inflated here
 * against its declared size, which stops it at that size and keeps what is
 * held at most the cap.
 */

export const DOCX_MAX_ENTRIES = 1_000;
export const DOCX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export class ArchiveRejectedError extends Error {
  constructor(reason: string) {
    super(`the file ${reason}`);
    this.name = 'ArchiveRejectedError';
  }
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;
/** The end record may be followed by a comment of at most this many bytes. */
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;
/**
 * Where JSZip (lib/zipEntries.js, readEndOfCentral) looks in the end record to
 * decide an archive is ZIP64: any one of these fields at its maximum. It then
 * takes the directory from a ZIP64 record found by the locator signature
 * anywhere in the file, which this reader never follows.
 */
const ZIP64_FIELDS_16 = [4, 6, 8, 10] as const;
const ZIP64_FIELDS_32 = [12, 16] as const;
const ZIP64_LOCATOR = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
const STORED = 0;
const DEFLATED = 8;

interface CentralRecord {
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

const unreadable = () => new ArchiveRejectedError('is not a readable ZIP archive');
const zip64 = () => new ArchiveRejectedError('is a ZIP64 archive, which a document never needs');

/** The last end record, as JSZip finds it, so both read the same directory. */
const findEnd = (view: DataView): number => {
  const lowest = Math.max(0, view.byteLength - END_LENGTH - MAX_COMMENT_LENGTH);
  for (let at = view.byteLength - END_LENGTH; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) {
      return at;
    }
  }
  throw unreadable();
};

const declaresZip64 = (view: DataView, end: number): boolean =>
  ZIP64_FIELDS_16.some((field) => view.getUint16(end + field, true) === ZIP64_MARKER_16) ||
  ZIP64_FIELDS_32.some((field) => view.getUint32(end + field, true) === ZIP64_MARKER);

const readCentralDirectory = (view: DataView): readonly CentralRecord[] => {
  const end = findEnd(view);
  if (declaresZip64(view, end)) {
    throw zip64();
  }
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  // A directory that does not end where the end record starts has bytes in
  // front of it or after it, which JSZip tolerates and this check could not
  // vouch for.
  if (directoryOffset + directorySize !== end) {
    throw unreadable();
  }

  // Not bounded by the count the end record states: JSZip reads records until
  // the signature stops matching.
  const records: CentralRecord[] = [];
  let at = directoryOffset;
  while (at + CENTRAL_LENGTH <= end && view.getUint32(at, true) === CENTRAL_SIGNATURE) {
    if (records.length === DOCX_MAX_ENTRIES) {
      throw new ArchiveRejectedError(`holds more than ${DOCX_MAX_ENTRIES} entries`);
    }
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw zip64();
    }
    records.push({
      method: view.getUint16(at + 10, true),
      compressedSize,
      uncompressedSize,
      localOffset: view.getUint32(at + 42, true),
    });
    at +=
      CENTRAL_LENGTH +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  if (at !== end) {
    throw unreadable();
  }
  return records;
};

/** Inflates one entry no further than it declares; throws if it holds more. */
const verifyEntry = (bytes: Uint8Array, view: DataView, record: CentralRecord): void => {
  const { method, compressedSize, uncompressedSize, localOffset } = record;
  if (
    localOffset + LOCAL_LENGTH > view.byteLength ||
    view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
  ) {
    throw unreadable();
  }
  const start =
    localOffset +
    LOCAL_LENGTH +
    view.getUint16(localOffset + 26, true) +
    view.getUint16(localOffset + 28, true);
  const stored = bytes.subarray(start, start + compressedSize);
  if (stored.length !== compressedSize || (method !== STORED && method !== DEFLATED)) {
    throw unreadable();
  }

  let actual = stored.length;
  if (method === DEFLATED) {
    try {
      actual = inflateRawSync(stored, { maxOutputLength: Math.max(1, uncompressedSize) }).length;
    } catch (error) {
      // maxOutputLength is the only RangeError inflate raises; any other error is bad data.
      throw new ArchiveRejectedError(
        error instanceof RangeError
          ? 'holds an entry that unpacks to more than its directory says'
          : 'holds a corrupt entry',
      );
    }
  }
  if (actual !== uncompressedSize) {
    throw new ArchiveRejectedError('holds an entry that does not match its directory');
  }
};

/** Throws `ArchiveRejectedError` unless the archive is small enough to unpack. */
export const assertArchiveWithinLimits = (bytes: Uint8Array): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // JSZip finds the locator by scanning the whole file, so one anywhere in it
  // can steer JSZip to a directory this check never reads.
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ZIP64_LOCATOR)) {
    throw zip64();
  }
  const records = readCentralDirectory(view);

  const declared = records.reduce((sum, record) => sum + record.uncompressedSize, 0);
  if (declared > DOCX_MAX_UNCOMPRESSED_BYTES) {
    throw new ArchiveRejectedError(
      `unpacks to more than ${DOCX_MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MiB`,
    );
  }
  for (const record of records) {
    verifyEntry(bytes, view, record);
  }
};
