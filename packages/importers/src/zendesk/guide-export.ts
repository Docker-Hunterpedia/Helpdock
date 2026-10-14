import { type ImportRecord, importRecordSchema } from '@helpdock/schemas';
import { z } from 'zod';
import type { ImportCursor, ImportPage } from '../connector.js';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZendeskClient } from './client.js';
import { zendeskListEnvelopeSchema } from './contracts.js';

const translationSchema = z.object({
  id: z.int().positive(),
  source_id: z.int().positive(),
  source_type: z.string(),
  locale: z.string(),
  title: z.string(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  created_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
const taxonomySchema = z.object({
  id: z.int().positive(),
  name: z.string(),
  locale: z.string(),
  description: z.string().optional(),
  category_id: z.int().positive().optional(),
  parent_section_id: z.int().positive().nullish(),
});
const articleSchema = z.object({
  id: z.int().positive(),
  section_id: z.int().positive(),
  source_locale: z.string(),
  draft: z.boolean(),
  user_segment_id: z.int().positive().nullish(),
  user_segment_ids: z.array(z.int().positive()).optional(),
});
const checkpointSchema = z.strictObject({
  page: z.int().positive(),
  offset: z.int().nonnegative().default(0),
  fingerprint: z.string().optional(),
});
type GuideEntity = 'category' | 'section' | 'article';

function supportedLocale(locale: string): 'en' | 'ar' | null {
  if (/^en(?:-|$)/i.test(locale)) return 'en';
  if (/^ar(?:-|$)/i.test(locale)) return 'ar';
  return null;
}

async function translations(client: ZendeskClient, entity: GuideEntity, id: number) {
  const path = `/api/v2/help_center/${entity === 'category' ? 'categories' : `${entity}s`}/${id}/translations.json`;
  const schema = zendeskListEnvelopeSchema.extend({
    translations: z.array(translationSchema).max(100),
  });
  const collected: z.infer<typeof translationSchema>[] = [];
  let pageNumber = 1;
  while (true) {
    const response = await client.json(path, schema, { page: String(pageNumber), per_page: '100' });
    for (const translation of response.translations) {
      if (translation.source_id !== id || translation.source_type.toLowerCase() !== entity)
        throw new ConnectorError('invalid-response');
      collected.push(translation);
    }
    if (collected.length > 1000) throw new ConnectorError('invalid-response');
    const next = client.nextOffset(response.next_page, path, pageNumber);
    if (next === null) return collected;
    pageNumber = next;
  }
}

function localizedTranslations(source: z.infer<typeof translationSchema>[]) {
  const locales = new Map<'en' | 'ar', z.infer<typeof translationSchema>>();
  for (const translation of source) {
    const locale = supportedLocale(translation.locale);
    if (!locale || locales.has(locale)) throw new ConnectorError('invalid-response');
    locales.set(locale, translation);
  }
  return locales;
}

async function taxonomyRecord(
  client: ZendeskClient,
  entity: 'category' | 'section',
  request: unknown,
): Promise<ImportRecord[]> {
  const source = taxonomySchema.parse(request);
  if (entity === 'section' && source.category_id === undefined)
    throw new ConnectorError('invalid-response');
  const content = localizedTranslations(await translations(client, entity, source.id));
  return [
    importRecordSchema.parse({
      entity,
      payload: {
        externalId: `${entity}:${source.id}`,
        ...(entity === 'section' ? { parentExternalId: `category:${source.category_id}` } : {}),
        ...(entity === 'section' && source.parent_section_id
          ? { parentSectionExternalId: `section:${source.parent_section_id}` }
          : {}),
        names: Object.fromEntries(
          [...content].map(([locale, translation]) => [locale, translation.title]),
        ),
        descriptions: Object.fromEntries(
          [...content].map(([locale, translation]) => [locale, translation.body ?? '']),
        ),
      },
    }),
  ];
}

async function articleRecords(client: ZendeskClient, request: unknown): Promise<ImportRecord[]> {
  const source = articleSchema.parse(request);
  const content = localizedTranslations(await translations(client, 'article', source.id));
  const primary = supportedLocale(source.source_locale);
  if (!primary || !content.has(primary)) throw new ConnectorError('invalid-response');
  const knownReadership =
    source.user_segment_id !== undefined || source.user_segment_ids !== undefined;
  const internal =
    !knownReadership || source.user_segment_id != null || !!source.user_segment_ids?.length;
  if (internal) await client.warnGuideReadership(`article:${source.id}`);
  const ordered = [...content].sort(
    ([first], [second]) => Number(second === primary) - Number(first === primary),
  );
  return ordered.map(([locale, translation]) => {
    if (translation.body === undefined || !translation.created_at || !translation.updated_at)
      throw new ConnectorError('invalid-response');
    return importRecordSchema.parse({
      entity: 'article',
      payload: {
        externalId: locale === primary ? `article:${source.id}` : `article:${source.id}:${locale}`,
        sectionExternalId: `section:${source.section_id}`,
        locale,
        title: translation.title,
        bodyHtml: translation.body,
        draft: translation.draft ?? (locale === primary ? source.draft : false),
        internal,
        createdAt: translation.created_at,
        updatedAt: translation.updated_at,
        ...(locale === primary ? {} : { translationOf: `article:${source.id}` }),
      },
    });
  });
}

export async function* exportZendeskGuide(
  client: ZendeskClient,
  entity: GuideEntity,
  cursor: ImportCursor | null,
): AsyncGenerator<ImportPage> {
  let checkpoint = checkpointSchema.parse(cursor ?? { page: 1 });
  const collection = entity === 'category' ? 'categories' : `${entity}s`;
  const path = `/api/v2/help_center/${collection}.json`;
  const row = z.record(z.string(), z.json()).and(z.object({ id: z.int().positive() }));
  const schema = zendeskListEnvelopeSchema.extend({
    categories: z.array(row).optional(),
    sections: z.array(row).optional(),
    articles: z.array(row).optional(),
  });
  while (true) {
    const response = await client.json(path, schema, {
      page: String(checkpoint.page),
      per_page: '100',
    });
    const rows =
      entity === 'category'
        ? response.categories
        : entity === 'section'
          ? response.sections
          : response.articles;
    if (!rows || rows.length > 100) throw new ConnectorError('invalid-response');
    const fingerprint = hashImportValue(rows);
    if (
      (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) ||
      checkpoint.offset > rows.length
    )
      throw new ConnectorError('invalid-response');
    for (let index = checkpoint.offset; index < rows.length; index++) {
      const source = rows[index];
      const records =
        entity === 'article'
          ? await articleRecords(client, source)
          : await taxonomyRecord(client, entity, source);
      yield { records, cursor: { page: checkpoint.page, offset: index + 1, fingerprint } };
    }
    const next = client.nextOffset(response.next_page, path, checkpoint.page);
    if (next === null) {
      yield { records: [], cursor: null };
      return;
    }
    checkpoint = { page: next, offset: 0 };
    yield { records: [], cursor: { page: next, offset: 0 } };
  }
}
