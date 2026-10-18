import type { Readable } from 'node:stream';
import {
  type ImportFileMapping,
  type ImportFileRowIssue,
  importFileMappingSchema,
  importFilePreviewSchema,
  importFileValidationSchema,
} from '@helpdock/schemas';
import { readImportCsv } from './csv.js';
import { createFileRowMapper, fileHeaderFingerprint, type MappedFileRow } from './file-mapper.js';

/** Stops after twenty data rows; the import pass still validates every remaining row. */
export async function previewImportCsv(options: {
  stream: Readable;
  file: string;
  mapping: ImportFileMapping;
  signal?: AbortSignal;
}) {
  const mapping = importFileMappingSchema.parse(options.mapping);
  let headers: string[] = [];
  let delimiter = ',';
  let mapper: ReturnType<typeof createFileRowMapper> | undefined;
  const rows: { line: number; result: MappedFileRow }[] = [];
  for await (const event of readImportCsv(options)) {
    if (event.type === 'header') {
      headers = event.columns;
      delimiter = event.delimiter;
      mapper = createFileRowMapper(mapping, headers);
      continue;
    }
    if (!mapper) throw new Error('import.file-header-missing');
    rows.push({ line: event.line, result: mapper(event.cells) });
    if (rows.length === 20) break;
  }
  return importFilePreviewSchema.parse({
    headers,
    delimiter,
    headerFingerprint: fileHeaderFingerprint(headers),
    rows,
  });
}

/** A preview is not approval: scan every row before allowing any file records to be staged. */
export async function validateImportCsv(options: {
  stream: Readable;
  file: string;
  mapping: ImportFileMapping;
  signal?: AbortSignal;
}) {
  const mapping = importFileMappingSchema.parse(options.mapping);
  let headers: string[] = [];
  let delimiter = ',';
  let checkedRows = 0;
  let mapper: ReturnType<typeof createFileRowMapper> | undefined;
  let invalidRows = 0;
  let records = 0;
  const rows: { line: number; result: MappedFileRow }[] = [];
  const issues: { line: number; issue: ImportFileRowIssue }[] = [];
  for await (const event of readImportCsv(options)) {
    if (event.type === 'header') {
      headers = event.columns;
      delimiter = event.delimiter;
      mapper = createFileRowMapper(mapping, headers);
      continue;
    }
    if (!mapper) throw new Error('import.file-header-missing');
    const result = mapper(event.cells);
    checkedRows += 1;
    if (rows.length < 20) rows.push({ line: event.line, result });
    if (result.ok) {
      records += result.records.length;
      continue;
    }
    invalidRows += 1;
    for (const issue of result.issues) {
      if (issues.length === 100) break;
      issues.push({ line: event.line, issue });
    }
  }
  return importFileValidationSchema.parse({
    preview: { headers, delimiter, headerFingerprint: fileHeaderFingerprint(headers), rows },
    checkedRows,
    invalidRows,
    records,
    issues,
  });
}
