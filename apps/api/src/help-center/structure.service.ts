import type { DbTransaction } from '@helpdock/db';
import {
  HC_MAX_CATEGORIES,
  HC_MAX_SECTIONS,
  type HcCategory,
  type HcCategoryCreateRequest,
  type HcCategoryUpdateRequest,
  type HcReorderRequest,
  type HcSection,
  type HcSectionCreateRequest,
  type HcSectionUpdateRequest,
  type HcStructure,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { writeHcAudit } from './audit.js';
import { enqueueArticleChanged, enqueueStructureChanged } from './events.js';
import type { HelpCenterRepository } from './help-center.repository.js';
import { HelpCenterFailure } from './help-center-failure.js';
import { resolveSlug } from './slugs.js';
import { toArticleSummary, toCategory, toSection } from './views.js';

/**
 * The Articles tab's tree (M5-01): categories and sections, their order, and
 * the order of the articles in each section.
 *
 * Deleting refuses a parent that still has children (`not-empty`) rather than
 * cascading: a category removed with forty articles in it is not a mistake
 * anybody should be one click from.
 */

export interface HelpCenterContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

export type ReorderKind = 'categories' | 'sections' | 'articles';

export class HelpCenterStructureService {
  readonly #repository: HelpCenterRepository;
  readonly #now: () => Date;

  constructor(repository: HelpCenterRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async structure({ tx, brandId }: HelpCenterContext): Promise<HcStructure> {
    const facts = await this.#repository.brandFacts(tx, brandId);
    const categories = await this.#repository.categories(tx);
    const sections = await this.#repository.sections(tx);
    const articles = await this.#repository.articles(tx);
    const versions = await this.#repository.versions(tx);

    return {
      defaultLocale: facts.defaultLocale,
      timezone: facts.timezone,
      categories: categories.map(toCategory),
      sections: sections.map(toSection),
      articles: articles.map((article) =>
        toArticleSummary(
          article,
          versions.filter((version) => version.articleId === article.id),
        ),
      ),
    };
  }

  async createCategory(
    context: HelpCenterContext,
    request: HcCategoryCreateRequest,
  ): Promise<HcCategory> {
    const { tx, brandId } = context;
    if ((await this.#repository.count(tx, 'categories')) >= HC_MAX_CATEGORIES) {
      throw new HelpCenterFailure('limit-reached');
    }
    const slug = await resolveSlug(tx, this.#repository, 'categories', {
      chosen: request.slug,
      from: request.names.en || request.names.ar,
      fallback: 'category',
    });
    const row = await this.#repository.insertCategory(tx, {
      brandId,
      slug,
      names: request.names,
      descriptions: request.descriptions ?? { en: '', ar: '' },
      position: await this.#repository.nextPosition(tx, 'categories', null),
    });

    await this.#changed(context, 'hc_category.created', 'category', row.id, {
      slug,
      names: row.names,
    });
    return toCategory(row);
  }

  async updateCategory(
    context: HelpCenterContext,
    id: string,
    request: HcCategoryUpdateRequest,
  ): Promise<HcCategory> {
    const { tx } = context;
    await this.#requireCategory(tx, id);
    const slug =
      request.slug === undefined
        ? undefined
        : await resolveSlug(tx, this.#repository, 'categories', {
            chosen: request.slug,
            from: '',
            fallback: 'category',
            exceptId: id,
          });
    const row = await this.#repository.updateCategory(tx, id, {
      ...(request.names === undefined ? {} : { names: request.names }),
      ...(request.descriptions === undefined ? {} : { descriptions: request.descriptions }),
      ...(slug === undefined ? {} : { slug }),
    });

    await this.#changed(context, 'hc_category.updated', 'category', id, { ...request });
    return toCategory(row);
  }

  async deleteCategory(context: HelpCenterContext, id: string): Promise<void> {
    const { tx } = context;
    const row = await this.#requireCategory(tx, id);
    if (await this.#repository.hasSections(tx, id)) {
      throw new HelpCenterFailure('not-empty');
    }
    await this.#repository.deleteCategory(tx, id);
    await this.#changed(context, 'hc_category.deleted', 'category', id, { slug: row.slug });
  }

  async createSection(
    context: HelpCenterContext,
    request: HcSectionCreateRequest,
  ): Promise<HcSection> {
    const { tx, brandId } = context;
    await this.#requireCategory(tx, request.categoryId);
    if ((await this.#repository.count(tx, 'sections')) >= HC_MAX_SECTIONS) {
      throw new HelpCenterFailure('limit-reached');
    }
    const slug = await resolveSlug(tx, this.#repository, 'sections', {
      chosen: request.slug,
      from: request.names.en || request.names.ar,
      fallback: 'section',
    });
    const row = await this.#repository.insertSection(tx, {
      brandId,
      categoryId: request.categoryId,
      slug,
      names: request.names,
      position: await this.#repository.nextPosition(tx, 'sections', request.categoryId),
    });

    await this.#changed(context, 'hc_section.created', 'section', row.id, {
      slug,
      names: row.names,
    });
    return toSection(row);
  }

  async updateSection(
    context: HelpCenterContext,
    id: string,
    request: HcSectionUpdateRequest,
  ): Promise<HcSection> {
    const { tx } = context;
    await this.#requireSection(tx, id);
    const slug =
      request.slug === undefined
        ? undefined
        : await resolveSlug(tx, this.#repository, 'sections', {
            chosen: request.slug,
            from: '',
            fallback: 'section',
            exceptId: id,
          });
    const row = await this.#repository.updateSection(tx, id, {
      ...(request.names === undefined ? {} : { names: request.names }),
      ...(slug === undefined ? {} : { slug }),
    });

    await this.#changed(context, 'hc_section.updated', 'section', id, { ...request });
    return toSection(row);
  }

  async deleteSection(context: HelpCenterContext, id: string): Promise<void> {
    const { tx } = context;
    const row = await this.#requireSection(tx, id);
    if (await this.#repository.hasArticles(tx, id)) {
      throw new HelpCenterFailure('not-empty');
    }
    await this.#repository.deleteSection(tx, id);
    await this.#changed(context, 'hc_section.deleted', 'section', id, { slug: row.slug });
  }

  /**
   * A new order for one parent's children. Every id must be this brand's and
   * of the right kind; one that sits under another parent moves here, which is
   * how a drag across the tree lands. Articles that moved section tell the
   * published help center, since their breadcrumbs changed.
   */
  async reorder(
    context: HelpCenterContext,
    kind: ReorderKind,
    request: HcReorderRequest,
  ): Promise<HcStructure> {
    const { tx, brandId } = context;
    const ids = [...new Set(request.ids)];
    if (ids.length !== request.ids.length) {
      throw new BadRequestException('An id appears twice');
    }
    if ((kind === 'categories') !== (request.parentId === null)) {
      throw new BadRequestException(
        kind === 'categories' ? 'Categories have no parent' : 'Name the parent to order within',
      );
    }
    if (request.parentId !== null) {
      const parent =
        kind === 'sections'
          ? await this.#repository.category(tx, request.parentId)
          : await this.#repository.section(tx, request.parentId);
      if (parent === undefined) {
        throw new NotFoundException('No such parent in this help center');
      }
    }

    const found = await this.#repository.existing(tx, kind, ids);
    if (found.length !== ids.length) {
      throw new NotFoundException('An id names nothing in this help center');
    }

    await this.#repository.reorder(tx, kind, request.parentId, ids);

    const now = this.#now();
    const moved = found.filter((row) => row.parentId !== null && row.parentId !== request.parentId);
    if (kind === 'articles') {
      for (const { id } of moved) {
        await this.#repository.touchVersions(tx, id, now);
        await writeHcAudit(tx, {
          brandId,
          actor: { type: 'staff', id: context.actorId },
          action: 'hc_article.moved',
          targetType: 'hc_article',
          targetId: id,
          meta: { sectionId: request.parentId },
        });
        await enqueueArticleChanged(tx, brandId, { articleId: id, locale: null, change: 'moved' });
      }
    }
    await writeHcAudit(tx, {
      brandId,
      actor: { type: 'staff', id: context.actorId },
      action: 'hc_structure.reordered',
      targetType: kind === 'categories' ? 'hc_category' : 'hc_section',
      targetId: request.parentId ?? brandId,
      meta: { kind, ids },
    });
    if (kind !== 'articles') {
      await enqueueStructureChanged(tx, brandId, {
        kind: kind === 'categories' ? 'category' : 'section',
        id: request.parentId ?? brandId,
      });
    }

    return this.structure(context);
  }

  async #requireCategory(tx: DbTransaction, id: string) {
    const row = await this.#repository.category(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such category');
    }
    return row;
  }

  async #requireSection(tx: DbTransaction, id: string) {
    const row = await this.#repository.section(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such section');
    }
    return row;
  }

  async #changed(
    { tx, brandId, actorId }: HelpCenterContext,
    action:
      | 'hc_category.created'
      | 'hc_category.updated'
      | 'hc_category.deleted'
      | 'hc_section.created'
      | 'hc_section.updated'
      | 'hc_section.deleted',
    kind: 'category' | 'section',
    id: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await writeHcAudit(tx, {
      brandId,
      actor: { type: 'staff', id: actorId },
      action,
      targetType: kind === 'category' ? 'hc_category' : 'hc_section',
      targetId: id,
      meta,
    });
    await enqueueStructureChanged(tx, brandId, { kind, id });
  }
}
