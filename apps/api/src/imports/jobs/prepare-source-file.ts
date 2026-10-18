import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type DbTransaction, importFiles, importLog, uuidv7 } from '@helpdock/db';
import {
  ImportFileError,
  readImportBundle,
  readImportCsv,
  validateImportCsv,
} from '@helpdock/importers';
import { importFilePrepareJob } from '@helpdock/jobs';
import { importFileMappingSchema, importInventoryMappingSchema } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type ObjectStorage, ObjectTooLargeError } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import { purgeImportFileKeys } from '../file-cleanup.js';
import { enqueueImportFilePreparation } from '../file-events.js';
import { availableImportSourceFile as availableFile } from './file-preparation-state.js';
import { prepareTicketInventory } from './prepare-ticket-inventory.js';

type Input = z.infer<typeof importFilePrepareJob.schema>;
type File = typeof importFiles.$inferSelect;
type Dependencies = { db: Db; storage: ObjectStorage };

async function sourceHash(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function inspectCsv(path: string, fileName: string) {
  let headers: string[] | null = null;
  const sampleRows: NonNullable<File['sampleRows']> = [];
  for await (const event of readImportCsv({ stream: createReadStream(path), file: fileName })) {
    if (event.type === 'header') {
      headers = event.columns;
      continue;
    }
    sampleRows.push({
      line: event.line,
      truncated: event.cells.some((cell) => cell.length > 1000),
      cells: event.cells.map((cell) => cell.slice(0, 1000)),
    });
    if (sampleRows.length === 20) break;
  }
  return { headers, sampleRows, recordCount: null };
}

async function inspectBundle(path: string) {
  let recordCount = 0;
  for await (const event of readImportBundle({ path }))
    if (event.type === 'record') recordCount += 1;
  return { headers: null, sampleRows: null, recordCount };
}

/** Disk-backed preparation; published source objects are never writable by the browser. */
export async function prepareImportSourceFile(deps: Dependencies, raw: Input) {
  const input = importFilePrepareJob.schema.parse(raw);
  const inRun = <T>(work: (tx: DbTransaction) => Promise<T>) =>
    withSystemJob(deps.db, input.brandId, 'import.file_prepare', work);
  const file = await inRun(async (tx) => {
    const row = await availableFile(tx, input);
    if (!row) return null;
    if (row.status === 'ready') {
      if (row.inventoryMapping !== null) {
        const mapping = importInventoryMappingSchema.parse(row.inventoryMapping);
        return mapping.idColumn !== null && row.inventoryValidation === null ? row : null;
      }
      return row.mapping && row.validation === null ? row : null;
    }
    const key = `brands/${input.brandId}/imports/${input.runId}/files/${input.fileId}/sealed-${uuidv7()}`;
    await purgeImportFileKeys(tx, input.brandId, [row.preparationKey]);
    await tx
      .update(importFiles)
      .set({ preparationKey: key })
      .where(eq(importFiles.id, input.fileId));
    return { ...row, preparationKey: key };
  });
  if (!file) return;
  const directory = await mkdtemp(join(tmpdir(), 'helpdock-import-source-'));
  const path = join(directory, 'source');
  try {
    await deps.storage.download(file.sourceKey ?? file.uploadKey, path, file.size);
    if ((await stat(path)).size !== file.size)
      throw new ImportFileError('invalid-record', file.fileName);
    const sha256 = await sourceHash(path);
    if (file.sha256 !== null && file.sha256 !== sha256)
      throw new ImportFileError('invalid-record', file.fileName);
    if (file.status === 'ready' && file.inventoryMapping !== null) {
      await prepareTicketInventory({
        file,
        source: file.source,
        path,
        inFile: (work) =>
          inRun(async (tx) => {
            const current = await availableFile(tx, input);
            if (
              current?.status !== 'ready' ||
              current.sourceKey !== file.sourceKey ||
              current.sha256 !== sha256 ||
              current.inventoryValidation !== null
            )
              return undefined;
            return work(tx, current);
          }),
      });
      return;
    }
    if (file.status === 'ready') {
      const validation = await validateImportCsv({
        stream: createReadStream(path),
        file: file.fileName,
        mapping: importFileMappingSchema.parse(file.mapping),
      });
      await inRun(async (tx) => {
        const current = await availableFile(tx, input);
        if (
          current?.status !== 'ready' ||
          current.sourceKey !== file.sourceKey ||
          current.validation !== null
        )
          return;
        await tx
          .update(importFiles)
          .set({ validation: { ...validation }, recordCount: validation.records })
          .where(eq(importFiles.id, file.id));
        if (
          validation.invalidRows > 0 &&
          importFileMappingSchema.parse(current.mapping).skipInvalidRows
        ) {
          await tx.insert(importLog).values({
            brandId: input.brandId,
            runId: input.runId,
            level: 'warning',
            entity: current.entity,
            externalId: current.id,
            message: `import.file-rows-skipped:${validation.invalidRows}`,
          });
        }
      });
      return;
    }
    const inspected =
      file.format === 'csv' ? await inspectCsv(path, file.fileName) : await inspectBundle(path);
    if (!file.preparationKey) throw new Error('import.file-reservation-missing');
    await deps.storage.upload({
      key: file.preparationKey,
      path,
      contentType: file.format === 'csv' ? 'text/csv' : 'application/zip',
    });
    await inRun(async (tx) => {
      const current = await availableFile(tx, input);
      if (current?.status !== 'uploaded' || current.preparationKey !== file.preparationKey) {
        await purgeImportFileKeys(tx, input.brandId, [file.preparationKey]);
        return;
      }
      await tx
        .update(importFiles)
        .set({
          ...inspected,
          sourceKey: file.preparationKey,
          preparationKey: null,
          sha256,
          status: 'ready',
          error: null,
        })
        .where(eq(importFiles.id, file.id));
      if (
        file.inventoryMapping !== null &&
        importInventoryMappingSchema.parse(file.inventoryMapping).idColumn !== null
      )
        await enqueueImportFilePreparation(tx, input);
    });
  } catch (error) {
    if (!(error instanceof ImportFileError) && !(error instanceof ObjectTooLargeError)) throw error;
    await inRun(async (tx) => {
      const current = await availableFile(tx, input);
      if (!current || current.preparationKey !== file.preparationKey) return;
      await purgeImportFileKeys(tx, input.brandId, [file.preparationKey]);
      await tx
        .update(importFiles)
        .set({
          status: 'invalid',
          preparationKey: null,
          error:
            error instanceof ImportFileError
              ? `${error.code}${file.inventoryMapping !== null && error.line !== undefined ? `:${error.line}` : ''}`
              : 'file-too-large',
        })
        .where(eq(importFiles.id, file.id));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
