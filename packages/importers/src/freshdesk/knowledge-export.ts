import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { validatedImportCursor } from '../cursor.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { FreshdeskClient } from './client.js';
import {
  freshdeskArticleSchema,
  freshdeskCategorySchema,
  freshdeskFolderSchema,
} from './contracts.js';
import {
  freshdeskArticleRecords,
  freshdeskFolderParent,
  freshdeskFolderPrivacyStep,
  freshdeskKnowledgeLocales,
  freshdeskPrivacySchema,
  freshdeskTaxonomyRecord,
} from './knowledge-records.js';

const positive = z.number().int().min(1).max(1000000);
const offset = z.number().int().min(0).max(100);
const fingerprint = z.string().length(64);
const categoryCursorSchema = z.strictObject({
  page: positive,
  offset: offset.default(0),
  fingerprint: fingerprint.optional(),
  localesFingerprint: fingerprint.optional(),
});
const frameSchema = z.strictObject({
  parentId: z.number().int().positive().nullable(),
  page: positive.default(1),
  offset: offset.default(0),
  fingerprint: fingerprint.optional(),
  stage: z.enum(['self', 'privacy', 'articles', 'children', 'next']).default('self'),
  privacy: freshdeskPrivacySchema.nullable().default(null),
  articlePage: positive.default(1),
  articleOffset: offset.default(0),
  articleFingerprint: fingerprint.optional(),
});
const cursorSchema = z.strictObject({
  mode: z.enum(['section', 'article']),
  categoryPage: positive.default(1),
  categoryOffset: offset.default(0),
  categoryFingerprint: fingerprint.optional(),
  localesFingerprint: fingerprint.optional(),
  categoryStarted: z.boolean().default(false),
  stack: z.array(frameSchema).max(128).default([]),
});
type Cursor = z.infer<typeof cursorSchema>;
type Frame = z.infer<typeof frameSchema>;
type Page<T> = { rows: T[]; nextPage: number | null };

function replaceFrame(cursor: Cursor, frame: Frame): Cursor {
  return { ...cursor, stack: [...cursor.stack.slice(0, -1), frame] };
}

/** Each cache holds one bounded page; yielded cursors contain IDs/offsets, never whole source lists. */
function knowledgePages(client: FreshdeskClient) {
  let category: { page: number; data: Page<z.infer<typeof freshdeskCategorySchema>> } | undefined;
  let folder: { key: string; data: Page<z.infer<typeof freshdeskFolderSchema>> } | undefined;
  const indexSchema = freshdeskArticleSchema.pick({
    id: true,
    category_id: true,
    folder_id: true,
    updated_at: true,
  });
  let article: { key: string; data: Page<z.infer<typeof indexSchema>> } | undefined;
  return {
    categories: async (page: number) => {
      if (category?.page === page) return category.data;
      const data = await client.page('/api/v2/solutions/categories', freshdeskCategorySchema, {
        page: String(page),
        per_page: '100',
      });
      category = { page, data };
      return data;
    },
    folders: async (categoryId: number, frame: Frame) => {
      const path =
        frame.parentId === null
          ? `/api/v2/solutions/categories/${categoryId}/folders`
          : `/api/v2/solutions/folders/${frame.parentId}/subfolders`;
      const key = `${path}:${frame.page}`;
      if (folder?.key === key) return folder.data;
      const data = await client.page(path, freshdeskFolderSchema, {
        page: String(frame.page),
        per_page: '100',
      });
      folder = { key, data };
      return data;
    },
    articles: async (id: number, page: number) => {
      const key = `${id}:${page}`;
      if (article?.key === key) return article.data;
      const data = await client.page(`/api/v2/solutions/folders/${id}/articles`, indexSchema, {
        page: String(page),
        per_page: '100',
      });
      article = { key, data };
      return data;
    },
  };
}

async function* categories(
  client: FreshdeskClient,
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  const locales = await freshdeskKnowledgeLocales(client);
  const localesFingerprint = hashImportValue(locales);
  let checkpoint = categoryCursorSchema.parse(raw ?? { page: 1 });
  if (checkpoint.localesFingerprint && checkpoint.localesFingerprint !== localesFingerprint)
    throw new ConnectorError('invalid-response');
  checkpoint = { ...checkpoint, localesFingerprint };
  while (true) {
    const page = await client.page('/api/v2/solutions/categories', freshdeskCategorySchema, {
      page: String(checkpoint.page),
      per_page: '100',
    });
    const hash = hashImportValue(page.rows);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== hash) ||
      checkpoint.offset > page.rows.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.offset; index < page.rows.length; index++) {
      const row = page.rows[index];
      if (!row) throw new ConnectorError('invalid-response');
      yield {
        records: [await freshdeskTaxonomyRecord(client, 'category', row, row.id, locales)],
        cursor: validatedImportCursor({ ...checkpoint, offset: index + 1, fingerprint: hash }),
      };
    }
    if (!page.nextPage) {
      yield { records: [], cursor: null };
      return;
    }
    checkpoint = { page: page.nextPage, offset: 0, localesFingerprint };
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
}

async function* folders(
  client: FreshdeskClient,
  mode: 'section' | 'article',
  raw: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  const locales = await freshdeskKnowledgeLocales(client);
  const localesFingerprint = hashImportValue(locales);
  let checkpoint = cursorSchema.parse(raw ?? { mode });
  if (
    checkpoint.mode !== mode ||
    (checkpoint.localesFingerprint && checkpoint.localesFingerprint !== localesFingerprint)
  )
    throw new ConnectorError('invalid-response');
  checkpoint = { ...checkpoint, localesFingerprint };
  const pages = knowledgePages(client);
  while (true) {
    const categoryPage = await pages.categories(checkpoint.categoryPage);
    const categoryHash = hashImportValue(categoryPage.rows);
    if (
      (checkpoint.categoryFingerprint && checkpoint.categoryFingerprint !== categoryHash) ||
      checkpoint.categoryOffset > categoryPage.rows.length
    )
      throw new ConnectorError('invalid-response');
    const category = categoryPage.rows[checkpoint.categoryOffset];
    if (!category) {
      if (checkpoint.stack.length) throw new ConnectorError('invalid-response');
      if (!categoryPage.nextPage) {
        yield { records: [], cursor: null };
        return;
      }
      checkpoint = cursorSchema.parse({
        mode,
        categoryPage: categoryPage.nextPage,
        localesFingerprint,
      });
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    checkpoint = { ...checkpoint, categoryFingerprint: categoryHash };
    if (!checkpoint.categoryStarted) {
      checkpoint = {
        ...checkpoint,
        categoryStarted: true,
        stack: [frameSchema.parse({ parentId: null })],
      };
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    const frame = checkpoint.stack.at(-1);
    if (!frame) {
      checkpoint = {
        ...checkpoint,
        categoryStarted: false,
        categoryOffset: checkpoint.categoryOffset + 1,
      };
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    const folderPage = await pages.folders(category.id, frame);
    const folderHash = hashImportValue(folderPage.rows);
    if (
      (frame.fingerprint && frame.fingerprint !== folderHash) ||
      frame.offset > folderPage.rows.length
    )
      throw new ConnectorError('invalid-response');
    const folder = folderPage.rows[frame.offset];
    if (!folder) {
      checkpoint = folderPage.nextPage
        ? replaceFrame(
            checkpoint,
            frameSchema.parse({ parentId: frame.parentId, page: folderPage.nextPage }),
          )
        : { ...checkpoint, stack: checkpoint.stack.slice(0, -1) };
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    const parent = freshdeskFolderParent(folder, category.id);
    if (
      (frame.parentId !== null && parent !== frame.parentId) ||
      checkpoint.stack.some((entry) => entry.parentId === folder.id)
    )
      throw new ConnectorError('invalid-response');
    const current = { ...frame, fingerprint: folderHash };
    checkpoint = replaceFrame(checkpoint, current);
    if (current.stage === 'self') {
      if (mode === 'section') {
        checkpoint = replaceFrame(checkpoint, { ...current, stage: 'children' });
        yield {
          records: [await freshdeskTaxonomyRecord(client, 'section', folder, category.id, locales)],
          cursor: validatedImportCursor(checkpoint),
        };
      } else {
        checkpoint = replaceFrame(checkpoint, {
          ...current,
          stage: 'privacy',
          privacy: { nextId: folder.id, seen: [], internal: folder.visibility !== 1 },
        });
        yield { records: [], cursor: validatedImportCursor(checkpoint) };
      }
      continue;
    }
    if (current.stage === 'privacy') {
      if (mode !== 'article' || !current.privacy) throw new ConnectorError('invalid-response');
      const privacy = await freshdeskFolderPrivacyStep(client, category.id, current.privacy);
      checkpoint = replaceFrame(checkpoint, {
        ...current,
        privacy,
        stage: privacy.nextId === null ? 'articles' : 'privacy',
      });
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    if (current.stage === 'articles') {
      if (mode !== 'article' || !current.privacy || current.privacy.nextId !== null)
        throw new ConnectorError('invalid-response');
      const articles = await pages.articles(folder.id, current.articlePage);
      const hash = hashImportValue(articles.rows);
      if (
        (current.articleFingerprint && current.articleFingerprint !== hash) ||
        current.articleOffset > articles.rows.length
      )
        throw new ConnectorError('invalid-response');
      const article = articles.rows[current.articleOffset];
      if (article) {
        if (article.folder_id !== folder.id || article.category_id !== category.id)
          throw new ConnectorError('invalid-response');
        const records = await freshdeskArticleRecords(
          client,
          article.id,
          folder.id,
          category.id,
          locales,
          current.privacy.internal,
        );
        checkpoint = replaceFrame(checkpoint, {
          ...current,
          articleOffset: current.articleOffset + 1,
          articleFingerprint: hash,
        });
        yield { records, cursor: validatedImportCursor(checkpoint) };
      } else {
        const { articleFingerprint: _hash, ...rest } = current;
        checkpoint = replaceFrame(
          checkpoint,
          articles.nextPage
            ? { ...rest, articlePage: articles.nextPage, articleOffset: 0 }
            : { ...rest, stage: 'children' },
        );
        yield { records: [], cursor: validatedImportCursor(checkpoint) };
      }
      continue;
    }
    if (current.stage === 'children') {
      checkpoint = replaceFrame(checkpoint, { ...current, stage: 'next' });
      if (folder.sub_folders_count !== 0) {
        if (checkpoint.stack.length >= 128) throw new ConnectorError('invalid-response');
        checkpoint = {
          ...checkpoint,
          stack: [...checkpoint.stack, frameSchema.parse({ parentId: folder.id })],
        };
      }
      yield { records: [], cursor: validatedImportCursor(checkpoint) };
      continue;
    }
    const { articleFingerprint: _hash, ...rest } = current;
    checkpoint = replaceFrame(checkpoint, {
      ...rest,
      offset: current.offset + 1,
      stage: 'self',
      privacy: null,
      articlePage: 1,
      articleOffset: 0,
    });
    yield { records: [], cursor: validatedImportCursor(checkpoint) };
  }
}

export function exportFreshdeskKnowledge(
  client: FreshdeskClient,
  entity: 'category' | 'section' | 'article',
  cursor: ImportCursor | null,
): AsyncIterable<ImportPage> {
  return entity === 'category' ? categories(client, cursor) : folders(client, entity, cursor);
}
