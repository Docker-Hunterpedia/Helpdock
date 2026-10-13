import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { type ImportEntity, type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { withinJsonDepth } from './json-depth.js';

export class ImportFileError extends Error {
  constructor(
    readonly code: 'line-too-large' | 'invalid-json' | 'invalid-record' | 'invalid-bundle',
    readonly file: string,
    readonly line?: number,
  ) {
    super(`${file}${line === undefined ? '' : `:${line}`}: ${code}`);
    this.name = 'ImportFileError';
  }
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;

function recordLine(text: string, file: string, line: number, entity: ImportEntity): ImportRecord {
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES)
    throw new ImportFileError('line-too-large', file, line);
  if (!withinJsonDepth(text)) throw new ImportFileError('invalid-json', file, line);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImportFileError('invalid-json', file, line);
    throw error;
  }
  const parsed = importRecordSchema.safeParse({ entity, payload });
  if (!parsed.success) throw new ImportFileError('invalid-record', file, line);
  return parsed.data;
}

/** Reads payload-only NDJSON one bounded line at a time; offsets are retained in diagnostics. */
export async function* readImportNdjson(options: {
  stream: Readable;
  entity: ImportEntity;
  file: string;
  signal?: AbortSignal;
}): AsyncGenerator<ImportRecord> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let line = 0;
  try {
    for await (const chunk of options.stream) {
      options.signal?.throwIfAborted();
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        line += 1;
        const physicalLine = pending.slice(0, newline).replace(/\r$/, '');
        const text = line === 1 ? physicalLine.replace(/^\uFEFF/, '') : physicalLine;
        if (text.trim()) yield recordLine(text, options.file, line, options.entity);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
        throw new ImportFileError('line-too-large', options.file, line + 1);
    }
    pending += decoder.end();
    if (pending.trim())
      yield recordLine(
        line === 0 ? pending.replace(/^\uFEFF/, '') : pending,
        options.file,
        line + 1,
        options.entity,
      );
  } finally {
    options.stream.destroy();
  }
}
