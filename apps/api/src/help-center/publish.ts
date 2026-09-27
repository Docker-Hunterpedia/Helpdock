import { htmlToText } from '@helpdock/channels';
import type { DbTransaction, HcArticleVersion } from '@helpdock/db';
import { type HcActor, writeHcAudit } from './audit.js';
import { enqueueArticleChanged } from './events.js';
import type { HelpCenterRepository } from './help-center.repository.js';

/**
 * Publishing one version: the working copy becomes what visitors read, in one
 * statement, with its audit row and its `help_center.article_changed` event
 * in the same transaction. Shared by "Publish changes" and by the scheduled
 * publish, so the two cannot drift.
 *
 * The body was sanitised when it was saved (`sanitizeArticleHtml`), and the
 * text is extracted from that sanitised html, so a published body never skips
 * the allowlist.
 */
export const publishVersion = async (
  tx: DbTransaction,
  repository: HelpCenterRepository,
  {
    version,
    actor,
    now,
  }: {
    readonly version: HcArticleVersion;
    readonly actor: HcActor;
    readonly now: Date;
  },
): Promise<HcArticleVersion> => {
  const published = await repository.updateVersion(tx, version.id, {
    status: 'published',
    scheduledAt: null,
    publishedTitle: version.title,
    publishedDescription: version.description,
    publishedBodyHtml: version.bodyHtml,
    publishedBodyText: htmlToText(version.bodyHtml),
    publishedAt: now,
    publishedBy: actor.type === 'staff' ? actor.id : null,
    changedAt: now,
  });

  await writeHcAudit(tx, {
    brandId: version.brandId,
    actor,
    action: 'hc_article.published',
    targetType: 'hc_article',
    targetId: version.articleId,
    meta: { locale: version.locale, title: version.title },
  });
  await enqueueArticleChanged(tx, version.brandId, {
    articleId: version.articleId,
    locale: version.locale,
    change: 'published',
  });

  return published;
};

/**
 * `help_center.publish_due` for one brand: every version whose time has come.
 * A version that was rescheduled or unpublished since the job was added is no
 * longer due, so the job publishes only what is due *now*.
 */
export const publishDue = async (
  tx: DbTransaction,
  repository: HelpCenterRepository,
  { actor, now }: { readonly actor: HcActor; readonly now: Date },
): Promise<number> => {
  const due = await repository.dueVersions(tx, now);
  for (const version of due) {
    await publishVersion(tx, repository, { version, actor, now });
  }
  return due.length;
};
