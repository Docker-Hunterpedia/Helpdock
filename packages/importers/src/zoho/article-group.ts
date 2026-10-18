import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import {
  type ZohoArticleIndex,
  zohoArticleIndexSchema,
  zohoArticleLocaleSchema,
  zohoArticleSchema,
  zohoArticleTranslationHintSchema,
} from './article-contracts.js';
import {
  initialZohoArticleList,
  readZohoArticleListStep,
  zohoArticleListCursorSchema,
} from './article-list.js';
import { zohoArticleLocale } from './article-record.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

type Hint = z.infer<typeof zohoArticleTranslationHintSchema>;
export function completeZohoArticleHints(primary: Hint, available: Hint[]): Hint[] {
  if (new Set(available.map((hint) => hint.translationId)).size !== available.length)
    throw new ConnectorError('invalid-response');
  const own = available.find((hint) => hint.translationId === primary.translationId);
  if (
    own &&
    (own.locale !== primary.locale ||
      own.isTrashed !== primary.isTrashed ||
      (own.latestVersion !== undefined && own.latestVersion !== primary.latestVersion))
  )
    throw new ConnectorError('invalid-response');
  return own
    ? available.map((hint) => (hint.translationId === primary.translationId ? primary : hint))
    : [...available, primary];
}
export const zohoArticleGroupSchema = z.strictObject({
  articleId: zohoIdSchema,
  sourceLocale: zohoArticleLocaleSchema,
  listing: zohoArticleListCursorSchema.nullable(),
  hints: z.array(zohoArticleTranslationHintSchema).max(1001),
  hintOffset: z.int().min(0).max(1001),
  indices: z.array(zohoArticleIndexSchema).max(2),
});
export type ZohoArticleGroup = z.infer<typeof zohoArticleGroupSchema>;
type ListCache = NonNullable<Parameters<typeof readZohoArticleListStep>[3]>;

export function initialZohoArticleGroup(input: {
  articleId: string;
  sourceLocale: string;
  hints: Hint[];
  primary?: ZohoArticleIndex;
}): ZohoArticleGroup {
  if (new Set(input.hints.map((hint) => hint.translationId)).size !== input.hints.length)
    throw new ConnectorError('invalid-response');
  return zohoArticleGroupSchema.parse({
    articleId: input.articleId,
    sourceLocale: input.sourceLocale,
    hints: input.hints,
    listing: initialZohoArticleList(),
    hintOffset: 0,
    indices: input.primary && zohoArticleLocale(input.primary.locale) ? [input.primary] : [],
  });
}

function indexHash(index: ZohoArticleIndex): string {
  const { availableLocaleTranslations: _hints, ...identity } = index;
  return hashImportValue(identity);
}

function includeTranslation(group: ZohoArticleGroup, index: ZohoArticleIndex): ZohoArticleGroup {
  if (index.id !== group.articleId || index.sourceLocale !== group.sourceLocale)
    throw new ConnectorError('invalid-response');
  const locale = zohoArticleLocale(index.locale);
  if (!locale) return group;
  const known = group.indices.find((row) => zohoArticleLocale(row.locale) === locale);
  if (known) {
    if (indexHash(known) !== indexHash(index)) throw new ConnectorError('invalid-response');
    return group;
  }
  return {
    ...group,
    indices: [...group.indices, index].sort(
      (left, right) =>
        translationOrder(left, group.sourceLocale) - translationOrder(right, group.sourceLocale),
    ),
  };
}

function translationOrder(index: ZohoArticleIndex, sourceLocale: string): number {
  if (index.locale === sourceLocale) return 0;
  return zohoArticleLocale(index.locale) === 'en' ? 1 : 2;
}

async function hintIndex(
  client: ZohoDeskClient,
  articleId: string,
  hint: Hint,
): Promise<ZohoArticleIndex> {
  const row = await client.json(
    `/api/v1/articles/${articleId}/translations/${encodeURIComponent(hint.locale)}`,
    zohoArticleSchema,
    hint.latestVersion === undefined ? {} : { version: hint.latestVersion },
  );
  if (
    row.id !== articleId ||
    row.translationId !== hint.translationId ||
    row.locale !== hint.locale ||
    row.isTrashed !== hint.isTrashed ||
    row.currentVersion !== row.latestVersion ||
    (hint.latestVersion !== undefined && row.currentVersion !== hint.latestVersion)
  )
    throw new ConnectorError('invalid-response');
  return zohoArticleIndexSchema.parse(row);
}

/** Only two supported indices survive in a group; native hints can recover siblings omitted by live lists. */
export async function readZohoArticleGroupStep(
  client: ZohoDeskClient,
  raw: ZohoArticleGroup,
  cache: ListCache = {},
): Promise<{ group: ZohoArticleGroup; done: boolean }> {
  const group = zohoArticleGroupSchema.parse(raw);
  if (
    group.hintOffset > group.hints.length ||
    group.indices.some(
      (row) =>
        row.id !== group.articleId ||
        row.sourceLocale !== group.sourceLocale ||
        zohoArticleLocale(row.locale) === null,
    ) ||
    new Set(group.indices.map((row) => zohoArticleLocale(row.locale))).size !== group.indices.length
  )
    throw new ConnectorError('invalid-response');
  if (group.listing !== null) {
    const step = await readZohoArticleListStep(client, group.listing, group.articleId, cache);
    const next = { ...group, listing: step.next };
    if (step.row && zohoArticleLocale(step.row.locale) === null)
      await client.warnKnowledge(
        'import.knowledge.locale-unsupported',
        'article',
        `article:${group.articleId}:${step.row.locale}`,
      );
    return { group: step.row ? includeTranslation(next, step.row) : next, done: false };
  }
  const hint = group.hints[group.hintOffset];
  if (!hint) return { group, done: true };
  return { group: await resolvedTranslationHint(client, group, hint), done: false };
}

async function resolvedTranslationHint(
  client: ZohoDeskClient,
  group: ZohoArticleGroup,
  hint: Hint,
): Promise<ZohoArticleGroup> {
  const next = { ...group, hintOffset: group.hintOffset + 1 };
  const locale = zohoArticleLocale(hint.locale);
  if (!locale) {
    await client.warnKnowledge(
      'import.knowledge.locale-unsupported',
      'article',
      `article:${group.articleId}:${hint.locale}`,
    );
    return next;
  }
  const known = group.indices.find((row) => zohoArticleLocale(row.locale) === locale);
  if (known) {
    if (
      known.locale !== hint.locale ||
      known.translationId !== hint.translationId ||
      known.isTrashed !== hint.isTrashed ||
      (hint.latestVersion !== undefined && known.latestVersion !== hint.latestVersion)
    )
      throw new ConnectorError('invalid-response');
    return next;
  }
  return includeTranslation(next, await hintIndex(client, group.articleId, hint));
}
