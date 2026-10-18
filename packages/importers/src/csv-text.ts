import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { ImportFileError } from './ndjson.js';
import { isInvalidUtf8 } from './utf8.js';

/** BOMs select UTF-16 byte order; files without a BOM use strict UTF-8. */
export async function* csvText(stream: Readable, file: string): AsyncGenerator<string> {
  let prefix = Buffer.alloc(0);
  let decoder: TextDecoder | undefined;
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 2 * 1024 * 1024 * 1024) throw new ImportFileError('file-too-large', file);
      if (decoder) {
        yield decoder.decode(buffer, { stream: true });
        continue;
      }
      prefix = Buffer.concat([prefix, buffer]);
      if (prefix.length < 3) continue;
      const encoding =
        prefix[0] === 0xff && prefix[1] === 0xfe
          ? 'utf-16le'
          : prefix[0] === 0xfe && prefix[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      decoder = new TextDecoder(encoding, { fatal: true });
      yield decoder.decode(prefix, { stream: true });
      prefix = Buffer.alloc(0);
    }
    yield decoder ? decoder.decode() : new TextDecoder('utf-8', { fatal: true }).decode(prefix);
  } catch (error) {
    if (isInvalidUtf8(error)) throw new ImportFileError('invalid-encoding', file);
    throw error;
  }
}
