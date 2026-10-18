import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type Connector,
  type ConnectorContext,
  ConnectorError,
  createFileRowMapper,
  type ImportCursor,
  type ImportPage,
  readImportBundle,
  readImportCsv,
} from '@helpdock/importers';
import {
  type ImportAttachmentRef,
  type ImportEntity,
  type ImportRecord,
  importEntitySchema,
  importFileMappingSchema,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { ObjectStorage } from '../../media/storage.js';
import { cachedBundleAttachment } from './bundle-cache.js';

export const fileCredentialsSchema = z.strictObject({ dataset: z.string().min(1).max(200) });
type Credentials = z.infer<typeof fileCredentialsSchema>;
export const fileBindingSchema = z.strictObject({
  id: z.uuid(),
  sourceKey: z.string().min(1).max(512),
  fileName: z.string().min(1).max(255),
  format: z.enum(['csv', 'bundle']),
  entity: importEntitySchema.nullable(),
  size: z.int().positive().max(2147483648),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mapping: importFileMappingSchema.nullable(),
});
type Binding = z.infer<typeof fileBindingSchema>;
const cursorSchema = z.strictObject({
  fileIndex: z.int().nonnegative(),
  rowOffset: z.int().nonnegative(),
});

async function* withSource<T>(
  storage: ObjectStorage,
  file: Binding,
  use: (path: string) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const directory = await mkdtemp(join(tmpdir(), 'helpdock-import-read-'));
  const path = join(directory, 'source');
  try {
    await storage.download(file.sourceKey, path, file.size);
    if ((await stat(path)).size !== file.size) throw new ConnectorError('invalid-response');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new ConnectorError('invalid-response');
    yield* use(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function* fileRows(file: Binding, path: string, entity: ImportEntity) {
  if (file.format === 'bundle') {
    for await (const event of readImportBundle({ path }))
      if (event.type === 'record' && event.record.entity === entity) yield [event.record];
    return;
  }
  if (!file.mapping) throw new ConnectorError('invalid-response');
  let mapper: ReturnType<typeof createFileRowMapper> | undefined;
  for await (const event of readImportCsv({
    stream: createReadStream(path),
    file: file.fileName,
  })) {
    if (event.type === 'header') {
      mapper = createFileRowMapper(file.mapping, event.columns);
      continue;
    }
    if (!mapper) throw new ConnectorError('invalid-response');
    const row = mapper(event.cells);
    if (!row.ok) {
      if (!file.mapping.skipInvalidRows) throw new ConnectorError('invalid-response');
      yield [];
      continue;
    }
    yield row.records.filter((record) => record.entity === entity);
  }
}

/** Local source adapter: CSV deltas rescan the snapshot and rely on account-scoped load hashes. */
export class FileImportConnector implements Connector<Credentials> {
  readonly source = 'file';
  readonly credentialsSchema = fileCredentialsSchema;
  readonly entities = importEntitySchema.options;
  constructor(
    readonly files: Binding[],
    readonly storage: ObjectStorage,
  ) {}

  async test(context: ConnectorContext<Credentials>) {
    const credentials = this.credentialsSchema.parse(context.credentials);
    return { ok: true as const, account: credentials.dataset };
  }

  async *extract(
    context: ConnectorContext<Credentials>,
    entity: ImportEntity,
    cursor: ImportCursor | null,
  ): AsyncGenerator<ImportPage> {
    this.credentialsSchema.parse(context.credentials);
    const files = this.files.filter(
      (file) =>
        file.format === 'bundle' ||
        file.entity === entity ||
        (entity === 'message' && file.mapping?.firstMessageFields !== undefined),
    );
    const position = cursorSchema.parse(cursor ?? { fileIndex: 0, rowOffset: 0 });
    if (position.fileIndex > files.length) throw new ConnectorError('invalid-response');
    for (let fileIndex = position.fileIndex; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      if (!file) throw new ConnectorError('invalid-response');
      let rowOffset = 0;
      let records: ImportRecord[] = [];
      for await (const row of withSource(this.storage, file, (path) =>
        fileRows(file, path, entity),
      )) {
        context.signal.throwIfAborted();
        rowOffset++;
        if (fileIndex === position.fileIndex && rowOffset <= position.rowOffset) continue;
        records.push(...row);
        if (records.length >= 500 || rowOffset % 500 === 0) {
          yield { records, cursor: { fileIndex, rowOffset } };
          records = [];
        }
      }
      if (fileIndex === position.fileIndex && rowOffset < position.rowOffset)
        throw new ConnectorError('invalid-response');
      yield { records, cursor: { fileIndex: fileIndex + 1, rowOffset: 0 } };
    }
    yield { records: [], cursor: null };
  }

  async fetchAttachment(context: ConnectorContext<Credentials>, ref: ImportAttachmentRef) {
    if (ref.url) {
      const response = await context.http.request(ref.url, { signal: context.signal });
      const contentType = response.headers['content-type'];
      return {
        stream: Readable.from(response.body),
        size: response.body.length,
        ...(typeof contentType === 'string' ? { contentType } : {}),
      };
    }
    const bundles = this.files.filter((file) => file.format === 'bundle');
    const bundle = bundles[0];
    if (!bundle || bundles.length !== 1 || !ref.bundlePath)
      throw new ConnectorError('record-unavailable');
    const bundlePath = ref.bundlePath;
    return {
      stream: Readable.from(
        cachedBundleAttachment(this.storage, bundle, bundlePath, context.signal),
      ),
      ...(ref.contentType ? { contentType: ref.contentType } : {}),
      ...(ref.size !== undefined ? { size: ref.size } : {}),
    };
  }

  defaultMappings() {
    // File values have no vendor vocabulary; only explicit admin mappings may select local targets.
    return [];
  }
}
