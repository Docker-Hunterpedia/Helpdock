import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { ConnectorError } from '../errors.js';
import { zohoArticleAttachmentRefs } from './article-attachments.js';
import { validateZohoArticleVersions, type ZohoArticleVersions } from './article-versions.js';
import type { ZohoDeskClient } from './client.js';
import { type ZohoKnowledgePrivacy, zohoKnowledgePrivacySchema } from './knowledge-privacy.js';

export function zohoArticleLocale(source: string): 'en' | 'ar' | null {
  const base = source.toLowerCase().replaceAll('_', '-').split('-')[0];
  return base === 'en' || base === 'ar' ? base : null;
}

/** Publication uses the pinned public version; current working changes remain private. */
export async function zohoArticleRecord(
  client: ZohoDeskClient,
  raw: ZohoArticleVersions,
  rawPrivacy: ZohoKnowledgePrivacy,
  translationOf?: string,
): Promise<ImportRecord> {
  const versions = validateZohoArticleVersions(raw);
  const privacy = zohoKnowledgePrivacySchema.parse(rawPrivacy);
  const { index, working, published } = versions;
  const locale = zohoArticleLocale(index.locale);
  if (
    !working ||
    !locale ||
    privacy.nextId !== null ||
    privacy.rootId !== index.rootCategoryId ||
    !privacy.seen.includes(index.categoryId) ||
    !privacy.seen.includes(index.rootCategoryId) ||
    working.currentVersion !== index.latestVersion ||
    (published?.currentVersion ?? null) !== index.latestPublishedVersion
  )
    throw new ConnectorError('invalid-response');
  const externalId = `article:${index.id}:${locale}`;
  const internal = privacy.internal || index.permission !== 'ALL' || index.isTrashed;
  if (internal)
    await client.warnKnowledge('import.knowledge.readership-restricted', 'article', externalId);
  return importRecordSchema.parse({
    entity: 'article',
    payload: {
      externalId,
      sectionExternalId: `section:${index.categoryId}`,
      locale,
      title: working.title,
      bodyHtml: working.answer,
      assetOrigin: client.origin,
      ...(working.summary == null ? {} : { description: working.summary }),
      attachments: zohoArticleAttachmentRefs(client, working),
      draft: privacy.draft || index.isTrashed || index.status !== 'Published' || published === null,
      internal,
      createdAt: index.createdTime,
      updatedAt: index.modifiedTime,
      ...(translationOf === undefined ? {} : { translationOf }),
      published:
        published === null
          ? null
          : {
              title: published.title,
              bodyHtml: published.answer,
              assetOrigin: client.origin,
              ...(published.summary == null ? {} : { description: published.summary }),
              // Neither modifiedTime nor reviewedTime establishes actual publication time.
              publishedAt: null,
              attachments: zohoArticleAttachmentRefs(client, published),
            },
    },
  });
}
