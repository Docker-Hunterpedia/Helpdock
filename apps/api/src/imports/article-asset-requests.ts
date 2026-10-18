import { articleImageSources } from '@helpdock/channels';
import { hashImportValue } from '@helpdock/importers';
import {
  HC_IMAGE_MIME_TYPES,
  HC_MEDIA_PATH_PATTERN,
  type ImportAttachmentRef,
  type ImportSource,
  importArticleSchema,
  importAttachmentRefSchema,
  importBundlePathSchema,
} from '@helpdock/schemas';
import type { z } from 'zod';
import { ImportLoadError } from './loader/contracts.js';

type Article = z.infer<typeof importArticleSchema>;
type Identity = Pick<ImportAttachmentRef, 'externalId' | 'fileName' | 'contentType' | 'size'>;
export type ImportArticleAssetRequest = {
  key: string;
  usage: 'image' | 'download';
  identity: Identity;
  sources: string[];
  input:
    | { kind: 'reference'; ref: ImportAttachmentRef }
    | { kind: 'inline'; mime: string; base64: string };
};

export function importArticleAssetMetadataHash(
  request: Pick<ImportArticleAssetRequest, 'usage' | 'identity'>,
): string {
  return hashImportValue({
    usage: request.usage,
    externalId: request.identity.externalId,
    fileName: request.identity.fileName,
    size: request.identity.size ?? null,
    contentType: request.identity.contentType ?? null,
  });
}

function reference(
  usage: ImportArticleAssetRequest['usage'],
  ref: ImportAttachmentRef,
  sources: string[],
): ImportArticleAssetRequest {
  const {
    url: _url,
    bundlePath: _path,
    sourcePage: _page,
    sourceUrls: _aliases,
    ...identity
  } = ref;
  return {
    key: hashImportValue({ usage, externalId: ref.externalId }),
    usage,
    identity,
    sources,
    input: { kind: 'reference', ref },
  };
}

function sameLocator(ref: ImportAttachmentRef, source: string): boolean {
  if (ref.bundlePath) return ref.bundlePath === source;
  return (
    URL.canParse(source) &&
    [ref.url, ...(ref.sourceUrls ?? [])].some(
      (url) => url !== undefined && new URL(url).href === new URL(source).href,
    )
  );
}

function inlineImage(source: string): ImportArticleAssetRequest {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source);
  if (
    !match?.[1] ||
    !match[2] ||
    !(HC_IMAGE_MIME_TYPES as readonly string[]).includes(match[1].toLowerCase())
  )
    throw new ImportLoadError('mapping-invalid');
  const mime = match[1].toLowerCase(),
    base64 = match[2];
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) throw new ImportLoadError('mapping-invalid');
  const externalId = `inline:${hashImportValue(source)}`;
  return {
    key: hashImportValue({ usage: 'image', externalId }),
    usage: 'image',
    identity: { externalId, fileName: 'image', contentType: mime, size: bytes.length },
    sources: [source],
    input: { kind: 'inline', mime, base64 },
  };
}

/** Uses decoded attributes; each copy names only the files actually belonging to that copy. */
export function articleCopyAssetRequests(
  article: Pick<Article, 'bodyHtml' | 'attachments' | 'assetOrigin'>,
  brandId: string,
  source: ImportSource,
): ImportArticleAssetRequest[] {
  const requests = new Map<string, ImportArticleAssetRequest>();
  const sourceOwners = new Map<string, string>();
  for (const ref of article.attachments ?? []) {
    const sources = [...new Set([ref.url ?? ref.bundlePath ?? '', ...(ref.sourceUrls ?? [])])];
    for (const locator of sources) {
      const canonical = ref.url ? new URL(locator).href : locator;
      const owner = sourceOwners.get(canonical);
      if (owner !== undefined && owner !== ref.externalId)
        throw new ImportLoadError('mapping-invalid');
      sourceOwners.set(canonical, ref.externalId);
    }
    const request = reference('download', ref, sources);
    requests.set(request.key, request);
  }
  for (const locator of new Set(articleImageSources(article.bodyHtml))) {
    if (
      HC_MEDIA_PATH_PATTERN.test(locator) &&
      locator.startsWith(`/api/help-center/brands/${brandId}/`)
    )
      continue;
    let request: ImportArticleAssetRequest;
    const resolved =
      URL.canParse(locator) || !article.assetOrigin
        ? locator
        : URL.parse(locator, article.assetOrigin)?.href;
    if (resolved === undefined) throw new ImportLoadError('mapping-invalid');
    const declared = article.attachments?.find(
      (ref) => sameLocator(ref, locator) || sameLocator(ref, resolved),
    );
    if (declared) request = reference('image', declared, [locator]);
    else if (locator.toLowerCase().startsWith('data:')) request = inlineImage(locator);
    else {
      const path = source === 'file' ? importBundlePathSchema.safeParse(locator) : null;
      const externalId = `inline:${hashImportValue(path?.success ? locator : resolved)}`;
      const parsed = importAttachmentRefSchema.safeParse({
        externalId,
        fileName: 'image',
        ...(path?.success ? { bundlePath: path.data } : { url: resolved }),
      });
      if (!parsed.success) throw new ImportLoadError('mapping-invalid');
      request = reference('image', parsed.data, [locator]);
    }
    const known = requests.get(request.key);
    if (known)
      known.sources.push(...request.sources.filter((value) => !known.sources.includes(value)));
    else requests.set(request.key, request);
    if (requests.size > 1000) throw new ImportLoadError('mapping-invalid');
  }
  return [...requests.values()];
}

export function importArticleAssetRequests(
  raw: Article,
  brandId: string,
  source: ImportSource,
): ImportArticleAssetRequest[] {
  const article = importArticleSchema.parse(raw);
  const requests = new Map<string, ImportArticleAssetRequest>();
  for (const copy of [article, ...(article.published ? [article.published] : [])]) {
    for (const request of articleCopyAssetRequests(copy, brandId, source)) {
      const existing = requests.get(request.key);
      if (existing) {
        if (
          importArticleAssetMetadataHash(existing) !== importArticleAssetMetadataHash(request) ||
          !sameInput(existing.input, request.input)
        )
          throw new ImportLoadError('mapping-invalid');
        existing.sources.push(...request.sources.filter((src) => !existing.sources.includes(src)));
      } else requests.set(request.key, request);
      if (requests.size > 1000) throw new ImportLoadError('mapping-invalid');
    }
  }
  return [...requests.values()];
}

function sameInput(
  left: ImportArticleAssetRequest['input'],
  right: ImportArticleAssetRequest['input'],
): boolean {
  if (left.kind === 'inline' || right.kind === 'inline')
    return hashImportValue(left) === hashImportValue(right);
  const { sourceUrls: _leftUrls, ...leftRef } = left.ref;
  const { sourceUrls: _rightUrls, ...rightRef } = right.ref;
  return hashImportValue(leftRef) === hashImportValue(rightRef);
}
