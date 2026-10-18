import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import { type ZohoArticleIndex, zohoArticleIndexSchema } from './article-contracts.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

const statuses = ['Draft', 'Published', 'Review', 'Expired', 'Unpublished'] as const;
export const zohoArticleListCursorSchema = z.strictObject({
  from: z.int().min(0).max(2147483647).nullable(),
  offset: z.int().min(0).max(50),
  origin: z.union([z.literal(0), z.literal(1)]).nullable(),
  statusIndex: z.int().min(0).max(4),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  previousPage: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type ZohoArticleListCursor = z.infer<typeof zohoArticleListCursorSchema>;
export function initialZohoArticleList(): ZohoArticleListCursor {
  return {
    from: null,
    offset: 0,
    origin: null,
    statusIndex: 0,
    fingerprint: null,
    previousPage: null,
  };
}
const pageSchema = z.object({ data: z.array(zohoArticleIndexSchema).max(50) });
type PageCache = {
  page?: { key: string; rows: ZohoArticleIndex[]; origin: 0 | 1; fingerprint: string };
};

/** The table says positive offsets while the example uses zero: prove the basis before advancing. */
async function offsetOrigin(
  client: ZohoDeskClient,
  path: string,
  query: Record<string, string>,
  first: ZohoArticleIndex[],
): Promise<0 | 1> {
  const probe = await client.list(path, pageSchema, { ...query, from: '1' });
  if (hashImportValue(probe.data) === hashImportValue(first)) return 1;
  const overlap = first.slice(1);
  const expectedLength = first.length === 50 ? 50 : overlap.length;
  if (
    probe.data.length === expectedLength &&
    hashImportValue(probe.data.slice(0, overlap.length)) === hashImportValue(overlap)
  )
    return 0;
  throw new ConnectorError('invalid-response');
}

async function articlePage(
  client: ZohoDeskClient,
  cursor: ZohoArticleListCursor,
  articleId: string | undefined,
  cache: PageCache,
) {
  const path =
    articleId === undefined
      ? '/api/v1/articles'
      : `/api/v1/articles/${zohoIdSchema.parse(articleId)}/translations`;
  const key = `${path}:${cursor.statusIndex}:${cursor.from}`;
  if (cache.page?.key !== key) {
    const status = statuses[cursor.statusIndex];
    if (!status) throw new ConnectorError('invalid-response');
    const query = {
      status,
      limit: '50',
      sortBy: 'createdTime',
      ...(cursor.from === null ? {} : { from: String(cursor.from) }),
    };
    const page = await client.list(path, pageSchema, query);
    if (
      new Set(page.data.map((row) => `${row.id}:${row.translationId}`)).size !== page.data.length ||
      page.data.some(
        (row) => row.status !== status || (articleId !== undefined && row.id !== articleId),
      )
    )
      throw new ConnectorError('invalid-response');
    const origin =
      cursor.origin ?? (page.data.length ? await offsetOrigin(client, path, query, page.data) : 1);
    cache.page = { key, rows: page.data, origin, fingerprint: hashImportValue(page.data) };
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

/** One thin native item per checkpoint; delta callers also rescan to catch translation edits. */
export async function readZohoArticleListStep(
  client: ZohoDeskClient,
  raw: ZohoArticleListCursor,
  articleId?: string,
  cache: PageCache = {},
): Promise<{ row: ZohoArticleIndex | null; next: ZohoArticleListCursor | null }> {
  const cursor = zohoArticleListCursorSchema.parse(raw);
  if (cursor.origin === null && cursor.from !== null) throw new ConnectorError('invalid-response');
  const page = await articlePage(client, cursor, articleId, cache);
  const row = page.rows[cursor.offset];
  if (row)
    return {
      row,
      next: {
        ...cursor,
        origin: page.origin,
        offset: cursor.offset + 1,
        fingerprint: page.fingerprint,
      },
    };
  if (page.rows.length === 50)
    return {
      row: null,
      next: zohoArticleListCursorSchema.parse({
        ...cursor,
        from: (cursor.from ?? page.origin) + 50,
        origin: page.origin,
        offset: 0,
        fingerprint: null,
        previousPage: page.fingerprint,
      }),
    };
  if (cursor.statusIndex < 4)
    return {
      row: null,
      next: { ...initialZohoArticleList(), statusIndex: cursor.statusIndex + 1 },
    };
  return { row: null, next: null };
}
