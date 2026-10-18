import { articleLinkTargets, sanitizeImportedArticleHtml } from '@helpdock/channels';
import { createI18n } from '@helpdock/i18n';
import { HC_BODY_MAX, hcImportAssetPath, hcMediaPath } from '@helpdock/schemas';
import type { ArticleAssetProof } from '../article-asset-proof.js';
import { articleCopyAssetRequests } from '../article-asset-requests.js';
import type { PreparedImportArticle } from '../article-prepared.js';
import { ImportLoadError } from '../loader/contracts.js';
import type { ArticlePreparationSnapshot } from './article-asset-checkpoint.js';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** Ready resources replace decoded source locators; unavailable files stay explicit in the article. */
function renderArticleCopy(
  snapshot: ArticlePreparationSnapshot,
  assets: ReadonlyMap<string, ArticleAssetProof>,
  copy: Pick<ArticlePreparationSnapshot['record'], 'bodyHtml' | 'attachments' | 'assetOrigin'>,
): string {
  const images = new Map<string, string>(),
    links = new Map<string, string>();
  const outcomes = new Map(snapshot.preparation.outcomes.map((outcome) => [outcome.key, outcome]));
  const downloads: { href: string; name: string }[] = [];
  const unavailable: string[] = [];
  const unavailableLinks = new Set<string>();
  for (const request of articleCopyAssetRequests(
    copy,
    snapshot.input.claim.brandId,
    snapshot.source,
  )) {
    const outcome = outcomes.get(request.key);
    if (!outcome || outcome.state === 'processing') throw new ImportLoadError('target-unavailable');
    if (outcome.state === 'unavailable') {
      unavailable.push(request.identity.fileName);
      for (const source of request.sources) unavailableLinks.add(source);
      continue;
    }
    const proof = assets.get(request.key);
    if (!proof || proof.asset.id !== outcome.assetId) throw new ImportLoadError('mapping-invalid');
    const target =
      request.usage === 'image'
        ? hcMediaPath(snapshot.input.claim.brandId, proof.media.id)
        : hcImportAssetPath(snapshot.input.claim.brandId, proof.asset.id);
    for (const source of request.sources)
      (request.usage === 'image' ? images : links).set(source, target);
    if (request.usage === 'download')
      downloads.push({ href: target, name: request.identity.fileName });
  }
  let html = sanitizeImportedArticleHtml(copy.bodyHtml, {
    brandId: snapshot.input.claim.brandId,
    images,
    links,
    unavailableLinks,
  }).html;
  const linked = new Set(articleLinkTargets(html));
  for (const file of downloads)
    if (!linked.has(file.href))
      html += `<p><a href="${file.href}">${escapeHtml(file.name)}</a></p>`;
  const label = createI18n({ lng: snapshot.record.locale }).t('imports:articleAssetUnavailable');
  for (const name of new Set(unavailable)) html += `<p>${label}: ${escapeHtml(name)}</p>`;
  if (html.length > HC_BODY_MAX) throw new ImportLoadError('mapping-invalid');
  return html;
}

export function renderPreparedArticle(
  snapshot: ArticlePreparationSnapshot,
  assets: ReadonlyMap<string, ArticleAssetProof>,
): PreparedImportArticle {
  return {
    bodyHtml: renderArticleCopy(snapshot, assets, snapshot.record),
    ...(snapshot.record.published
      ? { publishedBodyHtml: renderArticleCopy(snapshot, assets, snapshot.record.published) }
      : {}),
  };
}
