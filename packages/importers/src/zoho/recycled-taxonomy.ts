import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import { hashImportValue } from '../hash.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';
import { zohoRootCategorySchema, zohoSectionSchema } from './knowledge-contracts.js';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const nativeTaxonomySchema = zohoRootCategorySchema.omit({ isTrashed: true }).extend({
  rootCategoryId: zohoIdSchema.nullable().optional(),
  parentCategoryId: zohoIdSchema.nullable().optional(),
  recycleBinEntityId: zohoIdSchema,
  deletedTime: z.iso.datetime({ offset: true }),
});
export const zohoRecycledTaxonomyCursorSchema = z.strictObject({
  from: z.int().positive().max(2147483647),
  offset: z.int().min(0).max(50),
  fingerprint: fingerprint.nullable(),
  previousPage: fingerprint.nullable(),
  lastDeletedTime: z.iso.datetime({ offset: true }).nullable(),
});
export type ZohoRecycledTaxonomyCursor = z.infer<typeof zohoRecycledTaxonomyCursorSchema>;
type RecycledTaxonomy =
  | { entity: 'category'; row: z.infer<typeof zohoRootCategorySchema> }
  | { entity: 'section'; row: z.infer<typeof zohoSectionSchema> };

function recycledTaxonomy(native: z.infer<typeof nativeTaxonomySchema>): RecycledTaxonomy {
  if (native.rootCategoryId == null || native.rootCategoryId === native.id) {
    if (native.parentCategoryId != null) throw new ConnectorError('invalid-response');
    return {
      entity: 'category',
      row: zohoRootCategorySchema.parse({ ...native, isTrashed: true }),
    };
  }
  if (native.parentCategoryId == null) throw new ConnectorError('invalid-response');
  return { entity: 'section', row: zohoSectionSchema.parse({ ...native, isTrashed: true }) };
}
export type ZohoRecycledTaxonomyCache = {
  page?: { from: number; rows: z.infer<typeof nativeTaxonomySchema>[]; fingerprint: string };
};
export function initialZohoRecycledTaxonomy(): ZohoRecycledTaxonomyCursor {
  return { from: 1, offset: 0, fingerprint: null, previousPage: null, lastDeletedTime: null };
}

async function recycledTaxonomyPage(
  client: ZohoDeskClient,
  cursor: ZohoRecycledTaxonomyCursor,
  cache: ZohoRecycledTaxonomyCache,
) {
  if (cache.page?.from !== cursor.from) {
    const response = await client.list(
      '/api/v1/kbCategory/trashedCategories',
      z.object({ data: z.array(nativeTaxonomySchema).max(50) }),
      {
        from: String(cursor.from),
        limit: '50',
        sortBy: 'deletedTime',
      },
    );
    if (new Set(response.data.map((row) => row.id)).size !== response.data.length)
      throw new ConnectorError('invalid-response');
    cache.page = {
      from: cursor.from,
      rows: response.data,
      fingerprint: hashImportValue(response.data),
    };
  }
  const page = cache.page;
  if (
    cursor.offset > page.rows.length ||
    page.fingerprint === cursor.previousPage ||
    (cursor.fingerprint !== null && cursor.fingerprint !== page.fingerprint)
  )
    throw new ConnectorError('invalid-response');
  return page;
}

/** This feed documents no isTrashed field; its read-only recycle-bin membership establishes that fact. */
export async function readZohoRecycledTaxonomyStep(
  client: ZohoDeskClient,
  raw: ZohoRecycledTaxonomyCursor,
  cache: ZohoRecycledTaxonomyCache = {},
): Promise<{ record: RecycledTaxonomy | null; next: ZohoRecycledTaxonomyCursor | null }> {
  const cursor = zohoRecycledTaxonomyCursorSchema.parse(raw);
  const page = await recycledTaxonomyPage(client, cursor, cache);
  const native = page.rows[cursor.offset];
  if (!native)
    return {
      record: null,
      next:
        page.rows.length === 50
          ? zohoRecycledTaxonomyCursorSchema.parse({
              ...cursor,
              from: cursor.from + 50,
              offset: 0,
              fingerprint: null,
              previousPage: page.fingerprint,
            })
          : null,
    };
  if (
    cursor.lastDeletedTime !== null &&
    Date.parse(native.deletedTime) < Date.parse(cursor.lastDeletedTime)
  )
    throw new ConnectorError('invalid-response');
  return {
    record: recycledTaxonomy(native),
    next: {
      ...cursor,
      offset: cursor.offset + 1,
      fingerprint: page.fingerprint,
      lastDeletedTime: native.deletedTime,
    },
  };
}
