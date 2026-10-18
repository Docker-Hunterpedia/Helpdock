import { Readable } from 'node:stream';
import { type ImportAttachmentRef, importAttachmentRefSchema } from '@helpdock/schemas';
import { ConnectorError } from '../errors.js';
import {
  type ZohoArticle,
  zohoArticleLocaleSchema,
  zohoArticleResourceIdSchema,
  zohoArticleSchema,
  zohoArticleVersionSchema,
} from './article-contracts.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';

type Locator = { articleId: string; locale: string; version: string; resourceId: string };
function parentPath(locator: Locator): string {
  return `/api/v1/articles/${locator.articleId}/translations/${encodeURIComponent(locator.locale)}`;
}
function contentPath(locator: Locator): string {
  return `${parentPath(locator)}/attachments/${locator.resourceId}/content`;
}

/** Version identity keeps unpublished and public file sets independent, even when names or view URLs overlap. */
export function zohoArticleAttachmentRefs(
  client: ZohoDeskClient,
  article: ZohoArticle,
): ImportAttachmentRef[] {
  return article.attachments.map((file) => {
    const locator = {
      articleId: article.id,
      locale: article.locale,
      version: article.currentVersion,
      resourceId: file.resourceId,
    };
    const path = contentPath(locator);
    const aliases = [file.viewUrl, file.downloadUrl].map((url) =>
      client.articleDisplayAlias(url, path),
    );
    return importAttachmentRefSchema.parse({
      externalId: `a:${article.id}:${article.locale}:v:${article.currentVersion}:r:${file.resourceId}`,
      fileName: file.name,
      size: file.size,
      url: client.url(path),
      sourceUrls: [...new Set(aliases)],
    });
  });
}

function attachmentLocator(ref: ImportAttachmentRef): Locator {
  const match = /^a:([1-9]\d*):([A-Za-z0-9_-]+):v:([0-9.]+):r:([A-Za-z0-9]+)$/.exec(ref.externalId);
  if (!match) throw new ConnectorError('invalid-response');
  return {
    articleId: zohoIdSchema.parse(match[1]),
    locale: zohoArticleLocaleSchema.parse(match[2]),
    version: zohoArticleVersionSchema.parse(match[3]),
    resourceId: zohoArticleResourceIdSchema.parse(match[4]),
  };
}
const refused = (error: unknown) =>
  error instanceof ConnectorError && (error.code === 'record-unavailable' || error.status === 403);

async function refreshFile(
  client: ZohoDeskClient,
  locator: Locator,
  ref: ImportAttachmentRef,
): Promise<void> {
  const article = await client.json(parentPath(locator), zohoArticleSchema, {
    version: locator.version,
  });
  if (
    article.id !== locator.articleId ||
    article.locale !== locator.locale ||
    article.currentVersion !== locator.version
  )
    throw new ConnectorError('invalid-response');
  const file = article.attachments.find((entry) => entry.resourceId === locator.resourceId);
  if (!file) throw new ConnectorError('record-unavailable');
  if (file.name !== ref.fileName || (ref.size !== undefined && file.size !== ref.size))
    throw new ConnectorError('invalid-response');
  client.articleDisplayAlias(file.viewUrl, contentPath(locator));
  client.articleDisplayAlias(file.downloadUrl, contentPath(locator));
}

/** The authenticated target is constructed from the native parent, never from a view/CDN locator. */
export async function fetchZohoArticleAttachment(client: ZohoDeskClient, raw: ImportAttachmentRef) {
  const ref = importAttachmentRefSchema.parse(raw),
    locator = attachmentLocator(ref);
  if (!ref.url) throw new ConnectorError('invalid-response');
  const path = contentPath(locator);
  client.articleResource(ref.url, path);
  for (const alias of ref.sourceUrls ?? []) client.articleDisplayAlias(alias, path);
  let response: Awaited<ReturnType<ZohoDeskClient['request']>>;
  try {
    response = await client.request(path);
  } catch (error) {
    if (!refused(error)) throw error;
    await client.warnAttachmentRefresh(ref.externalId);
    await refreshFile(client, locator, ref);
    try {
      response = await client.request(path);
    } catch (retry) {
      if (refused(retry)) throw new ConnectorError('record-unavailable');
      throw retry;
    }
  }
  if (ref.size !== undefined && response.body.length !== ref.size)
    throw new ConnectorError('invalid-response');
  const contentType = response.headers['content-type'];
  return {
    stream: Readable.from(response.body),
    size: response.body.length,
    ...(typeof contentType === 'string' ? { contentType } : {}),
  };
}
