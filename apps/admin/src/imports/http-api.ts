import {
  type ImportConnectionRequest,
  type ImportContactPreviewQuery,
  type ImportDryRunRequest,
  type ImportFileMapping,
  type ImportFilePresetCreate,
  type ImportFilePresetListQuery,
  type ImportFileSourceRequest,
  type ImportFileUploadRequest,
  type ImportInventoryMapping,
  type ImportLogExportQuery,
  type ImportLogQuery,
  type ImportMappingFieldQuery,
  type ImportMappingPageRequest,
  type ImportMappingsRequest,
  type ImportMappingTargetsQuery,
  type ImportMappingValuesQuery,
  type ImportRunCreate,
  type ImportScope,
  type ImportStartRequest,
  type ImportTicketPreviewQuery,
  importConnectionRequestSchema,
  importConnectionResultSchema,
  importContactPreviewQuerySchema,
  importContactPreviewSchema,
  importDryRunReportSchema,
  importDryRunRequestSchema,
  importFieldSchema,
  importFileDeleteSchema,
  importFileListSchema,
  importFileMappingRequestSchema,
  importFilePresetCreateSchema,
  importFilePresetDeleteSchema,
  importFilePresetListQuerySchema,
  importFilePresetListSchema,
  importFilePresetViewSchema,
  importFileSourceRequestSchema,
  importFileUploadRequestSchema,
  importFileUploadResponseSchema,
  importFileViewSchema,
  importInventoryMappingRequestSchema,
  importLogExportQuerySchema,
  importLogPageSchema,
  importLogQuerySchema,
  importMappingFieldQuerySchema,
  importMappingPageRequestSchema,
  importMappingPageResultSchema,
  importMappingsRequestSchema,
  importMappingsViewSchema,
  importMappingTargetsQuerySchema,
  importMappingTargetsSchema,
  importMappingValuesQuerySchema,
  importMappingValuesSchema,
  importPreviewSamplesSchema,
  importRunCreateSchema,
  importRunListSchema,
  importRunViewSchema,
  importScopeSchema,
  importSlaOverviewSchema,
  importSlaStartRequestSchema,
  importStartRequestSchema,
  importSupportedSourcesSchema,
  importTicketPreviewQuerySchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';
import { z } from 'zod';
import { HttpTransport } from '../auth/http-transport.js';
import { xhrPut } from '../media/upload.js';
import type { ImportsApi } from './api.js';

const brandPath = (brandId: string) => `/brands/${encodeURIComponent(brandId)}`;
const runsPath = (brandId: string) => `${brandPath(brandId)}/imports`;
const runPath = (brandId: string, runId: string) =>
  `${runsPath(brandId)}/${encodeURIComponent(runId)}`;
const filePath = (brandId: string, runId: string, fileId: string) =>
  `${runPath(brandId, runId)}/files/${encodeURIComponent(fileId)}`;
function queryString(query: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) result.set(key, String(value));
  return result.toString();
}

export class HttpImportsApi implements ImportsApi {
  readonly putFile = xhrPut;
  sla(brandId: string, runId: string) {
    return this.request('GET', `${runPath(brandId, runId)}/sla`, importSlaOverviewSchema);
  }
  startSla(brandId: string, runId: string) {
    return this.request(
      'POST',
      `${runPath(brandId, runId)}/sla/start`,
      importSlaOverviewSchema,
      importSlaStartRequestSchema.parse({ acknowledge: true }),
    );
  }
  log(brandId: string, runId: string, query: ImportLogQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/log?${queryString(importLogQuerySchema.parse(query))}`,
      importLogPageSchema,
    );
  }
  exportLog(brandId: string, runId: string, query: ImportLogExportQuery) {
    return this.transport.requestBlob(
      `${runPath(brandId, runId)}/log/export?${queryString(importLogExportQuerySchema.parse(query))}`,
    );
  }
  constructor(readonly transport = new HttpTransport()) {}
  sources(brandId: string) {
    return this.request('GET', `${runsPath(brandId)}/sources`, importSupportedSourcesSchema);
  }
  mappingTargets(brandId: string, runId: string, query: ImportMappingTargetsQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/mapping-targets?${queryString(importMappingTargetsQuerySchema.parse(query))}`,
      importMappingTargetsSchema,
    );
  }
  mappingField(brandId: string, runId: string, query: ImportMappingFieldQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/mapping-field?${queryString(importMappingFieldQuerySchema.parse(query))}`,
      importFieldSchema,
    );
  }
  mappingValues(brandId: string, runId: string, query: ImportMappingValuesQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/mapping-values?${queryString(importMappingValuesQuerySchema.parse(query))}`,
      importMappingValuesSchema,
    );
  }
  updateMappings(brandId: string, runId: string, input: ImportMappingPageRequest) {
    return this.request(
      'PATCH',
      `${runPath(brandId, runId)}/mappings`,
      importMappingPageResultSchema,
      importMappingPageRequestSchema.parse(input),
    );
  }
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) {
    return schema.parse(await this.transport.request(method, path, body));
  }
  runs(brandId: string) {
    return this.request('GET', runsPath(brandId), importRunListSchema);
  }
  run(brandId: string, runId: string) {
    return this.request('GET', runPath(brandId, runId), importRunViewSchema);
  }
  create(brandId: string, input: ImportRunCreate) {
    return this.request(
      'POST',
      runsPath(brandId),
      importRunViewSchema,
      importRunCreateSchema.parse(input),
    );
  }
  connect(brandId: string, runId: string, input: ImportConnectionRequest) {
    return this.request(
      'PUT',
      `${runPath(brandId, runId)}/connection`,
      importConnectionResultSchema,
      importConnectionRequestSchema.parse(input),
    );
  }
  scope(brandId: string, runId: string, input: ImportScope) {
    return this.request(
      'PUT',
      `${runPath(brandId, runId)}/scope`,
      importRunViewSchema,
      importScopeSchema.parse(input),
    );
  }
  extract(brandId: string, runId: string) {
    return this.request('POST', `${runPath(brandId, runId)}/extract`, importRunViewSchema);
  }
  mappings(brandId: string, runId: string) {
    return this.request('GET', `${runPath(brandId, runId)}/mappings`, importMappingsViewSchema);
  }
  saveMappings(brandId: string, runId: string, input: ImportMappingsRequest) {
    return this.request(
      'PUT',
      `${runPath(brandId, runId)}/mappings`,
      importMappingsViewSchema,
      importMappingsRequestSchema.parse(input),
    );
  }
  dryRun(brandId: string, runId: string, input: ImportDryRunRequest) {
    return this.request(
      'POST',
      `${runPath(brandId, runId)}/dry-run`,
      importRunViewSchema,
      importDryRunRequestSchema.parse(input),
    );
  }
  report(brandId: string, runId: string) {
    return this.request('GET', `${runPath(brandId, runId)}/dry-run`, importDryRunReportSchema);
  }
  start(brandId: string, runId: string, input: ImportStartRequest) {
    return this.request(
      'POST',
      `${runPath(brandId, runId)}/start`,
      importRunViewSchema,
      importStartRequestSchema.parse(input),
    );
  }
  control(brandId: string, runId: string, raw: 'pause' | 'resume' | 'cancel') {
    const action = z.enum(['pause', 'resume', 'cancel']).parse(raw);
    return this.request('POST', `${runPath(brandId, runId)}/${action}`, importRunViewSchema);
  }
  samples(brandId: string, runId: string) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/preview/samples`,
      importPreviewSamplesSchema,
    );
  }
  ticketPreview(brandId: string, runId: string, query: ImportTicketPreviewQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/preview/ticket?${queryString(importTicketPreviewQuerySchema.parse(query))}`,
      importTicketPreviewSchema,
    );
  }
  contactPreview(brandId: string, runId: string, query: ImportContactPreviewQuery) {
    return this.request(
      'GET',
      `${runPath(brandId, runId)}/preview/contact?${queryString(importContactPreviewQuerySchema.parse(query))}`,
      importContactPreviewSchema,
    );
  }
  connectFiles(brandId: string, runId: string, input: ImportFileSourceRequest) {
    return this.request(
      'PUT',
      `${runPath(brandId, runId)}/file-source`,
      importRunViewSchema,
      importFileSourceRequestSchema.parse(input),
    );
  }
  files(brandId: string, runId: string) {
    return this.request('GET', `${runPath(brandId, runId)}/files`, importFileListSchema);
  }
  file(brandId: string, runId: string, fileId: string) {
    return this.request('GET', filePath(brandId, runId, fileId), importFileViewSchema);
  }
  uploadFile(brandId: string, runId: string, input: ImportFileUploadRequest) {
    return this.request(
      'POST',
      `${runPath(brandId, runId)}/files/presign`,
      importFileUploadResponseSchema,
      importFileUploadRequestSchema.parse(input),
    );
  }
  confirmFile(brandId: string, runId: string, fileId: string) {
    return this.request(
      'POST',
      `${filePath(brandId, runId, fileId)}/confirm`,
      importFileViewSchema,
    );
  }
  mapFile(brandId: string, runId: string, fileId: string, mapping: ImportFileMapping) {
    return this.request(
      'PUT',
      `${filePath(brandId, runId, fileId)}/mapping`,
      importFileViewSchema,
      importFileMappingRequestSchema.parse({ mapping }),
    );
  }
  async discardFile(brandId: string, runId: string, fileId: string) {
    await this.request('DELETE', filePath(brandId, runId, fileId), importFileDeleteSchema);
  }
  mapInventory(brandId: string, runId: string, fileId: string, mapping: ImportInventoryMapping) {
    return this.request(
      'PUT',
      `${filePath(brandId, runId, fileId)}/inventory-mapping`,
      importFileViewSchema,
      importInventoryMappingRequestSchema.parse({ mapping }),
    );
  }
  presets(brandId: string, query: ImportFilePresetListQuery) {
    return this.request(
      'GET',
      `${brandPath(brandId)}/import-presets?${queryString(importFilePresetListQuerySchema.parse(query))}`,
      importFilePresetListSchema,
    );
  }
  savePreset(brandId: string, input: ImportFilePresetCreate) {
    return this.request(
      'POST',
      `${brandPath(brandId)}/import-presets`,
      importFilePresetViewSchema,
      importFilePresetCreateSchema.parse(input),
    );
  }
  async deletePreset(brandId: string, presetId: string) {
    await this.request(
      'DELETE',
      `${brandPath(brandId)}/import-presets/${encodeURIComponent(presetId)}`,
      importFilePresetDeleteSchema,
    );
  }
}
