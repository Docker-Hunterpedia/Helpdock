import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  type ImportManifest,
  type ImportRecord,
  importBundlePathSchema,
  importEntitySchema,
  importManifestSchema,
} from '@helpdock/schemas';
import { type Entry, openPromise, type ZipFile } from 'yauzl';
import { ImportFileError, readImportNdjson } from './ndjson.js';
import { isInvalidUtf8 } from './utf8.js';

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MEMBERS = 100000;
const MAX_MANIFEST_BYTES = 64 * 1024;

type BundleEvent =
  | { type: 'manifest'; manifest: ImportManifest }
  | { type: 'record'; record: ImportRecord };

function memberKind(entry: Entry): 'manifest' | 'records' | 'attachment' | 'directory' {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    entry.fileName.endsWith('/') &&
    !entry.isEncrypted() &&
    entry.uncompressedSize === 0 &&
    (mode === 0 || mode === 0x4000) &&
    importBundlePathSchema.safeParse(`${entry.fileName}member`).success
  )
    return 'directory';
  if (entry.isEncrypted() || (mode !== 0 && mode !== 0x8000))
    throw new ImportFileError('invalid-bundle', 'manifest.json');
  if (entry.fileName === 'manifest.json') return 'manifest';
  if (importBundlePathSchema.safeParse(entry.fileName).success) return 'attachment';
  if (
    entry.fileName.endsWith('.ndjson') &&
    importEntitySchema.safeParse(entry.fileName.slice(0, -7)).success
  )
    return 'records';
  throw new ImportFileError('invalid-bundle', 'manifest.json');
}

async function manifestFrom(stream: Readable): Promise<ImportManifest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_MANIFEST_BYTES) {
      stream.destroy();
      throw new ImportFileError('invalid-bundle', 'manifest.json');
    }
    chunks.push(buffer);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (isInvalidUtf8(error)) throw new ImportFileError('invalid-encoding', 'manifest.json');
    if (error instanceof SyntaxError) throw new ImportFileError('invalid-json', 'manifest.json');
    throw error;
  }
  const manifest = importManifestSchema.safeParse(decoded);
  if (!manifest.success) throw new ImportFileError('invalid-bundle', 'manifest.json');
  return manifest.data;
}

async function bundleIndex(zip: ZipFile, signal?: AbortSignal): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  let expandedBytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal?.throwIfAborted();
    memberKind(entry);
    expandedBytes += entry.uncompressedSize;
    if (
      entries.has(entry.fileName) ||
      entries.size >= MAX_MEMBERS ||
      expandedBytes > MAX_BUNDLE_BYTES
    )
      throw new ImportFileError('invalid-bundle', 'manifest.json');
    entries.set(entry.fileName, entry);
  }
  return entries;
}

async function* recordsFrom(options: {
  zip: ZipFile;
  entries: Map<string, Entry>;
  manifest: ImportManifest;
  signal?: AbortSignal;
}): AsyncGenerator<BundleEvent> {
  for (const [file, entry] of options.entries) {
    if (memberKind(entry) !== 'records') continue;
    const entity = importEntitySchema.parse(file.slice(0, -7));
    let count = 0;
    const stream = await options.zip.openReadStreamPromise(entry);
    for await (const record of readImportNdjson({
      stream,
      entity,
      file,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      const refs =
        record.entity === 'message'
          ? record.payload.attachments
          : record.entity === 'attachment'
            ? [record.payload]
            : [];
      if (refs.some((ref) => ref.bundlePath !== undefined && !options.entries.has(ref.bundlePath)))
        throw new ImportFileError('invalid-bundle', file);
      count += 1;
      yield { type: 'record', record };
    }
    if (count !== options.manifest.counts[entity])
      throw new ImportFileError('invalid-bundle', file);
  }
  for (const [entity, count] of Object.entries(options.manifest.counts))
    if (count > 0 && !options.entries.has(`${entity}.ndjson`))
      throw new ImportFileError('invalid-bundle', 'manifest.json');
}

/** Validates directory metadata first, then streams each entity. No ZIP member is extracted to disk. */
export async function* readImportBundle(options: {
  path: string;
  signal?: AbortSignal;
}): AsyncGenerator<BundleEvent> {
  if ((await stat(options.path)).size > MAX_BUNDLE_BYTES)
    throw new ImportFileError('invalid-bundle', 'manifest.json');
  const zip = await openPromise(options.path, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entries = await bundleIndex(zip, options.signal);
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry || manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES)
      throw new ImportFileError('invalid-bundle', 'manifest.json');
    const manifest = await manifestFrom(await zip.openReadStreamPromise(manifestEntry));
    yield { type: 'manifest', manifest };
    yield* recordsFrom({
      zip,
      entries,
      manifest,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    zip.close();
  }
}
