import type * as schemas from '@helpdock/schemas';
import type { z } from 'zod';
import type { PutObject } from '../media/upload.js';

type Value<K extends keyof typeof schemas> = (typeof schemas)[K] extends z.ZodType
  ? z.infer<(typeof schemas)[K]>
  : never;
export type ImportFileView = Value<'importFileViewSchema'>;
export type ImportFilePreset = Value<'importFilePresetViewSchema'>;
export type ImportFileUpload = Value<'importFileUploadResponseSchema'>;

export interface ImportsApi {
  readonly putFile: PutObject;
  sla(brandId: string, runId: string): Promise<schemas.ImportSlaOverview>;
  startSla(brandId: string, runId: string): Promise<schemas.ImportSlaOverview>;
  log(
    brandId: string,
    runId: string,
    query: schemas.ImportLogQuery,
  ): Promise<schemas.ImportLogPage>;
  exportLog(brandId: string, runId: string, query: schemas.ImportLogExportQuery): Promise<Blob>;
  mappingTargets(
    brandId: string,
    runId: string,
    query: schemas.ImportMappingTargetsQuery,
  ): Promise<Value<'importMappingTargetsSchema'>>;
  mappingField(
    brandId: string,
    runId: string,
    query: schemas.ImportMappingFieldQuery,
  ): Promise<Value<'importFieldSchema'>>;
  sources(brandId: string): Promise<Value<'importSupportedSourcesSchema'>>;
  mappingValues(
    brandId: string,
    runId: string,
    query: schemas.ImportMappingValuesQuery,
  ): Promise<Value<'importMappingValuesSchema'>>;
  updateMappings(
    brandId: string,
    runId: string,
    input: schemas.ImportMappingPageRequest,
  ): Promise<Value<'importMappingPageResultSchema'>>;
  runs(brandId: string): Promise<Value<'importRunListSchema'>>;
  run(brandId: string, runId: string): Promise<Value<'importRunViewSchema'>>;
  create(brandId: string, input: schemas.ImportRunCreate): Promise<schemas.ImportRunView>;
  connect(
    brandId: string,
    runId: string,
    input: schemas.ImportConnectionRequest,
  ): Promise<Value<'importConnectionResultSchema'>>;
  scope(brandId: string, runId: string, input: schemas.ImportScope): Promise<schemas.ImportRunView>;
  extract(brandId: string, runId: string): Promise<schemas.ImportRunView>;
  mappings(brandId: string, runId: string): Promise<Value<'importMappingsViewSchema'>>;
  saveMappings(
    brandId: string,
    runId: string,
    input: schemas.ImportMappingsRequest,
  ): Promise<Value<'importMappingsViewSchema'>>;
  dryRun(
    brandId: string,
    runId: string,
    input: schemas.ImportDryRunRequest,
  ): Promise<schemas.ImportRunView>;
  report(brandId: string, runId: string): Promise<Value<'importDryRunReportSchema'>>;
  start(
    brandId: string,
    runId: string,
    input: schemas.ImportStartRequest,
  ): Promise<schemas.ImportRunView>;
  control(
    brandId: string,
    runId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<schemas.ImportRunView>;
  samples(brandId: string, runId: string): Promise<Value<'importPreviewSamplesSchema'>>;
  ticketPreview(
    brandId: string,
    runId: string,
    query: schemas.ImportTicketPreviewQuery,
  ): Promise<Value<'importTicketPreviewSchema'>>;
  contactPreview(
    brandId: string,
    runId: string,
    query: schemas.ImportContactPreviewQuery,
  ): Promise<Value<'importContactPreviewSchema'>>;
  connectFiles(
    brandId: string,
    runId: string,
    input: schemas.ImportFileSourceRequest,
  ): Promise<schemas.ImportRunView>;
  files(brandId: string, runId: string): Promise<Value<'importFileListSchema'>>;
  file(brandId: string, runId: string, fileId: string): Promise<ImportFileView>;
  uploadFile(
    brandId: string,
    runId: string,
    input: schemas.ImportFileUploadRequest,
  ): Promise<ImportFileUpload>;
  confirmFile(brandId: string, runId: string, fileId: string): Promise<ImportFileView>;
  mapFile(
    brandId: string,
    runId: string,
    fileId: string,
    input: schemas.ImportFileMapping,
  ): Promise<ImportFileView>;
  mapInventory(
    brandId: string,
    runId: string,
    fileId: string,
    mapping: schemas.ImportInventoryMapping,
  ): Promise<ImportFileView>;
  discardFile(brandId: string, runId: string, fileId: string): Promise<void>;
  presets(
    brandId: string,
    query: schemas.ImportFilePresetListQuery,
  ): Promise<Value<'importFilePresetListSchema'>>;
  savePreset(brandId: string, input: schemas.ImportFilePresetCreate): Promise<ImportFilePreset>;
  deletePreset(brandId: string, presetId: string): Promise<void>;
}

export const importKeys = {
  brand: (brandId: string) => ['imports', brandId] as const,
  runs: (brandId: string) => ['imports', brandId, 'runs'] as const,
  run: (brandId: string, runId: string) => ['imports', brandId, 'run', runId] as const,
  files: (brandId: string, runId: string) => ['imports', brandId, 'run', runId, 'files'] as const,
  mappings: (brandId: string, runId: string) =>
    ['imports', brandId, 'run', runId, 'mappings'] as const,
  mappingValues: (brandId: string, runId: string, query: schemas.ImportMappingValuesQuery) =>
    ['imports', brandId, 'run', runId, 'mapping-values', query] as const,
  report: (brandId: string, runId: string) => ['imports', brandId, 'run', runId, 'report'] as const,
  presets: (brandId: string) => ['imports', brandId, 'presets'] as const,
};
