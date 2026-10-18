import type { Readable } from 'node:stream';
import {
  type ImportInventoryMapping,
  importInventoryEntrySchema,
  importInventoryMappingSchema,
} from '@helpdock/schemas';
import { readImportCsv } from './csv.js';
import { ImportFileError } from './ndjson.js';

/** The operator selects the native-ID column explicitly; no numbers or spreadsheet formulas are evaluated. */
export async function* readTicketInventoryCsv(input: {
  stream: Readable;
  file: string;
  mapping: ImportInventoryMapping;
  signal?: AbortSignal;
}) {
  try {
    const mapping = importInventoryMappingSchema.parse(input.mapping);
    if (mapping.idColumn === null) throw new ImportFileError('invalid-csv-header', input.file, 1);
    let column = -1;
    for await (const event of readImportCsv(input)) {
      if (event.type === 'header') {
        column = event.columns.indexOf(mapping.idColumn);
        if (column < 0) throw new ImportFileError('invalid-csv-header', input.file, 1);
        continue;
      }
      const row = importInventoryEntrySchema.safeParse({
        externalId: event.cells[column],
        location: mapping.location,
      });
      if (!row.success) throw new ImportFileError('invalid-record', input.file, event.line);
      yield { ...row.data, line: event.line };
    }
  } finally {
    input.stream.destroy();
  }
}
