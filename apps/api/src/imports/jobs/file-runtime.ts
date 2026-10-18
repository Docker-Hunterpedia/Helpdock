import { type Db, type DbTransaction, importFiles, type importRuns } from '@helpdock/db';
import {
  type ConnectorContext,
  ConnectorError,
  ImportHttp,
  ImportRateLimiter,
} from '@helpdock/importers';
import {
  importDownloadHostSchema,
  importFileMappingSchema,
  importFileValidationSchema,
} from '@helpdock/schemas';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { ObjectStorage } from '../../media/storage.js';
import { withSystemJob } from '../../tenant/system-job.js';
import type { ImportRunRef } from './claims.js';
import { FileImportConnector, fileBindingSchema, fileCredentialsSchema } from './file-connector.js';
import { sourceAccountKey } from './source-account.js';

export async function preparedImportFiles(tx: DbTransaction, run: ImportRunRef) {
  const rows = await tx
    .select({
      id: importFiles.id,
      revision: importFiles.revision,
      sourceKey: importFiles.sourceKey,
      sha256: importFiles.sha256,
      format: importFiles.format,
      entity: importFiles.entity,
      size: importFiles.size,
      fileName: importFiles.fileName,
      mapping: importFiles.mapping,
      validation: importFiles.validation,
      status: importFiles.status,
      inventoryMapping: importFiles.inventoryMapping,
    })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.brandId, run.brandId),
        eq(importFiles.runId, run.runId),
        ne(importFiles.status, 'discarded'),
      ),
    )
    .orderBy(asc(importFiles.id))
    .limit(101);
  if (rows.length === 0 || rows.length > 100 || rows.some((file) => file.status !== 'ready'))
    throw new ConnectorError('invalid-response');
  const files = rows.map((row) => {
    if (row.inventoryMapping !== null) throw new ConnectorError('invalid-response');
    if (
      !row.sourceKey?.startsWith(
        `brands/${run.brandId}/imports/${run.runId}/files/${row.id}/sealed-`,
      )
    )
      throw new ConnectorError('invalid-response');
    if (
      row.format === 'csv' &&
      (!row.mapping ||
        !row.validation ||
        (importFileValidationSchema.parse(row.validation).invalidRows !== 0 &&
          !importFileMappingSchema.parse(row.mapping).skipInvalidRows))
    )
      throw new ConnectorError('invalid-response');
    const file = fileBindingSchema.parse({
      id: row.id,
      sourceKey: row.sourceKey,
      fileName: row.fileName,
      format: row.format,
      entity: row.entity,
      size: row.size,
      sha256: row.sha256,
      mapping: row.mapping,
    });
    if (file.format === 'csv' && file.mapping?.entity !== file.entity)
      throw new ConnectorError('invalid-response');
    return file;
  });
  if (files.some((file) => file.format === 'bundle') && files.length !== 1)
    throw new ConnectorError('invalid-response');
  return files;
}

export async function createFileImportRuntime(
  deps: { db: Db; storage: ObjectStorage; allowCidrs: readonly string[] },
  run: typeof importRuns.$inferSelect,
  log: ConnectorContext<unknown>['log'],
): Promise<{
  connector: FileImportConnector;
  context: ConnectorContext<z.infer<typeof fileCredentialsSchema>>;
}> {
  const options = z
    .object({
      fileDataset: z.string().min(1).max(200),
      downloadHosts: z.array(importDownloadHostSchema).max(32).default([]),
    })
    .parse(run.options);
  const credentials = fileCredentialsSchema.parse({ dataset: options.fileDataset });
  if (
    run.sourceAccountKey !==
    sourceAccountKey({ source: 'file', verifiedAccount: credentials.dataset })
  )
    throw new ConnectorError('credentials-refused');
  const files = await withSystemJob(deps.db, run.brandId, 'import.files', (tx) =>
    preparedImportFiles(tx, { brandId: run.brandId, runId: run.id }),
  );
  return {
    connector: new FileImportConnector(files, deps.storage),
    context: {
      credentials,
      log,
      signal: new AbortController().signal,
      http: new ImportHttp({
        hosts: options.downloadHosts,
        limiter: new ImportRateLimiter({ capacity: 10, perMinute: 60, resumeTokens: 10 }),
        policy: {
          allowCidrs: deps.allowCidrs,
          allowedPorts: [443],
          maxBodyBytes: 50 * 1024 * 1024,
        },
      }),
    },
  };
}
