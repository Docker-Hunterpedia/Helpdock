import { articleImageSources, sanitizeArticleHtml } from '@helpdock/channels';
import { type DbTransaction, hcArticles, hcMedia, importLog, uuidv7 } from '@helpdock/db';
import {
  HC_DESCRIPTION_MAX,
  HC_MAX_ARTICLES,
  hcMediaPath,
  hcVersionSaveRequestSchema,
} from '@helpdock/schemas';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { HelpCenterRepository } from '../../help-center/help-center.repository.js';
import { resolveSlug } from '../../help-center/slugs.js';
import { importedArticleContentHash } from './article-content-hash.js';
import { importedArticleSiblingTarget } from './article-group-target.js';
import { ImportLoadError } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import { type ArticleLoad, articleLoadSchema } from './knowledge-contracts.js';
import {
  importedArticleTarget,
  importedSectionTarget,
  lockImportedKnowledge,
} from './knowledge-targets.js';
import { bindArticleAssets, verifiedArticleAssets } from './load-article-assets.js';
import { requireLoadingRun } from './run-scope.js';

const repository = new HelpCenterRepository();

async function preparedArticleBody(tx: DbTransaction, input: ArticleLoad, html: string) {
  const sources = [...new Set(articleImageSources(html))];
  const prefix = `/api/help-center/brands/${input.brandId}/media/`;
  if (sources.some((src) => !src.startsWith(prefix))) throw new ImportLoadError('mapping-invalid');
  const ids = sources.map((src) => src.slice(prefix.length));
  if (ids.length) {
    if (ids.some((id) => !z.uuid().safeParse(id).success))
      throw new ImportLoadError('mapping-invalid');
    const ready = await tx
      .select({ id: hcMedia.id })
      .from(hcMedia)
      .where(
        and(
          eq(hcMedia.brandId, input.brandId),
          inArray(hcMedia.id, ids),
          eq(hcMedia.status, 'ready'),
          eq(hcMedia.kind, 'image'),
          eq(hcMedia.mime, 'image/webp'),
          isNotNull(hcMedia.webpKey),
        ),
      );
    if (
      ready.length !== ids.length ||
      ready.some((row) => !sources.includes(hcMediaPath(input.brandId, row.id)))
    )
      throw new ImportLoadError('mapping-invalid');
  }
  return sanitizeArticleHtml(html, { brandId: input.brandId });
}

async function articleIdentity(
  tx: DbTransaction,
  input: ArticleLoad,
  sectionId: string,
  knownId: string | undefined,
) {
  const translated = input.record.translationOf
    ? await importedArticleTarget(tx, input, input.record.translationOf)
    : undefined;
  const id =
    knownId ??
    translated?.id ??
    (await importedArticleSiblingTarget(tx, input, input.record.externalId));
  if (id) {
    const [article] = await tx
      .select()
      .from(hcArticles)
      .where(and(eq(hcArticles.id, id), eq(hcArticles.brandId, input.brandId)));
    if (!article) throw new ImportLoadError('target-unavailable');
    if (translated && (translated.id !== id || translated.sectionId !== sectionId))
      throw new ImportLoadError('mapping-invalid');
    return article;
  }
  if ((await repository.count(tx, 'articles')) >= HC_MAX_ARTICLES)
    throw new ImportLoadError('mapping-invalid');
  const createdId = uuidv7();
  return repository.insertArticle(tx, {
    id: createdId,
    brandId: input.brandId,
    sectionId,
    createdAt: new Date(input.record.createdAt),
    updatedAt: new Date(input.record.updatedAt),
    position: await repository.nextPosition(tx, 'articles', sectionId),
    slug: await resolveSlug(tx, repository, 'articles', {
      chosen: undefined,
      from: input.record.title,
      fallback: `article-${createdId}`,
    }),
  });
}

function articleContent(input: ArticleLoad, bodyHtml: string) {
  const excerpt = (input.record.description ?? '')
    .slice(0, HC_DESCRIPTION_MAX)
    .replace(/[\uD800-\uDBFF]$/, '');
  return hcVersionSaveRequestSchema.parse({
    title: input.record.title,
    description: excerpt,
    bodyHtml,
  });
}

function publishedContent(
  input: ArticleLoad,
  body: ReturnType<typeof sanitizeArticleHtml>,
  publishedBody: ReturnType<typeof sanitizeArticleHtml> | undefined,
) {
  if (input.record.published === undefined)
    return input.record.draft
      ? null
      : {
          ...articleContent(input, body.html),
          text: body.text,
          at: new Date(input.record.updatedAt),
        };
  const snapshot = input.record.published;
  if (snapshot === null) return null;
  if (!publishedBody) throw new ImportLoadError('mapping-invalid');
  const description = (snapshot.description ?? '')
    .slice(0, HC_DESCRIPTION_MAX)
    .replace(/[\uD800-\uDBFF]$/, '');
  return {
    ...hcVersionSaveRequestSchema.parse({
      title: snapshot.title,
      description,
      bodyHtml: publishedBody.html,
    }),
    text: publishedBody.text,
    at: snapshot.publishedAt === null ? null : new Date(snapshot.publishedAt),
  };
}

async function saveImportedVersion(
  tx: DbTransaction,
  target: {
    input: ArticleLoad;
    articleId: string;
    existingId: string | undefined;
    body: ReturnType<typeof sanitizeArticleHtml>;
    publishedBody: ReturnType<typeof sanitizeArticleHtml> | undefined;
  },
) {
  const { input, body, publishedBody } = target;
  const content = articleContent(input, body.html);
  const published = publishedContent(input, body, publishedBody);
  const updatedAt = new Date(input.record.updatedAt);
  const version = {
    ...content,
    importedDescription: input.record.description ?? null,
    importEmbeddingDeferred: true,
    importedPublishedDescription:
      input.record.published === undefined
        ? input.record.draft
          ? null
          : (input.record.description ?? null)
        : (input.record.published?.description ?? null),
    status: input.record.draft ? ('draft' as const) : ('published' as const),
    visibility: input.record.internal ? ('internal' as const) : ('public' as const),
    publishedTitle: published?.title ?? null,
    publishedDescription: published?.description ?? null,
    publishedBodyHtml: published?.bodyHtml ?? null,
    publishedBodyText: published?.text ?? null,
    publishedAt: published?.at ?? null,
    publishedBy: null,
    updatedBy: null,
    scheduledAt: null,
    updatedAt,
    changedAt: updatedAt,
  };
  if (target.existingId) await repository.updateVersion(tx, target.existingId, version);
  else
    await repository.insertVersion(tx, {
      ...version,
      brandId: input.brandId,
      articleId: target.articleId,
      locale: input.record.locale,
      createdAt: new Date(input.record.createdAt),
    });
}

async function logArticleDescription(tx: DbTransaction, input: ArticleLoad) {
  if (
    (input.record.description?.length ?? 0) <= HC_DESCRIPTION_MAX &&
    (input.record.published?.description?.length ?? 0) <= HC_DESCRIPTION_MAX
  )
    return;
  await tx.insert(importLog).values({
    brandId: input.brandId,
    runId: input.runId,
    entity: 'article',
    externalId: input.record.externalId,
    level: 'warning',
    message: 'import.article.description-shortened',
  });
}

/** Working and published copies retain source times; no ordinary publish hook is called. */
export async function loadImportedArticle(tx: DbTransaction, request: ArticleLoad) {
  const input = articleLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  await lockImportedKnowledge(tx, input, 'articles');
  const section = await importedSectionTarget(tx, input, input.record.sectionExternalId);
  const body = await preparedArticleBody(tx, input, input.preparedBodyHtml);
  const publishedBody =
    input.preparedPublishedBodyHtml === undefined
      ? undefined
      : await preparedArticleBody(tx, input, input.preparedPublishedBodyHtml);
  const assets = await verifiedArticleAssets(tx, input, body.html, publishedBody?.html);
  const payloadHash = importedArticleContentHash(input, body.html, section.id, assets.prepared);
  const known = await importedIdentity(tx, input, 'article', input.record.externalId);
  const article = await articleIdentity(tx, input, section.id, known?.helpdockId);
  const existing = await repository.version(tx, article.id, input.record.locale);
  await bindArticleAssets(tx, assets.assets, article.id);
  if (known?.payloadHash === payloadHash && existing)
    return { id: article.id, outcome: 'unchanged' as const };
  if (existing && !known) throw new ImportLoadError('mapping-invalid');
  await saveImportedVersion(tx, {
    input,
    articleId: article.id,
    existingId: existing?.id,
    body,
    publishedBody,
  });
  const updatedAt = new Date(input.record.updatedAt);
  await repository.updateArticle(tx, article.id, {
    sectionId: section.id,
    createdAt: new Date(
      Math.min(article.createdAt.getTime(), new Date(input.record.createdAt).getTime()),
    ),
    updatedAt: new Date(Math.max(article.updatedAt.getTime(), updatedAt.getTime())),
  });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    runId: input.runId,
    entity: 'article',
    externalId: input.record.externalId,
    helpdockId: article.id,
    payloadHash,
  });
  await logArticleDescription(tx, input);
  return { id: article.id, outcome: existing ? ('updated' as const) : ('created' as const) };
}
