import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { zohoArticleIndexSchema, zohoArticleTranslationHintSchema } from './article-contracts.js';
import {
  completeZohoArticleHints,
  initialZohoArticleGroup,
  type ZohoArticleGroup,
} from './article-group.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

const nativeSchema = zohoArticleIndexSchema.omit({ rootCategoryId: true }).extend({
  deletedTime: z.iso.datetime({ offset: true }),
  recycleBinEntityId: zohoIdSchema,
  availableLocaleTranslations: z.array(zohoArticleTranslationHintSchema).max(1000),
});
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
export const zohoRecycledArticlesCursorSchema = z.strictObject({
  from: z.int().positive().max(2147483647),
  offset: z.int().min(0).max(50),
  fingerprint: fingerprint.nullable(),
  previousPage: fingerprint.nullable(),
  lastDeletedTime: z.iso.datetime({ offset: true }).nullable(),
});
export type ZohoRecycledArticlesCursor = z.infer<typeof zohoRecycledArticlesCursorSchema>;
export type ZohoRecycledArticlesCache = {
  page?: { from: number; rows: z.infer<typeof nativeSchema>[]; fingerprint: string };
};
export function initialZohoRecycledArticles(): ZohoRecycledArticlesCursor {
  return { from: 1, offset: 0, fingerprint: null, previousPage: null, lastDeletedTime: null };
}

async function articleRecyclePage(
  client: ZohoDeskClient,
  cursor: ZohoRecycledArticlesCursor,
  cache: ZohoRecycledArticlesCache,
) {
  if (cache.page?.from !== cursor.from) {
    const response = await client.list(
      '/api/v1/articleTranslations/trashedTranslations',
      z.object({ data: z.array(nativeSchema).max(50) }),
      { from: String(cursor.from), limit: '50', sortBy: 'deletedTime' },
      { slot: 'zoho.recycled-articles' },
    );
    if (
      response.data.some((row) => !row.isTrashed) ||
      new Set(response.data.map((row) => row.translationId)).size !== response.data.length
    )
      throw new ConnectorError('invalid-response');
    cache.page = {
      from: cursor.from,
      rows: response.data,
      fingerprint: hashImportValue(response.data),
    };
  }
  const page = cache.page;
  if (
    cursor.offset > page.rows.length ||
    page.fingerprint === cursor.previousPage ||
    (cursor.fingerprint !== null && page.fingerprint !== cursor.fingerprint)
  )
    throw new ConnectorError('invalid-response');
  return page;
}

export async function readZohoRecycledArticleStep(
  client: ZohoDeskClient,
  raw: ZohoRecycledArticlesCursor,
  cache: ZohoRecycledArticlesCache = {},
): Promise<{ group: ZohoArticleGroup | null; next: ZohoRecycledArticlesCursor | null }> {
  const cursor = zohoRecycledArticlesCursorSchema.parse(raw);
  const page = await articleRecyclePage(client, cursor, cache),
    row = page.rows[cursor.offset];
  if (!row)
    return {
      group: null,
      next:
        page.rows.length === 50
          ? zohoRecycledArticlesCursorSchema.parse({
              ...cursor,
              from: cursor.from + 50,
              offset: 0,
              fingerprint: null,
              previousPage: page.fingerprint,
            })
          : null,
    };
  if (
    cursor.lastDeletedTime !== null &&
    Date.parse(row.deletedTime) < Date.parse(cursor.lastDeletedTime)
  )
    throw new ConnectorError('invalid-response');
  const ownHint = zohoArticleTranslationHintSchema.parse(row);
  const hints = completeZohoArticleHints(ownHint, row.availableLocaleTranslations);
  const activePrimary = hints.some((hint) => hint.locale === row.sourceLocale && !hint.isTrashed);
  const representative = hints
    .filter((hint) => hint.isTrashed)
    .map((hint) => hint.translationId)
    .sort()[0];
  return {
    // Active primaries were already traversed; choose one native deleted sibling otherwise.
    group:
      activePrimary || representative !== row.translationId
        ? null
        : initialZohoArticleGroup({ articleId: row.id, sourceLocale: row.sourceLocale, hints }),
    next: {
      ...cursor,
      offset: cursor.offset + 1,
      fingerprint: page.fingerprint,
      lastDeletedTime: row.deletedTime,
    },
  };
}
