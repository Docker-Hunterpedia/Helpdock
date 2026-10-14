import { type DbTransaction, hcArticles, hcCategories, hcSections } from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { ImportLoadError } from './contracts.js';
import { type ImportScope, importedIdentity } from './external-ids.js';

export async function lockImportedKnowledge(
  tx: DbTransaction,
  scope: ImportScope,
  kind: 'categories' | 'sections' | 'articles',
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.brandId}:hc:${kind}`}, 27))`,
  );
}

export async function importedCategoryTarget(
  tx: DbTransaction,
  scope: ImportScope,
  externalId: string,
) {
  const pointer = await importedIdentity(tx, scope, 'category', externalId);
  if (!pointer) throw new ImportLoadError('mapping-invalid');
  const [category] = await tx
    .select()
    .from(hcCategories)
    .where(and(eq(hcCategories.id, pointer.helpdockId), eq(hcCategories.brandId, scope.brandId)));
  if (!category) throw new ImportLoadError('target-unavailable');
  return { ...category, sourceHash: pointer.payloadHash };
}
export async function importedSectionTarget(
  tx: DbTransaction,
  scope: ImportScope,
  externalId: string,
) {
  const pointer = await importedIdentity(tx, scope, 'section', externalId);
  if (!pointer) throw new ImportLoadError('mapping-invalid');
  const [section] = await tx
    .select()
    .from(hcSections)
    .where(and(eq(hcSections.id, pointer.helpdockId), eq(hcSections.brandId, scope.brandId)));
  if (!section) throw new ImportLoadError('target-unavailable');
  return { ...section, sourceHash: pointer.payloadHash };
}
export async function importedArticleTarget(
  tx: DbTransaction,
  scope: ImportScope,
  externalId: string,
) {
  const pointer = await importedIdentity(tx, scope, 'article', externalId);
  if (!pointer) throw new ImportLoadError('mapping-invalid');
  const [article] = await tx
    .select()
    .from(hcArticles)
    .where(and(eq(hcArticles.id, pointer.helpdockId), eq(hcArticles.brandId, scope.brandId)));
  if (!article) throw new ImportLoadError('target-unavailable');
  return article;
}
