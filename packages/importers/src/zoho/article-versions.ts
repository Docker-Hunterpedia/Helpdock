import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import {
  type ZohoArticle,
  type ZohoArticleIndex,
  zohoArticleAttachmentSchema,
  zohoArticleIndexSchema,
  zohoArticleSchema,
} from './article-contracts.js';
import type { ZohoDeskClient } from './client.js';

// The wire uses decimal strings; a persisted checkpoint already holds byte counts.
const articleSnapshotSchema = zohoArticleSchema.extend({
  attachments: z
    .array(
      zohoArticleAttachmentSchema.extend({
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(1000),
});
export const zohoArticleVersionsSchema = z.strictObject({
  index: zohoArticleIndexSchema,
  working: articleSnapshotSchema.nullable(),
  published: articleSnapshotSchema.nullable(),
});
export type ZohoArticleVersions = z.infer<typeof zohoArticleVersionsSchema>;

function sameTranslation(index: ZohoArticleIndex, row: ZohoArticle) {
  if (
    row.id !== index.id ||
    row.translationId !== index.translationId ||
    row.locale !== index.locale ||
    row.sourceLocale !== index.sourceLocale ||
    row.rootCategoryId !== index.rootCategoryId ||
    row.categoryId !== index.categoryId ||
    row.status !== index.status ||
    row.latestVersion !== index.latestVersion ||
    row.latestPublishedVersion !== index.latestPublishedVersion ||
    row.latestVersionStatus !== index.latestVersionStatus ||
    row.permission !== index.permission ||
    row.isTrashed !== index.isTrashed
  )
    throw new ConnectorError('invalid-response');
}

export function validateZohoArticleVersions(raw: ZohoArticleVersions): ZohoArticleVersions {
  const state = zohoArticleVersionsSchema.parse(raw);
  for (const [row, version] of [
    [state.working, state.index.latestVersion],
    [state.published, state.index.latestPublishedVersion],
  ] as const) {
    if (!row) continue;
    sameTranslation(state.index, row);
    if (version === null || row.currentVersion !== version)
      throw new ConnectorError('invalid-response');
  }
  if (
    (state.working && state.working.modifiedTime !== state.index.modifiedTime) ||
    (state.published && !state.working)
  )
    throw new ConnectorError('invalid-response');
  return state;
}

/** Pin each detail request to the discovered version; a shifted/latest draft cannot replace the public body. */
export async function readZohoArticleVersionStep(
  client: ZohoDeskClient,
  raw: ZohoArticleVersions,
): Promise<{ state: ZohoArticleVersions; done: boolean }> {
  const state = validateZohoArticleVersions(raw),
    index = state.index;
  const working = state.working === null;
  if (!working && (state.published !== null || index.latestPublishedVersion === null))
    return { state, done: true };
  const version = working ? index.latestVersion : index.latestPublishedVersion;
  if (version === null) throw new ConnectorError('invalid-response');
  const row = await client.json(
    `/api/v1/articles/${index.id}/translations/${encodeURIComponent(index.locale)}`,
    zohoArticleSchema,
    { version },
  );
  sameTranslation(index, row);
  if (row.currentVersion !== version || (working && row.modifiedTime !== index.modifiedTime))
    throw new ConnectorError('invalid-response');
  const next = zohoArticleVersionsSchema.parse({
    ...state,
    ...(working ? { working: row } : { published: row }),
    ...(working && index.latestPublishedVersion === index.latestVersion ? { published: row } : {}),
  });
  return {
    state: next,
    done:
      next.working !== null && (next.published !== null || index.latestPublishedVersion === null),
  };
}
