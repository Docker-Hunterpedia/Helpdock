import {
  csvLine,
  FRESHDESK_IMPORT_ENTITIES,
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
  type ImportRunView,
  type ImportScope,
  type ImportSlaOverview,
  type ImportStartRequest,
  type ImportTicketPreviewQuery,
  importConnectionRequestSchema,
  importDryRunRequestSchema,
  importFieldSchema,
  importFileListSchema,
  importFileMappingSchema,
  importFilePresetCreateSchema,
  importFilePresetListQuerySchema,
  importFileSourceRequestSchema,
  importFileUploadRequestSchema,
  importFileViewSchema,
  importInventoryMappingSchema,
  importLogExportQuerySchema,
  importLogPageSchema,
  importLogQuerySchema,
  importMappingFieldQuerySchema,
  importMappingPageRequestSchema,
  importMappingsRequestSchema,
  importMappingValuesQuerySchema,
  importMappingValuesSchema,
  importProgressCountsSchema,
  importRunCreateSchema,
  importRunViewSchema,
  importScopeSchema,
  importSlaOverviewSchema,
  importStartRequestSchema,
  ZOHODESK_IMPORT_ENTITIES,
} from '@helpdock/schemas';
import type { PutObject } from '../media/upload.js';
import type { ImportFilePreset, ImportFileView, ImportsApi } from './api.js';
import {
  MOCK_IMPORT_ACTOR,
  MOCK_IMPORT_CELLS,
  MOCK_IMPORT_HEADERS,
  MOCK_REVIEW_TOKEN,
  mockContactPreview,
  mockDryRunReport,
  mockMappingValues,
  mockTicketPreview,
} from './mock-data.js';
import { type MockImportTargetApis, mockImportTargetChoices } from './mock-targets.js';

type Phase = ImportRunView['status'];
type Scenario = 'happy' | 'blocked' | 'failed' | 'credentials-refused';

/** Scripted UI fixture only; the HTTP adapter is the migration implementation. */
export class MockImportsApi implements ImportsApi {
  readonly slaActivations = new Map<string, ImportSlaOverview['activation']>();
  readonly slaPolls = new Map<string, number>();
  async sla(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    let activation = this.slaActivations.get(runId) ?? null;
    const total = Math.floor((run.counts.loaded.ticket ?? 0) * 0.8);
    if (activation && ['queued', 'running'].includes(activation.status)) {
      const polls = (this.slaPolls.get(runId) ?? 0) + 1;
      this.slaPolls.set(runId, polls);
      activation = {
        ...activation,
        status: polls >= 2 ? 'completed' : 'running',
        updatedAt: new Date().toISOString(),
        checked: polls >= 2 ? total : 0,
        started: polls >= 2 ? total : 0,
      };
      this.slaActivations.set(runId, activation);
    }
    return importSlaOverviewSchema.parse({
      available: run.status === 'completed',
      eligible: run.status !== 'completed' || activation?.status === 'completed' ? 0 : total,
      activation,
    });
  }
  async startSla(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    this.phase(run, ['completed']);
    const previous = this.slaActivations.get(runId);
    if (!previous || !['queued', 'running'].includes(previous.status)) {
      const now = new Date().toISOString();
      this.slaActivations.set(runId, {
        status: 'queued',
        requestedAt: now,
        updatedAt: now,
        checked: 0,
        started: 0,
        skipped: 0,
      });
      this.slaPolls.set(runId, 0);
    }
    const activation = this.slaActivations.get(runId) ?? null;
    return importSlaOverviewSchema.parse({
      available: true,
      eligible: Math.floor((run.counts.loaded.ticket ?? 0) * 0.8),
      activation,
    });
  }
  private logRows(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    return [
      {
        id: 1,
        at: run.createdAt,
        level: 'info' as const,
        entity: null,
        externalId: null,
        message: 'import.run-created',
      },
      ...(run.status === 'failed'
        ? [
            {
              id: 2,
              at: run.createdAt,
              level: 'error' as const,
              entity: null,
              externalId: null,
              message: 'import.vendor-unavailable',
            },
          ]
        : []),
    ];
  }
  async log(brandId: string, runId: string, raw: ImportLogQuery) {
    const query = importLogQuerySchema.parse(raw);
    const all = this.logRows(brandId, runId);
    const through = query.through ?? all.at(-1)?.id ?? 0;
    const entries = all
      .filter(
        (entry) =>
          entry.id <= through &&
          (!query.level || entry.level === query.level) &&
          (query.after === undefined ||
            (query.direction === 'asc' ? entry.id > query.after : entry.id < query.after)),
      )
      .sort((a, b) => (query.direction === 'asc' ? a.id - b.id : b.id - a.id));
    const page = entries.slice(0, query.limit);
    return importLogPageSchema.parse({
      entries: page,
      through,
      nextCursor: entries.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    });
  }
  async exportLog(brandId: string, runId: string, raw: ImportLogExportQuery) {
    const query = importLogExportQuerySchema.parse(raw);
    const rows = this.logRows(brandId, runId).filter(
      (entry) => !query.level || entry.level === query.level,
    );
    return new Blob(
      [
        csvLine(['id', 'at', 'level', 'entity', 'external_id', 'message']),
        ...rows.map((entry) =>
          csvLine([entry.id, entry.at, entry.level, entry.entity, entry.externalId, entry.message]),
        ),
      ],
      { type: 'text/csv; charset=utf-8' },
    );
  }
  readonly putFile: PutObject = async ({ body, signal, onProgress }) => {
    signal?.throwIfAborted();
    onProgress?.({ loaded: 0, total: body.size, ratio: 0 });
    await Promise.resolve();
    signal?.throwIfAborted();
    onProgress?.({ loaded: body.size, total: body.size, ratio: 1 });
    return 200;
  };
  readonly rows = new Map<string, ImportRunView>();
  readonly confirmed = new Map<string, ImportMappingsRequest['mappings']>();
  readonly reports = new Map<string, ReturnType<typeof mockDryRunReport>>();
  readonly sourceFiles = new Map<string, ImportFileView[]>();
  readonly savedPresets = new Map<string, ImportFilePreset[]>();
  readonly polls = new Map<string, number>();
  readonly paused = new Map<string, Phase>();
  constructor(
    readonly scenario: Scenario = 'happy',
    readonly targetApis?: MockImportTargetApis,
  ) {}
  async mappingTargets(brandId: string, runId: string, query: ImportMappingTargetsQuery) {
    this.phase(this.require(brandId, runId), ['awaiting_mapping', 'ready']);
    return mockImportTargetChoices(this.targetApis, brandId, query);
  }
  async mappingField(brandId: string, runId: string, raw: ImportMappingFieldQuery) {
    this.phase(this.require(brandId, runId), ['awaiting_mapping', 'ready']);
    const query = importMappingFieldQuerySchema.parse(raw);
    if (query.externalId !== 'ticket-field-tier') throw new Error('import.preview-not-found');
    return importFieldSchema.parse({
      externalId: query.externalId,
      target: 'ticket',
      key: 'plan_tier',
      label: 'Plan tier',
      type: 'text',
    });
  }
  async sources(_brandId: string) {
    return { sources: ['zendesk', 'freshdesk', 'zohodesk', 'file'] as ImportRunView['source'][] };
  }
  async mappingValues(brandId: string, runId: string, raw: ImportMappingValuesQuery) {
    const run = this.require(brandId, runId);
    this.phase(run, ['awaiting_mapping', 'ready']);
    const query = importMappingValuesQuerySchema.parse(raw);
    const known = new Map(
      (this.confirmed.get(runId) ?? []).map((mapping) => [
        `${mapping.kind}\0${mapping.externalValue}`,
        mapping,
      ]),
    );
    const choices = mockMappingValues(query.kind)
      .filter((row) => query.after === undefined || row.externalValue > query.after)
      .sort((first, second) =>
        first.externalValue < second.externalValue
          ? -1
          : first.externalValue > second.externalValue
            ? 1
            : 0,
      );
    const values = choices.slice(0, query.limit).map((row) => ({
      ...row,
      confirmed: known.get(`${query.kind}\0${row.externalValue}`) ?? null,
    }));
    return importMappingValuesSchema.parse({
      kind: query.kind,
      values,
      nextCursor: choices.length > query.limit ? (values.at(-1)?.externalValue ?? null) : null,
    });
  }
  async updateMappings(brandId: string, runId: string, raw: ImportMappingPageRequest) {
    const run = this.require(brandId, runId);
    this.phase(run, ['awaiting_mapping', 'ready']);
    const input = importMappingPageRequestSchema.parse(raw);
    const merged = new Map(
      (this.confirmed.get(runId) ?? []).map((mapping) => [
        `${mapping.kind}\0${mapping.externalValue}`,
        mapping,
      ]),
    );
    for (const mapping of input.mappings)
      merged.set(`${mapping.kind}\0${mapping.externalValue}`, mapping);
    if (merged.size > 50000) throw new Error('import.mapping-capacity');
    this.confirmed.set(runId, [...merged.values()]);
    this.reports.delete(runId);
    run.hasDryRun = false;
    run.status = 'awaiting_mapping';
    return { saved: input.mappings.length };
  }

  private require(brandId: string, runId: string) {
    const run = this.rows.get(runId);
    if (!run || run.brandId !== brandId) throw new Error('import.run-not-found');
    return run;
  }
  private phase(run: ImportRunView, allowed: Phase[]) {
    if (!allowed.includes(run.status)) throw new Error('import.phase-invalid');
  }
  private transition(run: ImportRunView, status: Phase) {
    run.status = status;
    this.polls.set(run.id, 0);
    return structuredClone(run);
  }
  async runs(brandId: string) {
    return {
      runs: structuredClone(
        [...this.rows.values()]
          .filter((run) => run.brandId === brandId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100),
      ),
    };
  }
  async run(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    const polls = (this.polls.get(runId) ?? 0) + 1;
    this.polls.set(runId, polls);
    if (polls >= 2) {
      if (run.status === 'extracting') {
        run.counts.extracted = importProgressCountsSchema.parse(
          Object.fromEntries(
            Object.entries({
              ticket: 500,
              message: 1000,
              contact: 503,
              organization: 10,
              attachment: 500,
            }).filter(([entity]) => run.scope.entities.some((selected) => selected === entity)),
          ),
        );
        this.transition(run, 'awaiting_mapping');
      } else if (run.status === 'dry_run') {
        const report = mockDryRunReport(true, this.scenario === 'blocked');
        report.defaultCallingCode = this.reports.get(runId)?.defaultCallingCode ?? '';
        this.reports.set(runId, report);
        this.transition(run, 'awaiting_mapping');
      } else if (run.status === 'loading') {
        run.counts.loaded = { ...run.counts.extracted };
        this.transition(run, this.scenario === 'failed' ? 'failed' : 'finishing');
      } else if (run.status === 'finishing') this.transition(run, 'completed');
      if (['failed', 'completed'].includes(run.status)) {
        run.hasCredentials = false;
        run.finishedAt = new Date().toISOString();
      }
    }
    return structuredClone(run);
  }
  async create(brandId: string, raw: ImportRunCreate) {
    const input = importRunCreateSchema.parse(raw);
    if (input.parentRunId) {
      const parent = this.require(brandId, input.parentRunId);
      if (parent.status !== 'completed' || parent.source !== input.source)
        throw new Error('import.parent-invalid');
    }
    const run = importRunViewSchema.parse({
      id: crypto.randomUUID(),
      brandId,
      source: input.source,
      mode: input.mode,
      parentRunId: input.parentRunId ?? null,
      status: 'draft',
      hasCredentials: false,
      startedBy: MOCK_IMPORT_ACTOR,
      scope: importScopeSchema.parse(
        input.source === 'freshdesk'
          ? { entities: [...FRESHDESK_IMPORT_ENTITIES] }
          : input.source === 'zohodesk'
            ? { entities: [...ZOHODESK_IMPORT_ENTITIES] }
            : {},
      ),
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      counts: { extracted: {}, loaded: {}, skipped: {} },
    });
    this.rows.set(run.id, run);
    return structuredClone(run);
  }
  async connect(brandId: string, runId: string, raw: ImportConnectionRequest) {
    const input = importConnectionRequestSchema.parse(raw);
    const run = this.require(brandId, runId);
    this.phase(run, ['draft', 'connecting']);
    if (this.scenario === 'credentials-refused') throw new Error('import.credentials-refused');
    const account =
      'subdomain' in input.credentials
        ? input.credentials.subdomain
        : 'domain' in input.credentials
          ? input.credentials.domain
          : `${input.credentials.region}:${input.credentials.orgId}`;
    if ('domain' in input.credentials !== (run.source === 'freshdesk'))
      throw new Error('import.credentials-invalid');
    if ('region' in input.credentials !== (run.source === 'zohodesk'))
      throw new Error('import.credentials-invalid');
    run.hasCredentials = true;
    run.sourceAccount = account;
    return { run: this.transition(run, 'connecting'), account };
  }
  async scope(brandId: string, runId: string, raw: ImportScope) {
    const run = this.require(brandId, runId);
    this.phase(run, ['draft', 'connecting']);
    run.scope = importScopeSchema.parse(raw);
    return structuredClone(run);
  }
  async extract(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    this.phase(run, ['connecting']);
    run.startedAt = new Date().toISOString();
    return this.transition(run, 'extracting');
  }
  async mappings(brandId: string, runId: string) {
    this.require(brandId, runId);
    return {
      mappings: structuredClone(this.confirmed.get(runId) ?? []),
      fingerprint: 'c'.repeat(64),
    };
  }
  async saveMappings(brandId: string, runId: string, raw: ImportMappingsRequest) {
    const run = this.require(brandId, runId);
    this.phase(run, ['awaiting_mapping', 'ready']);
    this.confirmed.set(runId, importMappingsRequestSchema.parse(raw).mappings);
    this.reports.delete(runId);
    run.hasDryRun = false;
    return this.mappings(brandId, runId);
  }
  async dryRun(brandId: string, runId: string, raw: ImportDryRunRequest) {
    const input = importDryRunRequestSchema.parse(raw);
    const run = this.require(brandId, runId);
    this.phase(run, ['awaiting_mapping', 'ready']);
    const report = mockDryRunReport(false, false);
    report.defaultCallingCode = input.defaultCallingCode;
    this.reports.set(runId, report);
    run.hasDryRun = true;
    return this.transition(run, 'dry_run');
  }
  async report(brandId: string, runId: string) {
    this.require(brandId, runId);
    const report = this.reports.get(runId);
    if (!report) throw new Error('import.report-not-found');
    return structuredClone(report);
  }
  async start(brandId: string, runId: string, raw: ImportStartRequest) {
    const input = importStartRequestSchema.parse(raw);
    const run = this.require(brandId, runId);
    this.phase(run, ['awaiting_mapping', 'ready']);
    const report = await this.report(brandId, runId);
    if (
      !report.complete ||
      input.reviewToken !== report.reviewToken ||
      input.reviewToken !== MOCK_REVIEW_TOKEN ||
      report.errors ||
      (report.warnings && !input.acknowledgeWarnings)
    )
      throw new Error('import.approval-refused');
    return this.transition(run, 'loading');
  }
  async control(brandId: string, runId: string, action: 'pause' | 'resume' | 'cancel') {
    const run = this.require(brandId, runId);
    if (action === 'cancel') {
      this.phase(run, [
        'draft',
        'connecting',
        'extracting',
        'awaiting_mapping',
        'dry_run',
        'ready',
        'loading',
        'finishing',
        'paused',
      ]);
      run.hasCredentials = false;
      run.finishedAt = new Date().toISOString();
      return this.transition(run, 'cancelled');
    }
    if (action === 'pause') {
      this.phase(run, ['extracting', 'dry_run', 'loading', 'finishing']);
      this.paused.set(runId, run.status);
      run.pausedFrom = importRunViewSchema.shape.pausedFrom.parse(run.status);
      return this.transition(run, 'paused');
    }
    this.phase(run, ['paused']);
    run.pausedFrom = null;
    const previous = this.paused.get(runId);
    if (!previous) throw new Error('import.phase-invalid');
    return this.transition(run, previous);
  }
  async samples(brandId: string, runId: string) {
    const run = this.require(brandId, runId);
    return {
      tickets: run.scope.entities.includes('ticket') ? ['39812'] : [],
      contacts: run.scope.entities.includes('contact') ? ['contact-1'] : [],
    };
  }
  async ticketPreview(brandId: string, runId: string, query: ImportTicketPreviewQuery) {
    this.require(brandId, runId);
    const preview = mockTicketPreview(query.externalId);
    if (!this.reports.get(runId)?.complete)
      for (const message of preview.messages)
        for (const attachment of message.attachments)
          attachment.availability = { state: 'not_checked' };
    const end = query.offset + query.limit;
    preview.messages = preview.messages.slice(query.offset, end);
    preview.nextOffset = end < preview.messageCount ? end : null;
    return preview;
  }
  async contactPreview(brandId: string, runId: string, query: ImportContactPreviewQuery) {
    this.require(brandId, runId);
    return mockContactPreview(query.externalId);
  }
  async connectFiles(brandId: string, runId: string, raw: ImportFileSourceRequest) {
    const input = importFileSourceRequestSchema.parse(raw);
    const run = this.require(brandId, runId);
    this.phase(run, ['draft', 'connecting']);
    run.sourceAccount = input.dataset;
    return this.transition(run, 'connecting');
  }
  async files(brandId: string, runId: string) {
    this.require(brandId, runId);
    return importFileListSchema.parse({
      files: (this.sourceFiles.get(runId) ?? []).map((file) => {
        const {
          headers,
          headerFingerprint: _fingerprint,
          sampleRows: _rows,
          mapping: _mapping,
          validation: _validation,
          ...summary
        } = file;
        return {
          ...summary,
          hasMapping: file.mapping !== null,
          hasHeaders: headers !== null,
          validationPending:
            file.status === 'uploaded' ||
            (file.status === 'ready' &&
              ((file.mapping !== null && file.validation === null) ||
                (file.inventoryMapping?.idColumn != null && file.inventoryValidation == null))),
          readyForExtraction:
            file.status === 'ready' &&
            (file.inventoryMapping
              ? file.inventoryValidation != null
              : file.format === 'bundle' ||
                (file.validation !== null &&
                  (file.validation.invalidRows === 0 || file.mapping?.skipInvalidRows === true))),
        };
      }),
    });
  }
  async file(brandId: string, runId: string, fileId: string) {
    return structuredClone(this.requireFile(brandId, runId, fileId));
  }
  async uploadFile(brandId: string, runId: string, raw: ImportFileUploadRequest) {
    const input = importFileUploadRequestSchema.parse(raw);
    const run = this.require(brandId, runId);
    this.phase(run, ['connecting']);
    const file = importFileViewSchema.parse({
      id: crypto.randomUUID(),
      runId,
      revision: crypto.randomUUID(),
      fileName: input.fileName,
      format: input.format,
      entity: input.format === 'csv' ? input.entity : null,
      size: input.size,
      status: 'pending',
      headers: null,
      sampleRows: null,
      mapping: null,
      inventoryMapping: input.format === 'csv' ? (input.inventoryMapping ?? null) : null,
      inventoryValidation: null,
      validation: null,
      recordCount: null,
      error: null,
    });
    this.sourceFiles.set(runId, [...(this.sourceFiles.get(runId) ?? []), file]);
    return {
      file: structuredClone(file),
      url: `https://upload.example.test/imports/${file.id}`,
      headers: {
        'content-type': input.format === 'csv' ? 'text/csv' : 'application/zip',
        'content-length': String(input.size),
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }
  private requireFile(brandId: string, runId: string, fileId: string) {
    this.require(brandId, runId);
    const file = this.sourceFiles.get(runId)?.find((item) => item.id === fileId);
    if (!file) throw new Error('import.file-not-found');
    return file;
  }
  async confirmFile(brandId: string, runId: string, fileId: string) {
    const file = this.requireFile(brandId, runId, fileId);
    file.status = 'ready';
    file.headers = file.format === 'csv' ? [...MOCK_IMPORT_HEADERS] : null;
    file.headerFingerprint = file.headers ? await this.headerHash(file.headers) : null;
    file.sampleRows =
      file.format === 'csv' ? [{ line: 2, cells: [...MOCK_IMPORT_CELLS], truncated: false }] : null;
    file.recordCount = file.format === 'bundle' ? 2 : null;
    return structuredClone(file);
  }
  async mapFile(brandId: string, runId: string, fileId: string, raw: ImportFileMapping) {
    const file = this.requireFile(brandId, runId, fileId);
    file.mapping = importFileMappingSchema.parse(raw);
    file.revision = crypto.randomUUID();
    file.validation = {
      preview: {
        headers: [...MOCK_IMPORT_HEADERS],
        delimiter: ',',
        headerFingerprint: await this.headerHash(MOCK_IMPORT_HEADERS),
        rows: [
          {
            line: 2,
            result: {
              ok: true,
              records: [{ entity: 'ticket', payload: mockTicketPreview().ticket }],
            },
          },
        ],
      },
      checkedRows: 1,
      invalidRows: 0,
      records: 1,
      issues: [],
    };
    file.recordCount = 1;
    return structuredClone(file);
  }
  async mapInventory(brandId: string, runId: string, fileId: string, raw: ImportInventoryMapping) {
    const file = this.requireFile(brandId, runId, fileId);
    const mapping = importInventoryMappingSchema.parse(raw);
    if (
      !file.inventoryMapping ||
      (mapping.idColumn !== null && !file.headers?.includes(mapping.idColumn))
    )
      throw new Error('import.missing-column');
    file.inventoryMapping = mapping;
    file.inventoryValidation =
      mapping.idColumn === null
        ? null
        : { kind: 'ticket-inventory', sourceRows: 1, records: 1, duplicates: 0 };
    file.recordCount = file.inventoryValidation?.records ?? null;
    file.revision = crypto.randomUUID();
    file.status = 'ready';
    file.error = null;
    return structuredClone(file);
  }
  async discardFile(brandId: string, runId: string, fileId: string) {
    this.requireFile(brandId, runId, fileId);
    this.sourceFiles.set(
      runId,
      (this.sourceFiles.get(runId) ?? []).filter((file) => file.id !== fileId),
    );
  }
  private async headerHash(headers: string[]) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(headers)),
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async presets(brandId: string, raw: ImportFilePresetListQuery) {
    const query = importFilePresetListQuerySchema.parse(raw);
    const presets = (this.savedPresets.get(brandId) ?? [])
      .filter(
        (preset) =>
          (!query.entity || preset.entity === query.entity) &&
          (!query.headerFingerprint || preset.headerFingerprint === query.headerFingerprint) &&
          (!query.after || preset.id > query.after),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      presets: structuredClone(presets.slice(0, 50)),
      nextCursor: presets.length > 50 ? (presets[49]?.id ?? null) : null,
    };
  }
  async savePreset(brandId: string, raw: ImportFilePresetCreate) {
    const input = importFilePresetCreateSchema.parse(raw);
    const previous = this.savedPresets.get(brandId) ?? [];
    if (previous.some((preset) => preset.name.toLowerCase() === input.name.toLowerCase()))
      throw new Error('import.preset-name-exists');
    const preset = {
      id: crypto.randomUUID(),
      name: input.name,
      entity: input.mapping.entity,
      mapping: input.mapping,
      headerFingerprint: await this.headerHash(input.headers),
      createdAt: new Date().toISOString(),
    };
    this.savedPresets.set(brandId, [...previous, preset]);
    return structuredClone(preset);
  }
  async deletePreset(brandId: string, presetId: string) {
    const previous = this.savedPresets.get(brandId) ?? [];
    if (!previous.some((preset) => preset.id === presetId))
      throw new Error('import.preset-not-found');
    this.savedPresets.set(
      brandId,
      previous.filter((preset) => preset.id !== presetId),
    );
  }
}
