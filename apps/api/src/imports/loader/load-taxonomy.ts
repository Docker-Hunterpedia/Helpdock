import { type DbTransaction, importLog, uuidv7 } from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import { HC_MAX_CATEGORIES, HC_MAX_SECTIONS } from '@helpdock/schemas';
import { HelpCenterRepository } from '../../help-center/help-center.repository.js';
import { resolveSlug } from '../../help-center/slugs.js';
import { ImportLoadError } from './contracts.js';
import { importedIdentity, rememberImported } from './external-ids.js';
import {
  type CategoryLoad,
  categoryLoadSchema,
  importedDescriptions,
  importedNames,
  type SectionLoad,
  sectionLoadSchema,
  sourceDescriptions,
} from './knowledge-contracts.js';
import {
  importedCategoryTarget,
  importedSectionTarget,
  lockImportedKnowledge,
} from './knowledge-targets.js';
import { requireLoadingRun } from './run-scope.js';

const repository = new HelpCenterRepository();

async function categoryNames(tx: DbTransaction, input: CategoryLoad) {
  const names = importedNames(input.record.names);
  if (!input.record.parentExternalId) return { names, parentHash: null };
  const visited = new Set([input.record.externalId]);
  let ancestorId: string | null = input.record.parentExternalId;
  const parent = await importedCategoryTarget(tx, input, ancestorId);
  for (let depth = 0; ancestorId; depth++) {
    if (depth >= HC_MAX_CATEGORIES || visited.has(ancestorId))
      throw new ImportLoadError('mapping-invalid');
    visited.add(ancestorId);
    const ancestor = await importedCategoryTarget(tx, input, ancestorId);
    ancestorId = ancestor.importedParentExternalId;
  }
  return {
    parentHash: parent.sourceHash,
    names: importedNames({
      en: names.en
        ? [parent.names.en || parent.names.ar, names.en].filter(Boolean).join(' / ')
        : '',
      ar: names.ar
        ? [parent.names.ar || parent.names.en, names.ar].filter(Boolean).join(' / ')
        : '',
    }),
  };
}

async function createImportedCategory(
  tx: DbTransaction,
  input: CategoryLoad,
  display: {
    names: ReturnType<typeof importedNames>;
    descriptions: ReturnType<typeof importedDescriptions>;
  },
) {
  if ((await repository.count(tx, 'categories')) >= HC_MAX_CATEGORIES)
    throw new ImportLoadError('mapping-invalid');
  const id = uuidv7();
  await repository.insertCategory(tx, {
    id,
    brandId: input.brandId,
    ...display,
    importedDescriptions: sourceDescriptions(input.record.descriptions),
    importedParentExternalId: input.record.parentExternalId ?? null,
    position: await repository.nextPosition(tx, 'categories', null),
    slug: await resolveSlug(tx, repository, 'categories', {
      chosen: undefined,
      from: display.names.en || display.names.ar,
      fallback: `category-${id}`,
    }),
  });
  if (input.record.parentExternalId)
    await tx.insert(importLog).values({
      brandId: input.brandId,
      runId: input.runId,
      entity: 'category',
      externalId: input.record.externalId,
      level: 'warning',
      message: 'import.category.flattened',
    });
  return id;
}

/** Nested source categories retain their breadcrumb in the flat destination category name. */
export async function loadImportedCategory(tx: DbTransaction, request: CategoryLoad) {
  const input = categoryLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  await lockImportedKnowledge(tx, input, 'categories');
  const { names, parentHash } = await categoryNames(tx, input);
  const descriptions = importedDescriptions(input.record.descriptions);
  const payloadHash = hashImportValue({ record: input.record, parentHash });
  const known = await importedIdentity(tx, input, 'category', input.record.externalId);
  let id: string;
  if (known) {
    const existing = await importedCategoryTarget(tx, input, input.record.externalId);
    id = existing.id;
    if (known.payloadHash === payloadHash) return { id, outcome: 'unchanged' as const };
    await repository.updateCategory(tx, id, {
      names,
      descriptions,
      importedDescriptions: sourceDescriptions(input.record.descriptions),
      importedParentExternalId: input.record.parentExternalId ?? null,
    });
  } else id = await createImportedCategory(tx, input, { names, descriptions });
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    entity: 'category',
    externalId: input.record.externalId,
    helpdockId: id,
    payloadHash,
  });
  return { id, outcome: known ? ('updated' as const) : ('created' as const) };
}

async function createImportedSection(
  tx: DbTransaction,
  input: SectionLoad,
  category: Awaited<ReturnType<typeof importedCategoryTarget>>,
  names: ReturnType<typeof importedNames>,
) {
  if ((await repository.count(tx, 'sections')) >= HC_MAX_SECTIONS)
    throw new ImportLoadError('mapping-invalid');
  const id = uuidv7();
  await repository.insertSection(tx, {
    id,
    brandId: input.brandId,
    categoryId: category.id,
    names,
    importedDescriptions: sourceDescriptions(input.record.descriptions),
    position: await repository.nextPosition(tx, 'sections', category.id),
    slug: await resolveSlug(tx, repository, 'sections', {
      chosen: undefined,
      from: `${category.slug}-${names.en || names.ar}`,
      fallback: `section-${id}`,
    }),
  });
  return id;
}

export async function loadImportedSection(tx: DbTransaction, request: SectionLoad) {
  const input = sectionLoadSchema.parse(request);
  await requireLoadingRun(tx, input);
  await lockImportedKnowledge(tx, input, 'sections');
  const category = await importedCategoryTarget(tx, input, input.record.parentExternalId);
  const names = importedNames(input.record.names);
  const payloadHash = hashImportValue({ record: input.record, categoryId: category.id });
  const known = await importedIdentity(tx, input, 'section', input.record.externalId);
  let id: string;
  if (known) {
    const existing = await importedSectionTarget(tx, input, input.record.externalId);
    id = existing.id;
    if (known.payloadHash === payloadHash) return { id, outcome: 'unchanged' as const };
    await repository.updateSection(tx, id, {
      names,
      categoryId: category.id,
      importedDescriptions: sourceDescriptions(input.record.descriptions),
    });
  } else id = await createImportedSection(tx, input, category, names);
  await rememberImported(tx, {
    brandId: input.brandId,
    source: input.source,
    entity: 'section',
    externalId: input.record.externalId,
    helpdockId: id,
    payloadHash,
  });
  return { id, outcome: known ? ('updated' as const) : ('created' as const) };
}
