import { auditLog, importFiles, importRuns, uuidv7 } from '@helpdock/db';
import { fileHeaderFingerprint } from '@helpdock/importers';
import {
  type ImportFileMapping,
  type ImportFileSourceRequest,
  type ImportFileUploadRequest,
  type ImportInventoryMapping,
  importFileListSchema,
  importFileMappingSchema,
  importFileSourceRequestSchema,
  importFileUploadRequestSchema,
  importFileUploadResponseSchema,
  importFileViewSchema,
  importInventoryMappingSchema,
  safeFileName,
} from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { ObjectStorage } from '../media/storage.js';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { enqueueImportFilePreparation } from './file-events.js';
import { importRunView } from './import-run-view.js';
import { lockImportBrand } from './jobs/claims.js';
import { bindImportSourceAccount, sourceAccountKey } from './jobs/source-account.js';
import { ImportLoadError } from './loader/contracts.js';
import { TICKET_INVENTORY_SOURCES } from './sources.js';

export function importFileView(row: typeof importFiles.$inferSelect) {
  return importFileViewSchema.parse({
    id: row.id,
    runId: row.runId,
    revision: row.revision,
    fileName: row.fileName,
    format: row.format,
    entity: row.entity,
    size: row.size,
    status: row.status,
    headers: row.headers,
    headerFingerprint: row.headers ? fileHeaderFingerprint(row.headers) : null,
    sampleRows: row.sampleRows,
    mapping: row.mapping,
    inventoryMapping: row.inventoryMapping,
    inventoryValidation: row.inventoryValidation,
    validation: row.validation,
    recordCount: row.recordCount,
    error: row.error,
  });
}

export class ImportFilesService {
  constructor(readonly storage: ObjectStorage) {}

  async connect(context: TicketingContext, runId: string, raw: ImportFileSourceRequest) {
    const input = importFileSourceRequestSchema.parse(raw);
    const run = await this.editable(context, runId);
    if (run.source !== 'file') throw new ConflictException('import.phase-invalid');
    const key = sourceAccountKey({ source: 'file', verifiedAccount: input.dataset });
    if (run.sourceAccountKey !== '0'.repeat(64) && run.sourceAccountKey !== key)
      throw new ConflictException('import.account-mismatch');
    try {
      await bindImportSourceAccount(context.tx, {
        brandId: context.brandId,
        runId,
        verifiedAccount: input.dataset,
      });
    } catch (error) {
      if (error instanceof ImportLoadError) throw new ConflictException('import.account-mismatch');
      throw error;
    }
    const [updated] = await context.tx
      .update(importRuns)
      .set({
        status: 'connecting',
        options: sql`${importRuns.options} || ${JSON.stringify({ fileDataset: input.dataset, downloadHosts: input.downloadHosts })}::jsonb`,
      })
      .where(eq(importRuns.id, runId))
      .returning();
    if (!updated) throw new Error('import.file-connect-failed');
    await this.audit(context, 'import.file-source-connected', runId);
    return importRunView(updated);
  }

  private async editable(context: TicketingContext, runId: string) {
    await lockImportBrand(context.tx, context.brandId);
    const [run] = await context.tx
      .select()
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.brandId, context.brandId)))
      .for('update');
    if (!run) throw new NotFoundException('import.run-not-found');
    if (
      (run.source !== 'file' && !TICKET_INVENTORY_SOURCES.includes(run.source)) ||
      !['draft', 'connecting'].includes(run.status)
    )
      throw new ConflictException('import.phase-invalid');
    return run;
  }

  private async file(context: TicketingContext, runId: string, fileId: string) {
    const [file] = await context.tx
      .select()
      .from(importFiles)
      .where(
        and(
          eq(importFiles.brandId, context.brandId),
          eq(importFiles.runId, runId),
          eq(importFiles.id, fileId),
        ),
      )
      .for('update');
    if (!file) throw new NotFoundException('import.file-not-found');
    return file;
  }

  async list(context: TicketingContext, runId: string) {
    const [run] = await context.tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(and(eq(importRuns.id, runId), eq(importRuns.brandId, context.brandId)));
    if (!run) throw new NotFoundException('import.run-not-found');
    const files = await context.tx
      .select({
        id: importFiles.id,
        runId: importFiles.runId,
        revision: importFiles.revision,
        fileName: importFiles.fileName,
        format: importFiles.format,
        entity: importFiles.entity,
        size: importFiles.size,
        status: importFiles.status,
        inventoryMapping: importFiles.inventoryMapping,
        inventoryValidation: importFiles.inventoryValidation,
        recordCount: importFiles.recordCount,
        error: importFiles.error,
        hasMapping: sql<boolean>`${importFiles.mapping} IS NOT NULL`,
        hasHeaders: sql<boolean>`${importFiles.headers} IS NOT NULL`,
        validationPending: sql<boolean>`${importFiles.status} = 'uploaded' OR (
          ${importFiles.status} = 'ready' AND (
            (${importFiles.mapping} IS NOT NULL AND ${importFiles.validation} IS NULL) OR
            (${importFiles.inventoryMapping}->>'idColumn' IS NOT NULL AND ${importFiles.inventoryValidation} IS NULL)))`,
        readyForExtraction: sql<boolean>`coalesce(${importFiles.status} = 'ready' AND CASE
          WHEN ${importFiles.inventoryMapping} IS NOT NULL THEN ${importFiles.inventoryValidation} IS NOT NULL
          WHEN ${importFiles.format} = 'bundle' THEN TRUE
          ELSE ${importFiles.validation} IS NOT NULL AND (
            ${importFiles.validation}->>'invalidRows' = '0' OR ${importFiles.mapping}->>'skipInvalidRows' = 'true') END, FALSE)`,
      })
      .from(importFiles)
      .where(
        and(
          eq(importFiles.brandId, context.brandId),
          eq(importFiles.runId, runId),
          ne(importFiles.status, 'discarded'),
        ),
      )
      .orderBy(asc(importFiles.id))
      .limit(100);
    return importFileListSchema.parse({ files });
  }

  async get(context: TicketingContext, runId: string, fileId: string) {
    const [file] = await context.tx
      .select()
      .from(importFiles)
      .where(
        and(
          eq(importFiles.brandId, context.brandId),
          eq(importFiles.runId, runId),
          eq(importFiles.id, fileId),
          ne(importFiles.status, 'discarded'),
        ),
      );
    if (!file) throw new NotFoundException('import.file-not-found');
    return importFileView(file);
  }

  async upload(context: TicketingContext, runId: string, raw: ImportFileUploadRequest) {
    const input = importFileUploadRequestSchema.parse(raw);
    const run = await this.editable(context, runId);
    const inventoryMapping = input.format === 'csv' ? input.inventoryMapping : undefined;
    if (
      (run.source === 'file' && inventoryMapping !== undefined) ||
      (run.source !== 'file' &&
        (input.format !== 'csv' || input.entity !== 'ticket' || inventoryMapping === undefined))
    )
      throw new BadRequestException('import.file-purpose-invalid');
    if (run.status !== 'connecting' || run.sourceAccountKey === '0'.repeat(64))
      throw new ConflictException('import.phase-invalid');
    const existing = await context.tx
      .select({ format: importFiles.format })
      .from(importFiles)
      .where(
        and(
          eq(importFiles.brandId, context.brandId),
          eq(importFiles.runId, runId),
          ne(importFiles.status, 'discarded'),
        ),
      )
      .limit(100);
    if (existing.length >= 100) throw new BadRequestException('import.file-limit');
    if (
      existing.some((file) => file.format === 'bundle') ||
      (input.format === 'bundle' && existing.length > 0)
    )
      throw new BadRequestException('import.bundle-exclusive');
    const id = uuidv7();
    const uploadKey = `brands/${context.brandId}/imports/${runId}/files/${id}/upload`;
    const [file] = await context.tx
      .insert(importFiles)
      .values({
        id,
        brandId: context.brandId,
        runId,
        fileName: safeFileName(input.fileName),
        format: input.format,
        entity: input.format === 'csv' ? input.entity : null,
        inventoryMapping: inventoryMapping === undefined ? null : { ...inventoryMapping },
        size: input.size,
        uploadKey,
      })
      .returning();
    if (!file) throw new Error('import.file-create-failed');
    const upload = await this.storage.presignUpload({
      key: uploadKey,
      size: input.size,
      contentType: input.format === 'csv' ? 'text/csv' : 'application/zip',
    });
    await this.audit(context, 'import.file-upload-requested', id);
    return importFileUploadResponseSchema.parse({
      file: importFileView(file),
      url: upload.url,
      headers: { ...upload.headers },
      expiresAt: upload.expiresAt.toISOString(),
    });
  }

  async confirm(context: TicketingContext, runId: string, fileId: string) {
    await this.editable(context, runId);
    const file = await this.file(context, runId, fileId);
    if (file.status !== 'pending') return importFileView(file);
    const head = await this.storage.head(file.uploadKey);
    if (!head || head.size !== file.size)
      throw new BadRequestException('import.file-size-mismatch');
    const [updated] = await context.tx
      .update(importFiles)
      .set({ status: 'uploaded' })
      .where(eq(importFiles.id, file.id))
      .returning();
    if (!updated) throw new Error('import.file-confirm-failed');
    await enqueueImportFilePreparation(context.tx, {
      brandId: context.brandId,
      runId,
      fileId,
      revision: file.revision,
    });
    await this.audit(context, 'import.file-confirmed', fileId);
    return importFileView(updated);
  }

  async mapping(context: TicketingContext, runId: string, fileId: string, raw: ImportFileMapping) {
    const mapping = importFileMappingSchema.parse(raw);
    await this.editable(context, runId);
    const file = await this.file(context, runId, fileId);
    if (
      file.status !== 'ready' ||
      file.format !== 'csv' ||
      mapping.entity !== file.entity ||
      file.inventoryMapping !== null
    )
      throw new ConflictException('import.file-not-ready');
    if (
      [...mapping.fields, ...(mapping.firstMessageFields ?? [])].some(
        (field) =>
          field.source.kind === 'columns' &&
          field.source.names.some((name) => !file.headers?.includes(name)),
      )
    )
      throw new BadRequestException('import.missing-column');
    const revision = uuidv7();
    const [updated] = await context.tx
      .update(importFiles)
      .set({ revision, mapping: { ...mapping }, validation: null, recordCount: null, error: null })
      .where(eq(importFiles.id, fileId))
      .returning();
    if (!updated) throw new Error('import.file-mapping-failed');
    await enqueueImportFilePreparation(context.tx, {
      brandId: context.brandId,
      runId,
      fileId,
      revision,
    });
    await this.audit(context, 'import.file-mapping-saved', fileId);
    return importFileView(updated);
  }

  async discard(context: TicketingContext, runId: string, fileId: string) {
    await this.editable(context, runId);
    const file = await this.file(context, runId, fileId);
    if (file.status === 'discarded') return { deleted: true as const };
    // Keep object pointers through retention: an upload already in flight can still finish.
    await context.tx
      .update(importFiles)
      .set({ status: 'discarded', revision: uuidv7() })
      .where(and(eq(importFiles.brandId, context.brandId), eq(importFiles.id, fileId)));
    await this.audit(context, 'import.file-discarded', fileId);
    return { deleted: true as const };
  }

  async inventoryMapping(
    context: TicketingContext,
    runId: string,
    fileId: string,
    raw: ImportInventoryMapping,
  ) {
    const mapping = importInventoryMappingSchema.parse(raw);
    const run = await this.editable(context, runId);
    const file = await this.file(context, runId, fileId);
    if (
      !TICKET_INVENTORY_SOURCES.includes(run.source) ||
      file.inventoryMapping === null ||
      file.format !== 'csv' ||
      !['ready', 'invalid'].includes(file.status) ||
      !file.sourceKey ||
      !file.sha256
    )
      throw new ConflictException('import.file-not-ready');
    if (mapping.idColumn !== null && !file.headers?.includes(mapping.idColumn))
      throw new BadRequestException('import.missing-column');
    const revision = uuidv7();
    const [updated] = await context.tx
      .update(importFiles)
      .set({
        inventoryMapping: { ...mapping },
        inventoryValidation: null,
        revision,
        validation: null,
        recordCount: null,
        error: null,
        status: 'ready',
      })
      .where(eq(importFiles.id, fileId))
      .returning();
    if (!updated) throw new Error('import.inventory-mapping-failed');
    if (mapping.idColumn !== null)
      await enqueueImportFilePreparation(context.tx, {
        brandId: context.brandId,
        runId,
        fileId,
        revision,
      });
    await this.audit(context, 'import.inventory-mapping-saved', fileId);
    return importFileView(updated);
  }

  private async audit({ tx, brandId, actor }: TicketingContext, action: string, targetId: string) {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'import_file',
      targetId,
      meta: {},
    });
  }
}
