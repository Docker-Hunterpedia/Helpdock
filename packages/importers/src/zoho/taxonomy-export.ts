import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { type ImportSnapshotScope, RUN_SNAPSHOT } from '../http.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';
import {
  zohoKnowledgeIndexSchema,
  zohoRootCategorySchema,
  zohoSectionSchema,
} from './knowledge-contracts.js';
import {
  initialZohoRecycledTaxonomy,
  readZohoRecycledTaxonomyStep,
  type ZohoRecycledTaxonomyCache,
  zohoRecycledTaxonomyCursorSchema,
} from './recycled-taxonomy.js';

const statuses = ['SHOW_IN_HELPCENTER', 'HIDE_IN_HELPCENTER', 'DISABLED'] as const;
const pageCursor = z.strictObject({
  from: z.int().positive().max(2147483647),
  offset: z.int().min(0).max(50),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  previousPage: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  statusIndex: z.int().min(0).max(2),
  trashed: z.boolean(),
});
export const zohoRootScanSchema = pageCursor;
type PageCursor = z.infer<typeof pageCursor>;
type Root = z.infer<typeof zohoRootCategorySchema>;
type Section = z.infer<typeof zohoSectionSchema>;
type PageCache = {
  page?: { key: string; rows: z.infer<typeof zohoKnowledgeIndexSchema>[]; fingerprint: string };
};
export function initialZohoRootScan(): PageCursor {
  return {
    from: 1,
    offset: 0,
    fingerprint: null,
    previousPage: null,
    statusIndex: 0,
    trashed: false,
  };
}

async function sourcePage(
  client: ZohoDeskClient,
  request: { path: string; snapshot: ImportSnapshotScope },
  cursor: PageCursor,
  cache: PageCache,
) {
  const { path } = request;
  const status = statuses[cursor.statusIndex];
  if (!status) throw new ConnectorError('invalid-response');
  const key = `${path}:${cursor.from}:${status}:${cursor.trashed}`;
  if (cache.page?.key !== key) {
    const page = await client.list(
      path,
      z.object({ data: z.array(zohoKnowledgeIndexSchema).max(50) }),
      {
        from: String(cursor.from),
        limit: '50',
        sortBy: 'order',
        status,
        isTrashed: String(cursor.trashed),
      },
      request.snapshot,
    );
    if (
      new Set(page.data.map((row) => row.id)).size !== page.data.length ||
      page.data.some((row) => row.status !== status || row.isTrashed !== cursor.trashed)
    )
      throw new ConnectorError('invalid-response');
    cache.page = { key, rows: page.data, fingerprint: hashImportValue(page.data) };
  }
  const page = cache.page;
  if (
    cursor.offset > page.rows.length ||
    page.fingerprint === cursor.previousPage ||
    (cursor.fingerprint !== null && cursor.fingerprint !== page.fingerprint)
  )
    throw new ConnectorError('invalid-response');
  return page;
}

function nextFilteredPage(
  cursor: PageCursor,
  length: number,
  fingerprint: string,
): PageCursor | null {
  if (length === 50)
    return pageCursor.parse({
      ...cursor,
      from: cursor.from + length,
      offset: 0,
      fingerprint: null,
      previousPage: fingerprint,
    });
  if (cursor.statusIndex < 2)
    return {
      ...initialZohoRootScan(),
      statusIndex: cursor.statusIndex + 1,
      trashed: cursor.trashed,
    };
  return cursor.trashed ? null : { ...initialZohoRootScan(), trashed: true };
}

/** One native taxonomy record per checkpoint; filters enumerate hidden/disabled/trash states explicitly. */
export async function readZohoRootStep(
  client: ZohoDeskClient,
  raw: ImportCursor,
  cache: PageCache = {},
): Promise<{ row: Root | null; next: PageCursor | null }> {
  const cursor = pageCursor.parse(raw);
  // The section entity replays the root list, so sections hang off staged categories.
  const page = await sourcePage(
    client,
    { path: '/api/v1/kbRootCategories', snapshot: RUN_SNAPSHOT },
    cursor,
    cache,
  );
  const index = page.rows[cursor.offset];
  if (!index)
    return { row: null, next: nextFilteredPage(cursor, page.rows.length, page.fingerprint) };
  const root = await client.json(`/api/v1/kbRootCategories/${index.id}`, zohoRootCategorySchema);
  if (root.id !== index.id || root.status !== index.status || root.isTrashed !== index.isTrashed)
    throw new ConnectorError('invalid-response');
  return {
    row: root,
    next: { ...cursor, offset: cursor.offset + 1, fingerprint: page.fingerprint },
  };
}

export async function zohoTaxonomyRecord(
  client: ZohoDeskClient,
  entity: 'category' | 'section',
  row: Root | Section,
): Promise<ImportRecord> {
  const names: Partial<Record<'en' | 'ar', string>> = {};
  const descriptions: Partial<Record<'en' | 'ar', string>> = {};
  for (const translation of row.translations) {
    if (translation.categoryId !== row.id) throw new ConnectorError('invalid-response');
    const locale = translation.locale.toLowerCase().replaceAll('_', '-').split('-')[0];
    if (locale !== 'en' && locale !== 'ar') {
      await client.warnKnowledge(
        'import.knowledge.locale-unsupported',
        entity,
        `${entity}:${row.id}:${translation.locale}`,
      );
      continue;
    }
    if (
      names[locale] !== undefined &&
      (names[locale] !== translation.name ||
        descriptions[locale] !== (translation.description ?? ''))
    )
      throw new ConnectorError('invalid-response');
    names[locale] = translation.name;
    descriptions[locale] = translation.description ?? '';
  }
  if (!names.en?.trim() && !names.ar?.trim()) {
    await client.warnKnowledge(
      'import.knowledge.locale-unsupported',
      entity,
      `${entity}:${row.id}`,
    );
    throw new ConnectorError('invalid-response');
  }
  if (entity === 'category')
    return importRecordSchema.parse({
      entity,
      payload: { externalId: `category:${row.id}`, names, descriptions },
    });
  const section = zohoSectionSchema.parse(row);
  if (section.parentCategoryId === section.id || section.rootCategoryId === section.id)
    throw new ConnectorError('invalid-response');
  return importRecordSchema.parse({
    entity,
    payload: {
      externalId: `section:${section.id}`,
      names,
      descriptions,
      parentExternalId: `category:${section.rootCategoryId}`,
      ...(section.parentCategoryId === section.rootCategoryId
        ? {}
        : { parentSectionExternalId: `section:${section.parentCategoryId}` }),
    },
  });
}

const cursorSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('roots'), scan: zohoRootScanSchema }),
  z.strictObject({ stage: z.literal('recycled-taxonomy'), scan: zohoRecycledTaxonomyCursorSchema }),
  z.strictObject({
    stage: z.literal('sections'),
    rootId: zohoIdSchema,
    scan: zohoRootScanSchema.nullable(),
    page: pageCursor,
  }),
]);
type TaxonomyCursor = z.infer<typeof cursorSchema>;

function afterRoots(scan: PageCursor | null): TaxonomyCursor {
  if (scan !== null) return { stage: 'roots', scan };
  return { stage: 'recycled-taxonomy', scan: initialZohoRecycledTaxonomy() };
}

export async function* exportZohoTaxonomy(
  client: ZohoDeskClient,
  entity: 'category' | 'section',
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let cursor = cursorSchema.parse(raw ?? { stage: 'roots', scan: initialZohoRootScan() });
  const rootCache: PageCache = {},
    sectionCache: PageCache = {};
  const recycledCache: ZohoRecycledTaxonomyCache = {};
  while (true) {
    if (cursor.stage === 'recycled-taxonomy') {
      const step = await readZohoRecycledTaxonomyStep(client, cursor.scan, recycledCache);
      const next: TaxonomyCursor | null =
        step.next === null ? null : { stage: 'recycled-taxonomy', scan: step.next };
      yield {
        records:
          step.record?.entity === entity
            ? [await zohoTaxonomyRecord(client, entity, step.record.row)]
            : [],
        cursor: next,
      };
      if (next === null) return;
      cursor = next;
      continue;
    }
    if (cursor.stage === 'roots') {
      const step = await readZohoRootStep(client, cursor.scan, rootCache);
      const records =
        entity === 'category' && step.row
          ? [await zohoTaxonomyRecord(client, entity, step.row)]
          : [];
      const next =
        entity === 'section' && step.row
          ? {
              stage: 'sections' as const,
              rootId: step.row.id,
              scan: step.next,
              page: initialZohoRootScan(),
            }
          : afterRoots(step.next);
      yield { records, cursor: next };
      cursor = next;
      continue;
    }
    if (entity !== 'section') throw new ConnectorError('invalid-response');
    const page = await sourcePage(
      client,
      {
        path: `/api/v1/kbRootCategories/${cursor.rootId}/sections`,
        snapshot: { slot: 'zoho.kb-sections' },
      },
      cursor.page,
      sectionCache,
    );
    const index = page.rows[cursor.page.offset];
    if (index) {
      const section = await client.json(`/api/v1/kbSections/${index.id}`, zohoSectionSchema);
      if (
        section.id !== index.id ||
        section.rootCategoryId !== cursor.rootId ||
        section.status !== index.status ||
        section.isTrashed !== index.isTrashed
      )
        throw new ConnectorError('invalid-response');
      const record = await zohoTaxonomyRecord(client, 'section', section);
      cursor = {
        ...cursor,
        page: { ...cursor.page, offset: cursor.page.offset + 1, fingerprint: page.fingerprint },
      };
      yield { records: [record], cursor };
      continue;
    }
    const nextPage = nextFilteredPage(cursor.page, page.rows.length, page.fingerprint);
    const next = nextPage ? { ...cursor, page: nextPage } : afterRoots(cursor.scan);
    yield { records: [], cursor: next };
    cursor = next;
  }
}
