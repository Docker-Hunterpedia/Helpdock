import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import {
  type ZohoArticle,
  zohoArticleAttachmentListItemSchema,
  zohoArticleResourceIdSchema,
  zohoArticleSchema,
} from './article-contracts.js';
import type { ZohoDeskClient } from './client.js';

export const zohoArticleFilesScanSchema = z.strictObject({
  from: z.int().min(1).max(1001),
  seen: z.array(zohoArticleResourceIdSchema).max(1000),
  envelopeWarned: z.boolean(),
});
export type ZohoArticleFilesScan = z.infer<typeof zohoArticleFilesScanSchema>;
export function initialZohoArticleFilesScan(): ZohoArticleFilesScan {
  return { from: 1, seen: [], envelopeWarned: false };
}

const pageSchema = z.union([
  zohoArticleAttachmentListItemSchema.transform((file) => ({ rows: [file], inferred: false })),
  z
    .object({ data: z.array(zohoArticleAttachmentListItemSchema).max(1) })
    .transform((page) => ({ rows: page.data, inferred: page.data.length > 0 })),
]);
type ListedFile = z.infer<typeof zohoArticleAttachmentListItemSchema>;

function validateFileScan(article: ZohoArticle, scan: ZohoArticleFilesScan): void {
  const expectedIds = new Set(article.attachments.map((file) => file.resourceId));
  if (
    scan.seen.length !== scan.from - 1 ||
    new Set(scan.seen).size !== scan.seen.length ||
    expectedIds.size !== article.attachments.length ||
    scan.seen.some((id) => !expectedIds.has(id)) ||
    article.currentVersion !== article.latestVersion
  )
    throw new ConnectorError('invalid-response');
}

function validateListedFile(client: ZohoDeskClient, article: ZohoArticle, row: ListedFile): void {
  const expected = article.attachments.find((file) => file.resourceId === row.resourceId);
  if (
    !expected ||
    row.name !== expected.name ||
    row.filesize !== expected.size ||
    row.extension !== expected.extension ||
    row.createdTime !== expected.createdTime
  )
    throw new ConnectorError('invalid-response');
  const path = `/api/v1/articles/${article.id}/translations/${encodeURIComponent(article.locale)}/attachments/${row.resourceId}/content`;
  client.articleDisplayAlias(row.viewUrl, path);
  client.articleDisplayAlias(row.downloadUrl, path);
}

function snapshotHash(article: ZohoArticle): string {
  return hashImportValue({
    ...article,
    attachments: article.attachments
      .map(({ viewUrl: _view, downloadUrl: _download, ...file }) => file)
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
  });
}

/** A single-object list example is ambiguous: request one item and validate every offset against the pinned detail. */
export async function readZohoArticleFilesStep(
  client: ZohoDeskClient,
  article: ZohoArticle,
  raw: ZohoArticleFilesScan,
): Promise<{ next: ZohoArticleFilesScan; done: boolean }> {
  const scan = zohoArticleFilesScanSchema.parse(raw);
  validateFileScan(article, scan);
  const parent = `/api/v1/articles/${article.id}/translations/${encodeURIComponent(article.locale)}`;
  const page = await client.list(`${parent}/attachments`, pageSchema, {
    from: String(scan.from),
    limit: '1',
  });
  const row = page.rows[0];
  if (!row) {
    if (scan.seen.length !== article.attachments.length)
      throw new ConnectorError('invalid-response');
    // The file list has no documented version selector. Refuse source changes during its traversal.
    const refreshed = await client.json(parent, zohoArticleSchema, {
      version: article.currentVersion,
    });
    if (snapshotHash(article) !== snapshotHash(refreshed))
      throw new ConnectorError('invalid-response');
    return { next: scan, done: true };
  }
  if (scan.seen.includes(row.resourceId)) throw new ConnectorError('invalid-response');
  validateListedFile(client, article, row);
  if (page.inferred && !scan.envelopeWarned)
    await client.warnArticleFileEnvelope(`article:${article.id}:${article.locale}`);
  return {
    next: zohoArticleFilesScanSchema.parse({
      from: scan.from + 1,
      seen: [...scan.seen, row.resourceId],
      envelopeWarned: scan.envelopeWarned || page.inferred,
    }),
    done: false,
  };
}
