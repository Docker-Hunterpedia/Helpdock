import { type DbTransaction, importFiles, importRuns } from '@helpdock/db';
import {
  enqueueOutbox,
  importFilePrepareJob,
  importFilePreparePayloadSchema,
  type OutboxDispatcher,
  outboxEvents,
} from '@helpdock/jobs';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { importFilePreparationSource } from './jobs/file-preparation-state.js';

export const IMPORT_FILE_UPLOADED_EVENT = 'import.file_uploaded';
const payloadSchema = importFilePreparePayloadSchema.omit({ brandId: true });
type FileJob = z.infer<typeof importFilePrepareJob.schema>;

export async function enqueueImportFilePreparation(tx: DbTransaction, input: FileJob) {
  const { brandId, ...payload } = importFilePrepareJob.schema.parse(input);
  await enqueueOutbox(tx, { brandId, event: IMPORT_FILE_UPLOADED_EVENT, payload });
}

export function registerImportFileEvents(
  queue: { add(payload: FileJob, jobId: string): Promise<void> },
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
) {
  dispatcher.register(IMPORT_FILE_UPLOADED_EVENT, async ({ tx, brandId, payload, outboxId }) => {
    const input = payloadSchema.parse(payload);
    const [file] = await tx
      .select({ id: importFiles.id })
      .from(importFiles)
      .innerJoin(
        importRuns,
        and(eq(importRuns.id, importFiles.runId), eq(importRuns.brandId, importFiles.brandId)),
      )
      .where(
        and(
          eq(importFiles.brandId, brandId),
          eq(importFiles.runId, input.runId),
          eq(importFiles.id, input.fileId),
          eq(importFiles.revision, input.revision),
          inArray(importFiles.status, ['uploaded', 'ready']),
          inArray(importRuns.status, ['draft', 'connecting']),
          importFilePreparationSource(),
        ),
      );
    if (file)
      await queue.add({ brandId, ...input }, `import.file_prepare.${input.fileId}.${outboxId}`);
  });
}
