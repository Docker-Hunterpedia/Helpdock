import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { zohoArticleTranslationHintSchema } from './article-contracts.js';
import {
  initialZohoArticleFilesScan,
  readZohoArticleFilesStep,
  zohoArticleFilesScanSchema,
} from './article-files.js';
import {
  completeZohoArticleHints,
  initialZohoArticleGroup,
  readZohoArticleGroupStep,
  type ZohoArticleGroup,
  zohoArticleGroupSchema,
} from './article-group.js';
import {
  initialZohoArticleList,
  readZohoArticleListStep,
  zohoArticleListCursorSchema,
} from './article-list.js';
import { zohoArticleLocale, zohoArticleRecord } from './article-record.js';
import { readZohoArticleVersionStep, zohoArticleVersionsSchema } from './article-versions.js';
import type { ZohoDeskClient } from './client.js';
import { zohoKnowledgePrivacySchema, zohoKnowledgePrivacyStep } from './knowledge-privacy.js';
import {
  initialZohoRecycledArticles,
  readZohoRecycledArticleStep,
  type ZohoRecycledArticlesCache,
  zohoRecycledArticlesCursorSchema,
} from './recycled-articles.js';

const activeSchema = z.strictObject({
  stage: z.literal('scan'),
  scan: zohoArticleListCursorSchema,
});
const recycledSchema = z.strictObject({
  stage: z.literal('recycle'),
  scan: zohoRecycledArticlesCursorSchema,
});
const discoverySchema = z.discriminatedUnion('stage', [activeSchema, recycledSchema]);
const contextShape = { after: discoverySchema.nullable(), group: zohoArticleGroupSchema };
const cursorSchema = z.discriminatedUnion('stage', [
  activeSchema,
  recycledSchema,
  z.strictObject({ stage: z.literal('group'), ...contextShape }),
  z.strictObject({
    stage: z.enum(['privacy', 'versions', 'files']),
    ...contextShape,
    offset: z.int().min(0).max(1),
    versions: zohoArticleVersionsSchema,
    privacy: zohoKnowledgePrivacySchema,
    files: zohoArticleFilesScanSchema,
  }),
]);
type Cursor = z.infer<typeof cursorSchema>;
type DiscoveryCursor = z.infer<typeof discoverySchema>;
type ContentCursor = Extract<Cursor, { stage: 'privacy' | 'versions' | 'files' }>;
type ArticlePage = { records: ImportPage['records']; cursor: Cursor | null };
type ListCache = NonNullable<Parameters<typeof readZohoArticleListStep>[3]>;

function contentCursor(
  group: ZohoArticleGroup,
  offset: number,
  after: DiscoveryCursor | null,
): Cursor | null {
  const index = group.indices[offset];
  if (!index) return after;
  if (
    group.listing !== null ||
    group.hintOffset !== group.hints.length ||
    !zohoArticleLocale(index.locale)
  )
    throw new ConnectorError('invalid-response');
  return {
    stage: 'privacy',
    group,
    after,
    offset,
    versions: { index, working: null, published: null },
    files: initialZohoArticleFilesScan(),
    privacy: {
      rootId: index.rootCategoryId,
      nextId: index.categoryId,
      seen: [],
      internal: false,
      draft: false,
    },
  };
}

async function activePage(
  client: ZohoDeskClient,
  cursor: Extract<Cursor, { stage: 'scan' }>,
  cache: ListCache,
): Promise<ArticlePage> {
  const step = await readZohoArticleListStep(client, cursor.scan, undefined, cache);
  const after: DiscoveryCursor =
    step.next === null
      ? { stage: 'recycle', scan: initialZohoRecycledArticles() }
      : { stage: 'scan', scan: step.next };
  if (!step.row || step.row.isTrashed) return { records: [], cursor: after };
  if (step.row.locale !== step.row.sourceLocale) throw new ConnectorError('invalid-response');
  const hints = completeZohoArticleHints(
    zohoArticleTranslationHintSchema.parse(step.row),
    step.row.availableLocaleTranslations ?? [],
  );
  return {
    records: [],
    cursor: {
      stage: 'group',
      after,
      group: initialZohoArticleGroup({
        articleId: step.row.id,
        sourceLocale: step.row.sourceLocale,
        hints,
        primary: step.row,
      }),
    },
  };
}

async function recycledPage(
  client: ZohoDeskClient,
  cursor: Extract<Cursor, { stage: 'recycle' }>,
  cache: ZohoRecycledArticlesCache,
): Promise<ArticlePage> {
  const step = await readZohoRecycledArticleStep(client, cursor.scan, cache);
  const after: DiscoveryCursor | null =
    step.next === null ? null : { stage: 'recycle', scan: step.next };
  return {
    records: [],
    cursor: step.group === null ? after : { stage: 'group', after, group: step.group },
  };
}

async function groupPage(
  client: ZohoDeskClient,
  cursor: Extract<Cursor, { stage: 'group' }>,
  cache: ListCache,
): Promise<ArticlePage> {
  const step = await readZohoArticleGroupStep(client, cursor.group, cache);
  return {
    records: [],
    cursor: step.done
      ? contentCursor(step.group, 0, cursor.after)
      : { ...cursor, group: step.group },
  };
}

function validateContentCursor(cursor: ContentCursor): void {
  const index = cursor.group.indices[cursor.offset];
  if (
    !index ||
    cursor.group.listing !== null ||
    cursor.group.hintOffset !== cursor.group.hints.length ||
    hashImportValue(index) !== hashImportValue(cursor.versions.index)
  )
    throw new ConnectorError('invalid-response');
}

async function articleContentPage(
  client: ZohoDeskClient,
  cursor: ContentCursor,
): Promise<ArticlePage> {
  validateContentCursor(cursor);
  if (cursor.stage === 'privacy') {
    const privacy = await zohoKnowledgePrivacyStep(client, cursor.privacy);
    return {
      records: [],
      cursor: { ...cursor, privacy, stage: privacy.nextId === null ? 'versions' : 'privacy' },
    };
  }
  if (cursor.stage === 'versions') {
    const step = await readZohoArticleVersionStep(client, cursor.versions);
    return {
      records: [],
      cursor: { ...cursor, versions: step.state, stage: step.done ? 'files' : 'versions' },
    };
  }
  const working = cursor.versions.working;
  if (!working) throw new ConnectorError('invalid-response');
  const files = await readZohoArticleFilesStep(client, working, cursor.files);
  if (!files.done) return { records: [], cursor: { ...cursor, files: files.next } };
  const anchor = cursor.group.indices[0];
  if (!anchor) throw new ConnectorError('invalid-response');
  const translationOf =
    cursor.offset === 0
      ? undefined
      : `article:${cursor.group.articleId}:${zohoArticleLocale(anchor.locale)}`;
  const record = await zohoArticleRecord(client, cursor.versions, cursor.privacy, translationOf);
  return {
    records: [record],
    cursor: contentCursor(cursor.group, cursor.offset + 1, cursor.after),
  };
}

/** Live and recycle feeds share stable language grouping; deltas rescan both instead of inferring tombstones. */
export async function* exportZohoArticles(
  client: ZohoDeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let cursor = cursorSchema.parse(raw ?? { stage: 'scan', scan: initialZohoArticleList() });
  const scanCache: ListCache = {},
    translationsCache: ListCache = {},
    recycleCache: ZohoRecycledArticlesCache = {};
  while (true) {
    const page =
      cursor.stage === 'scan'
        ? await activePage(client, cursor, scanCache)
        : cursor.stage === 'recycle'
          ? await recycledPage(client, cursor, recycleCache)
          : cursor.stage === 'group'
            ? await groupPage(client, cursor, translationsCache)
            : await articleContentPage(client, cursor);
    yield { ...page, cursor: page.cursor === null ? null : validatedImportCursor(page.cursor) };
    if (page.cursor === null) return;
    cursor = page.cursor;
  }
}
