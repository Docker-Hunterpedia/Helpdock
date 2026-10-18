import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { RUN_SNAPSHOT } from '../http.js';
import type { FreshdeskClient } from './client.js';
import {
  freshdeskArticleSchema,
  freshdeskCategorySchema,
  freshdeskFolderSchema,
} from './contracts.js';

export type KnowledgeLocale = { source: string; locale: 'en' | 'ar'; primary: boolean };
export async function freshdeskKnowledgeLocales(
  client: FreshdeskClient,
): Promise<KnowledgeLocale[]> {
  // Every knowledge checkpoint carries this response's fingerprint, in all three entities.
  const settings = await client.json(
    '/api/v2/settings/helpdesk',
    z.object({
      primary_language: z.string().min(1).max(80),
      supported_languages: z.array(z.string().min(1).max(80)).max(100),
    }),
    {},
    RUN_SNAPSHOT,
  );
  const locales: KnowledgeLocale[] = [];
  for (const source of new Set([settings.primary_language, ...settings.supported_languages])) {
    if (!/^(?:en|ar)(?:[-_][a-z0-9]{1,8})*$/i.test(source)) return client.refuseKnowledgeLocales();
    const base = source.toLowerCase().replaceAll('_', '-').split('-')[0];
    if ((base !== 'en' && base !== 'ar') || locales.some((entry) => entry.locale === base))
      return client.refuseKnowledgeLocales();
    locales.push({ source, locale: base, primary: source === settings.primary_language });
  }
  return locales;
}

export function freshdeskFolderParent(
  folder: z.infer<typeof freshdeskFolderSchema>,
  categoryId: number,
): number | null {
  const category = folder.hierarchy?.filter((entry) => entry.type === 'category');
  if (category?.length && (category.length !== 1 || category[0]?.data.id !== categoryId))
    throw new ConnectorError('invalid-response');
  const parents =
    folder.hierarchy?.filter((entry) => entry.type === 'folder' && entry.data.id !== folder.id) ??
    [];
  const inferred = parents.at(-1)?.data.id ?? null;
  const parent = folder.parent_folder_id === undefined ? inferred : folder.parent_folder_id;
  if (parent === folder.id || (parents.length && parent !== inferred))
    throw new ConnectorError('invalid-response');
  return parent;
}

export async function freshdeskTaxonomyRecord(
  client: FreshdeskClient,
  entity: 'category' | 'section',
  row: z.infer<typeof freshdeskCategorySchema> | z.infer<typeof freshdeskFolderSchema>,
  categoryId: number,
  locales: KnowledgeLocale[],
): Promise<ImportRecord> {
  const names: Partial<Record<'en' | 'ar', string>> = {};
  const descriptions: Partial<Record<'en' | 'ar', string>> = {};
  for (const locale of locales) {
    let translated = row;
    if (!locale.primary) {
      try {
        translated = await client.json(
          `/api/v2/solutions/${entity === 'category' ? 'categories' : 'folders'}/${row.id}/${encodeURIComponent(locale.source)}`,
          freshdeskCategorySchema,
        );
      } catch (error) {
        if (!(error instanceof ConnectorError) || error.code !== 'record-unavailable') throw error;
        await client.warnTranslation(entity, `${entity}:${row.id}:${locale.locale}`);
        continue;
      }
    }
    if (translated.id !== row.id) throw new ConnectorError('invalid-response');
    names[locale.locale] = translated.name;
    descriptions[locale.locale] = translated.description ?? '';
  }
  const folder = entity === 'section' ? freshdeskFolderSchema.parse(row) : null;
  const parent = folder ? freshdeskFolderParent(folder, categoryId) : null;
  return importRecordSchema.parse({
    entity,
    payload: {
      externalId: `${entity}:${row.id}`,
      names,
      descriptions,
      ...(entity === 'section' ? { parentExternalId: `category:${categoryId}` } : {}),
      ...(parent ? { parentSectionExternalId: `section:${parent}` } : {}),
    },
  });
}

export const freshdeskPrivacySchema = z.strictObject({
  nextId: z.number().int().positive().nullable(),
  seen: z.array(z.number().int().positive()).max(128),
  internal: z.boolean(),
});

/** One durable hop avoids restarting deep parent walks after a rate-limit wait. */
export async function freshdeskFolderPrivacyStep(
  client: FreshdeskClient,
  categoryId: number,
  raw: z.infer<typeof freshdeskPrivacySchema>,
) {
  const state = freshdeskPrivacySchema.parse(raw);
  const current = state.nextId;
  if (current === null) return state;
  if (state.seen.includes(current) || state.seen.length >= 128)
    throw new ConnectorError('invalid-response');
  const folder = await client.json(`/api/v2/solutions/folders/${current}`, freshdeskFolderSchema);
  if (folder.id !== current) throw new ConnectorError('invalid-response');
  return freshdeskPrivacySchema.parse({
    nextId: freshdeskFolderParent(folder, categoryId),
    seen: [...state.seen, current],
    internal: state.internal || folder.visibility !== 1,
  });
}

export async function freshdeskArticleRecords(
  client: FreshdeskClient,
  id: number,
  folderId: number,
  categoryId: number,
  locales: KnowledgeLocale[],
  internal: boolean,
): Promise<ImportRecord[]> {
  const primary = locales.find((entry) => entry.primary);
  if (!primary) throw new ConnectorError('invalid-response');
  const records: ImportRecord[] = [];
  for (const locale of locales) {
    const externalId = `article:${id}:${locale.locale}`;
    let article: z.infer<typeof freshdeskArticleSchema>;
    try {
      article = await client.json(
        `/api/v2/solutions/articles/${id}${locale.primary ? '' : `/${encodeURIComponent(locale.source)}`}`,
        freshdeskArticleSchema,
      );
    } catch (error) {
      if (
        locale.primary ||
        !(error instanceof ConnectorError) ||
        error.code !== 'record-unavailable'
      )
        throw error;
      await client.warnTranslation('article', externalId);
      continue;
    }
    if (
      article.id !== id ||
      article.folder_id !== folderId ||
      article.category_id !== categoryId ||
      ![1, 2].includes(article.status)
    )
      throw new ConnectorError('invalid-response');
    if (internal) await client.warnReadership(externalId);
    records.push(
      importRecordSchema.parse({
        entity: 'article',
        payload: {
          externalId,
          sectionExternalId: `section:${folderId}`,
          locale: locale.locale,
          title: article.title,
          bodyHtml: article.description,
          draft: article.status === 1,
          internal,
          createdAt: article.created_at,
          updatedAt: article.updated_at,
          ...(locale.primary ? {} : { translationOf: `article:${id}:${primary.locale}` }),
        },
      }),
    );
  }
  return records;
}
