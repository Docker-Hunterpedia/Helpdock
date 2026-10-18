import {
  type DbTransaction,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcSections,
  importRecords,
} from '@helpdock/db';
import {
  HC_MAX_ARTICLES,
  HC_MAX_CATEGORIES,
  HC_MAX_SECTIONS,
  type ImportRecord,
} from '@helpdock/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { importedArticleSiblingTarget } from '../loader/article-group-target.js';
import { ImportLoadError } from '../loader/contracts.js';
import { type ImportScope, importedIdentity } from '../loader/external-ids.js';
import {
  type ImportHierarchyNode,
  importHierarchyCycle,
  importHierarchyNode,
} from './hierarchy.js';
import type { ReferenceIssue } from './record-references.js';
import { validatedStagedRecord } from './staged-record.js';

type KnowledgeEntity = 'category' | 'section' | 'article';
type KnowledgeRecord = Extract<ImportRecord, { entity: KnowledgeEntity }>;
type KnowledgeNode = ImportHierarchyNode & {
  containerKey: string | null;
  destinationId: string | null;
  locale: 'en' | 'ar' | null;
  ownsDestination: boolean;
};
type Issue = Exclude<ReferenceIssue['code'], 'reference-self'>;

async function stagedKnowledge(
  tx: DbTransaction,
  scope: ImportScope,
  entity: KnowledgeEntity,
  externalId: string,
) {
  const [row] = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.brandId, scope.brandId),
        eq(importRecords.runId, scope.runId),
        eq(importRecords.entity, entity),
        eq(importRecords.externalId, externalId),
      ),
    );
  if (!row) return null;
  const native = validatedStagedRecord(row);
  if (native.entity !== 'category' && native.entity !== 'section' && native.entity !== 'article')
    throw new ImportLoadError('mapping-invalid');
  return native;
}

async function knowledgeDestination(
  tx: DbTransaction,
  scope: ImportScope,
  entity: KnowledgeEntity,
  externalId: string,
) {
  const pointer = await importedIdentity(tx, scope, entity, externalId);
  const targetId =
    pointer?.helpdockId ??
    (entity === 'article' ? await importedArticleSiblingTarget(tx, scope, externalId) : undefined);
  if (!targetId) return null;
  const table =
    entity === 'category' ? hcCategories : entity === 'section' ? hcSections : hcArticles;
  const [target] = await tx
    .select({
      id: table.id,
      parentExternalId:
        entity === 'category'
          ? hcCategories.importedParentExternalId
          : entity === 'section'
            ? hcSections.importedParentSectionExternalId
            : sql<string | null>`NULL`,
      containerId:
        entity === 'section'
          ? hcSections.categoryId
          : entity === 'article'
            ? hcArticles.sectionId
            : sql<string | null>`NULL`,
    })
    .from(table)
    .where(and(eq(table.brandId, scope.brandId), eq(table.id, targetId)));
  if (!target) throw new ImportLoadError('target-unavailable');
  return { ...target, owned: pointer !== undefined };
}

async function containerBinding(
  tx: DbTransaction,
  scope: ImportScope,
  entity: 'category' | 'section',
  externalId: string,
) {
  const staged = await stagedKnowledge(tx, scope, entity, externalId);
  const target = await knowledgeDestination(tx, scope, entity, externalId);
  if (target) return `existing:${target.id}`;
  if (staged) return `new:${externalId}`;
  throw new ImportLoadError('target-unavailable');
}

async function stagedNode(
  tx: DbTransaction,
  scope: ImportScope,
  record: KnowledgeRecord,
): Promise<KnowledgeNode> {
  const target = await knowledgeDestination(tx, scope, record.entity, record.payload.externalId);
  const containerKey =
    record.entity === 'section'
      ? await containerBinding(tx, scope, 'category', record.payload.parentExternalId)
      : record.entity === 'article'
        ? await containerBinding(tx, scope, 'section', record.payload.sectionExternalId)
        : null;
  return {
    ...importHierarchyNode(record),
    containerKey,
    destinationId: target?.id ?? null,
    ownsDestination: target?.owned ?? false,
    locale: record.entity === 'article' ? record.payload.locale : null,
    key:
      record.entity === 'article'
        ? record.payload.externalId
        : target
          ? `existing:${target.id}`
          : `new:${record.payload.externalId}`,
  };
}

async function knowledgeNode(
  tx: DbTransaction,
  scope: ImportScope,
  entity: KnowledgeEntity,
  externalId: string,
): Promise<KnowledgeNode | null> {
  const staged = await stagedKnowledge(tx, scope, entity, externalId);
  if (staged) return stagedNode(tx, scope, staged);
  const target = await knowledgeDestination(tx, scope, entity, externalId);
  if (!target) return null;
  return {
    externalId,
    parentExternalId: target.parentExternalId,
    containerKey: target.containerId ? `existing:${target.containerId}` : null,
    destinationId: target.id,
    ownsDestination: target.owned,
    locale: null,
    key: entity === 'article' ? externalId : `existing:${target.id}`,
  };
}

type ValidationContext = {
  tx: DbTransaction;
  scope: ImportScope;
  record: KnowledgeRecord;
  root: KnowledgeNode;
};

class KnowledgeHierarchyValidation {
  private issue: Issue | null = null;
  private articleId: string | null;
  private duplicateLocale = false;
  private visited = 1;
  private readonly limit: number;

  constructor(private readonly context: ValidationContext) {
    this.articleId = context.root.destinationId;
    this.limit = {
      category: HC_MAX_CATEGORIES,
      section: HC_MAX_SECTIONS,
      article: HC_MAX_ARTICLES,
    }[context.record.entity];
  }

  async validate(): Promise<Issue | null> {
    const cycle = await importHierarchyCycle(this.context.root, (externalId) =>
      this.ancestor(externalId),
    );
    if (this.issue) return this.issue;
    if (cycle) return 'reference-cycle';
    if (this.duplicateLocale) return 'reference-invalid';
    return this.occupiedLocaleIssue();
  }

  private async ancestor(externalId: string): Promise<KnowledgeNode | null> {
    if (++this.visited > this.limit) {
      this.issue = 'reference-invalid';
      return null;
    }
    const { tx, scope, record, root } = this.context;
    const node = await knowledgeNode(tx, scope, record.entity, externalId);
    if (!node) {
      this.issue = 'reference-missing';
      return null;
    }
    if (root.containerKey !== node.containerKey) {
      this.issue = 'reference-parent-mismatch';
      return null;
    }
    if (record.entity === 'article' && node.locale === record.payload.locale)
      this.duplicateLocale = true;
    if (record.entity === 'article' && node.destinationId) {
      if (this.articleId && this.articleId !== node.destinationId) {
        this.issue = 'reference-invalid';
        return null;
      }
      this.articleId = node.destinationId;
    }
    return node;
  }

  private async occupiedLocaleIssue(): Promise<Issue | null> {
    const { tx, scope, record, root } = this.context;
    if (record.entity !== 'article' || root.ownsDestination || !this.articleId) return null;
    const [occupied] = await tx
      .select({ id: hcArticleVersions.id })
      .from(hcArticleVersions)
      .where(
        and(
          eq(hcArticleVersions.brandId, scope.brandId),
          eq(hcArticleVersions.articleId, this.articleId),
          eq(hcArticleVersions.locale, record.payload.locale),
        ),
      )
      .limit(1);
    return occupied ? 'reference-invalid' : null;
  }
}

/** Staged edits override live ancestry; baseline lookups never cross brand/vendor/account boundaries. */
export async function validateImportKnowledgeHierarchy(
  tx: DbTransaction,
  scope: ImportScope,
  record: KnowledgeRecord,
): Promise<Issue | null> {
  try {
    const root = await stagedNode(tx, scope, record);
    return await new KnowledgeHierarchyValidation({ tx, scope, record, root }).validate();
  } catch (error) {
    if (!(error instanceof ImportLoadError)) throw error;
    return 'reference-invalid';
  }
}
