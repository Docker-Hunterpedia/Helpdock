import { createReadStream } from 'node:fs';
import { type DbTransaction, importFiles, importTicketInventory } from '@helpdock/db';
import {
  ImportFileError,
  readTicketInventoryCsv,
  validInventoryTicketId,
} from '@helpdock/importers';
import {
  type ImportSource,
  importInventoryMappingSchema,
  importInventoryValidationSchema,
} from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

type File = typeof importFiles.$inferSelect;
type Entry = { externalId: string; location: string; line: number };
type InFile = <T>(work: (tx: DbTransaction, current: File) => Promise<T>) => Promise<T | undefined>;

/** Stage a sealed CSV in small transactions; only the final commit publishes validation. */
export async function prepareTicketInventory(input: {
  file: File;
  path: string;
  inFile: InFile;
  source: ImportSource;
}) {
  const { file, inFile } = input;
  const mapping = importInventoryMappingSchema.parse(file.inventoryMapping);
  const sourceHash = file.sha256;
  if (!sourceHash) throw new ImportFileError('invalid-record', file.fileName);
  let sourceRows = 0;
  let batch: Entry[] = [];
  const flush = async () => {
    if (!batch.length) return true;
    const rows = batch;
    batch = [];
    return (
      (await inFile(async (tx) => {
        await tx
          .insert(importTicketInventory)
          .values(
            rows.map((row) => ({
              ...row,
              brandId: file.brandId,
              runId: file.runId,
              fileId: file.id,
              revision: file.revision,
              sourceHash,
            })),
          )
          .onConflictDoNothing();
        await tx
          .update(importFiles)
          .set({ updatedAt: new Date() })
          .where(eq(importFiles.id, file.id));
        return true;
      })) === true
    );
  };
  for await (const row of readTicketInventoryCsv({
    stream: createReadStream(input.path),
    file: file.fileName,
    mapping,
  })) {
    if (!validInventoryTicketId(input.source, row.externalId))
      throw new ImportFileError('invalid-record', file.fileName, row.line);
    sourceRows++;
    batch.push(row);
    if (batch.length === 500 && !(await flush())) return;
  }
  if (!(await flush())) return;
  await inFile(async (tx) => {
    const [count] = await tx
      .select({ records: sql<string>`count(*)::text` })
      .from(importTicketInventory)
      .where(
        and(
          eq(importTicketInventory.brandId, file.brandId),
          eq(importTicketInventory.runId, file.runId),
          eq(importTicketInventory.fileId, file.id),
          eq(importTicketInventory.revision, file.revision),
          eq(importTicketInventory.sourceHash, sourceHash),
        ),
      );
    const records = z.coerce.number().int().nonnegative().safe().parse(count?.records);
    if (records > sourceRows) throw new ImportFileError('invalid-record', file.fileName);
    const validation = importInventoryValidationSchema.parse({
      kind: 'ticket-inventory',
      sourceRows,
      records,
      duplicates: sourceRows - records,
    });
    await tx
      .update(importFiles)
      .set({ inventoryValidation: { ...validation }, recordCount: records, error: null })
      .where(eq(importFiles.id, file.id));
  });
}
