import { SanitizeLimitError, sanitizeArticleHtml } from '@helpdock/channels';
import type { DbTransaction, HcArticleVersion } from '@helpdock/db';
import {
  HC_MAX_ARTICLES,
  type HcArticle,
  type HcArticleCreateRequest,
  type HcArticleUpdateRequest,
  type HcLocale,
  type HcVersionSaveRequest,
  type HcVersionStatusRequest,
  type HcVisibility,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { editedRecently, type HcActor, readActivity, writeHcAudit } from './audit.js';
import { enqueueArticleChanged } from './events.js';
import type { HelpCenterRepository } from './help-center.repository.js';
import { HelpCenterFailure } from './help-center-failure.js';
import { publishVersion } from './publish.js';
import { resolveSlug } from './slugs.js';
import type { HelpCenterContext } from './structure.service.js';
import { toVersion } from './views.js';

/**
 * One article in the editor (M5-01, M5-02, M5-09): its versions, the working
 * copy the editor autosaves, and the three live switches — status, visibility,
 * and the slug and section every language is read under.
 *
 * Every switch a reader of the published help center could notice writes a
 * `help_center.article_changed` event and moves the version's `changed_at` in
 * the same transaction (DOMAIN-RULES §5, §6). Saving the working copy of a
 * published article changes nothing a visitor reads, so it writes neither.
 */
export class HelpCenterArticlesService {
  readonly #repository: HelpCenterRepository;
  readonly #now: () => Date;

  constructor(repository: HelpCenterRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async get({ tx }: HelpCenterContext, id: string): Promise<HcArticle> {
    const article = await this.#requireArticle(tx, id);
    const versions = await this.#repository.versions(tx, id);

    return {
      id: article.id,
      sectionId: article.sectionId,
      slug: article.slug,
      versions: versions.map(toVersion),
      activity: await readActivity(tx, id),
    };
  }

  async create(context: HelpCenterContext, request: HcArticleCreateRequest): Promise<HcArticle> {
    const { tx, brandId, actorId } = context;
    if ((await this.#repository.section(tx, request.sectionId)) === undefined) {
      throw new NotFoundException('No such section');
    }
    if ((await this.#repository.count(tx, 'articles')) >= HC_MAX_ARTICLES) {
      throw new HelpCenterFailure('limit-reached');
    }
    const slug = await resolveSlug(tx, this.#repository, 'articles', {
      chosen: request.slug,
      from: request.title,
      fallback: 'article',
    });
    const article = await this.#repository.insertArticle(tx, {
      brandId,
      sectionId: request.sectionId,
      slug,
      position: await this.#repository.nextPosition(tx, 'articles', request.sectionId),
      createdBy: actorId,
    });
    await this.#repository.insertVersion(tx, {
      brandId,
      articleId: article.id,
      locale: request.locale,
      title: request.title,
      updatedBy: actorId,
    });
    await this.#audit(context, 'hc_article.created', article.id, {
      locale: request.locale,
      title: request.title,
      slug,
    });

    return this.get(context, article.id);
  }

  /** The slug, or the section, of every language at once. */
  async update(
    context: HelpCenterContext,
    id: string,
    request: HcArticleUpdateRequest,
  ): Promise<HcArticle> {
    const { tx, brandId } = context;
    const article = await this.#requireArticle(tx, id);
    const now = this.#now();

    if (request.sectionId !== undefined && request.sectionId !== article.sectionId) {
      if ((await this.#repository.section(tx, request.sectionId)) === undefined) {
        throw new NotFoundException('No such section');
      }
      await this.#repository.updateArticle(tx, id, {
        sectionId: request.sectionId,
        position: await this.#repository.nextPosition(tx, 'articles', request.sectionId),
      });
      await this.#audit(context, 'hc_article.moved', id, { sectionId: request.sectionId });
      await enqueueArticleChanged(tx, brandId, { articleId: id, locale: null, change: 'moved' });
      await this.#repository.touchVersions(tx, id, now);
    }

    if (request.slug !== undefined && request.slug !== article.slug) {
      const slug = await resolveSlug(tx, this.#repository, 'articles', {
        chosen: request.slug,
        from: '',
        fallback: 'article',
        exceptId: id,
      });
      await this.#repository.updateArticle(tx, id, { slug });
      await this.#audit(context, 'hc_article.slug_changed', id, { slug, previous: article.slug });
      await enqueueArticleChanged(tx, brandId, { articleId: id, locale: null, change: 'slug' });
      await this.#repository.touchVersions(tx, id, now);
    }

    return this.get(context, id);
  }

  /**
   * Deletes an article that was never published. One that was is archived
   * instead (`was-published`): search, a cache or a knowledge chunk may still
   * name it, and an archived article answers 410 where a deleted one would
   * leave them pointing at nothing.
   */
  async remove(context: HelpCenterContext, id: string): Promise<void> {
    const { tx } = context;
    const article = await this.#requireArticle(tx, id);
    if (await this.#repository.everPublished(tx, id)) {
      throw new HelpCenterFailure('was-published');
    }
    await this.#repository.deleteArticle(tx, id);
    await this.#audit(context, 'hc_article.deleted', id, { slug: article.slug });
  }

  /**
   * The editor's autosave of one language's working copy, which creates the
   * version the first time a language is written. The html is sanitised here,
   * whatever wrote it — the editor, a Markdown import, an API caller.
   */
  async save(
    context: HelpCenterContext,
    id: string,
    locale: HcLocale,
    request: HcVersionSaveRequest,
  ): Promise<HcArticle> {
    const { tx, brandId, actorId } = context;
    await this.#requireArticle(tx, id);
    const bodyHtml = this.#sanitize(request.bodyHtml, brandId);
    const existing = await this.#repository.version(tx, id, locale);

    if (existing === undefined) {
      await this.#repository.insertVersion(tx, {
        brandId,
        articleId: id,
        locale,
        title: request.title,
        description: request.description,
        bodyHtml,
        updatedBy: actorId,
      });
      await this.#audit(context, 'hc_article.created', id, { locale, title: request.title });
    } else {
      await this.#repository.updateVersion(tx, existing.id, {
        title: request.title,
        description: request.description,
        bodyHtml,
        updatedBy: actorId,
      });
      const now = this.#now();
      if (!(await editedRecently(tx, { articleId: id, locale, actorId, now }))) {
        await this.#audit(context, 'hc_article.edited', id, { locale });
      }
    }

    return this.get(context, id);
  }

  async setStatus(
    context: HelpCenterContext,
    id: string,
    locale: HcLocale,
    request: HcVersionStatusRequest,
  ): Promise<HcArticle> {
    const { tx, brandId } = context;
    const version = await this.#requireVersion(tx, id, locale);
    const now = this.#now();

    switch (request.status) {
      case 'published':
        await publishVersion(tx, this.#repository, {
          version,
          actor: this.#actor(context),
          now,
        });
        break;
      case 'scheduled': {
        const at = new Date(request.scheduledAt ?? Number.NaN);
        if (!(at.getTime() > now.getTime())) {
          throw new HelpCenterFailure('schedule-in-past');
        }
        await this.#repository.updateVersion(tx, version.id, {
          status: 'scheduled',
          scheduledAt: at,
          changedAt: now,
        });
        await this.#audit(context, 'hc_article.scheduled', id, {
          locale,
          scheduledAt: at.toISOString(),
        });
        await enqueueArticleChanged(tx, brandId, {
          articleId: id,
          locale,
          change: 'scheduled',
          scheduledAt: at.toISOString(),
        });
        break;
      }
      case 'draft':
      case 'archived':
        await this.#takeDown(context, version, request.status, now);
        break;
    }

    return this.get(context, id);
  }

  async setVisibility(
    context: HelpCenterContext,
    id: string,
    locale: HcLocale,
    visibility: HcVisibility,
  ): Promise<HcArticle> {
    const { tx, brandId } = context;
    const version = await this.#requireVersion(tx, id, locale);
    if (version.visibility !== visibility) {
      await this.#repository.updateVersion(tx, version.id, { visibility, changedAt: this.#now() });
      await this.#audit(context, 'hc_article.visibility_changed', id, { locale, visibility });
      await enqueueArticleChanged(tx, brandId, { articleId: id, locale, change: 'visibility' });
    }

    return this.get(context, id);
  }

  async #takeDown(
    context: HelpCenterContext,
    version: HcArticleVersion,
    status: 'draft' | 'archived',
    now: Date,
  ): Promise<void> {
    if (version.status === status) {
      return;
    }
    await this.#repository.updateVersion(context.tx, version.id, {
      status,
      scheduledAt: null,
      changedAt: now,
    });
    const change = status === 'draft' ? 'unpublished' : 'archived';
    await this.#audit(context, `hc_article.${change}`, version.articleId, {
      locale: version.locale,
    });
    await enqueueArticleChanged(context.tx, context.brandId, {
      articleId: version.articleId,
      locale: version.locale,
      change,
    });
  }

  #sanitize(html: string, brandId: string): string {
    try {
      return sanitizeArticleHtml(html, { brandId }).html;
    } catch (error) {
      if (error instanceof SanitizeLimitError) {
        throw new BadRequestException(error.message);
      }
      /* c8 ignore next 2 -- the sanitiser throws nothing else. */
      throw error;
    }
  }

  #actor({ actorId }: HelpCenterContext): HcActor {
    return { type: 'staff', id: actorId };
  }

  async #requireArticle(tx: DbTransaction, id: string) {
    const row = await this.#repository.article(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such article');
    }
    return row;
  }

  async #requireVersion(tx: DbTransaction, id: string, locale: HcLocale) {
    await this.#requireArticle(tx, id);
    const version = await this.#repository.version(tx, id, locale);
    if (version === undefined) {
      throw new NotFoundException('This article has no version in that language yet');
    }
    return version;
  }

  async #audit(
    context: HelpCenterContext,
    action: Parameters<typeof writeHcAudit>[1]['action'],
    articleId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await writeHcAudit(context.tx, {
      brandId: context.brandId,
      actor: this.#actor(context),
      action,
      targetType: 'hc_article',
      targetId: articleId,
      meta,
    });
  }
}
