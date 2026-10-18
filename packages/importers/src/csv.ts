import { addAbortSignal, Readable } from 'node:stream';
import { CsvError, parse } from 'csv-parse';
import { z } from 'zod';
import { csvDelimiter } from './csv-delimiter.js';
import { csvText } from './csv-text.js';
import { ImportFileError } from './ndjson.js';

type CsvEvent =
  | { type: 'header'; columns: string[]; delimiter: string }
  | { type: 'row'; cells: string[]; line: number };

const csvRowSchema = z.object({
  record: z.array(z.string().refine((cell) => !cell.includes('\0'))).max(1024),
  raw: z.string(),
  info: z.object({ lines: z.number().int().positive() }),
});

function validateHeader(columns: string[], file: string): void {
  if (columns.some((column) => !column.trim()) || new Set(columns).size !== columns.length)
    throw new ImportFileError('invalid-csv-header', file, 1);
}

/** Cells remain strings for the mapper; no dates, numbers, or formulae are evaluated. */
export async function* readImportCsv(options: {
  stream: Readable;
  file: string;
  signal?: AbortSignal;
}): AsyncGenerator<CsvEvent> {
  if (options.signal) addAbortSignal(options.signal, options.stream);
  const text = csvText(options.stream, options.file);
  let rows: Readable | undefined;
  try {
    const detected = await csvDelimiter(text, options.file);
    const parser = parse({
      delimiter: detected.delimiter,
      max_record_size: 4 * 1024 * 1024,
      skip_empty_lines: true,
      info: true,
      raw: true,
    });
    const parsedRows = Readable.from(detected.chunks).compose(parser);
    rows = parsedRows;
    let hasHeader = false;
    let physicalLine = 1;
    for await (const raw of parsedRows) {
      options.signal?.throwIfAborted();
      const row = csvRowSchema.safeParse(raw);
      if (!row.success) throw new ImportFileError('invalid-csv', options.file);
      const newlines = row.data.raw.match(/\r\n|\r|\n/g)?.length ?? 0;
      const line = physicalLine + newlines - (/[\r\n]$/.test(row.data.raw) ? 1 : 0);
      physicalLine += newlines;
      if (!hasHeader) {
        validateHeader(row.data.record, options.file);
        hasHeader = true;
        yield { type: 'header', columns: row.data.record, delimiter: detected.delimiter };
      } else {
        yield { type: 'row', cells: row.data.record, line };
      }
    }
    if (!hasHeader) throw new ImportFileError('invalid-csv-header', options.file);
  } catch (error) {
    if (error instanceof CsvError)
      throw new ImportFileError(
        error.code === 'CSV_MAX_RECORD_SIZE' ? 'line-too-large' : 'invalid-csv',
        options.file,
        typeof error.lines === 'number' ? error.lines : undefined,
      );
    throw error;
  } finally {
    rows?.destroy();
    options.stream.destroy();
    await text.return(undefined);
  }
}
