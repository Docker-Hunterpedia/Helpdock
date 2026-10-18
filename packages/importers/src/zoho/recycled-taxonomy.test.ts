import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import {
  initialZohoRecycledTaxonomy,
  readZohoRecycledTaxonomyStep,
  type ZohoRecycledTaxonomyCursor,
} from './recycled-taxonomy.js';
import { exportZohoTaxonomy } from './taxonomy-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { zohoKnowledgeFixture } from './testing/knowledge-fixture.js';

let fake: FakeZoho;
const deletedTime = '2021-01-01T12:00:00.000Z';
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    kbRoots: structuredClone(zohoKnowledgeFixture.roots),
    kbSections: structuredClone(zohoKnowledgeFixture.sections),
    recycledTaxonomy: [
      {
        ...structuredClone(zohoKnowledgeFixture.roots[0]!),
        id: '2009',
        isTrashed: true,
        recycleBinEntityId: '2009',
        deletedTime,
        translations: [
          { id: '3099', categoryId: '2009', locale: 'en', name: 'Recoverable category' },
        ],
      },
      {
        ...structuredClone(zohoKnowledgeFixture.sections[1]!),
        id: '4009',
        isTrashed: true,
        recycleBinEntityId: '4009',
        deletedTime,
        parentCategoryId: '4002',
        translations: [
          {
            id: '5098',
            categoryId: '4009',
            locale: 'en',
            name: 'Recoverable section',
            description: 'Original full description',
          },
          { id: '5099', categoryId: '4009', locale: 'ar-SY', name: 'القسم المحذوف' },
        ],
      },
    ],
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it.each(['category', 'section'] as const)(
  'includes recoverable %s metadata absent from ordinary listings, preserving localized labels and hierarchy',
  async (entity) => {
    const rows: ImportRecord[] = (
      await collectAsync(exportZohoTaxonomy(zohoTestConnection(fake).client, entity, null))
    ).flatMap((page) => page.records);
    const recovered = rows.find(
      (row) => row.payload.externalId === (entity === 'section' ? 'section:4009' : 'category:2009'),
    );
    expect(recovered).toMatchObject(
      entity === 'section'
        ? {
            entity,
            payload: {
              parentExternalId: 'category:2001',
              parentSectionExternalId: 'section:4002',
              names: { en: 'Recoverable section', ar: 'القسم المحذوف' },
              descriptions: { en: 'Original full description' },
            },
          }
        : { entity, payload: { names: { en: 'Recoverable category' } } },
    );
    expect(rows).toHaveLength(entity === 'section' ? 3 : 4);
    expect(
      fake.calls.every((call) => call.method === 'GET' || call.path === '/oauth/v2/token'),
    ).toBe(true);
  },
);

it('resumes a 51-record recycle-bin feed with one bounded page and no dropped or repeated source identity', async () => {
  const template = fake.fixture.recycledTaxonomy![1]!;
  fake.fixture.recycledTaxonomy = Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(template),
    id: String(10000 + index),
    recycleBinEntityId: String(10000 + index),
    translations: [
      {
        id: String(20000 + index),
        categoryId: String(10000 + index),
        locale: 'en',
        name: `Recovered ${index}`,
      },
    ],
  }));
  const { client } = zohoTestConnection(fake);
  let cursor: ZohoRecycledTaxonomyCursor | null = initialZohoRecycledTaxonomy();
  const ids: string[] = [];
  while (cursor) {
    const step = await readZohoRecycledTaxonomyStep(client, JSON.parse(JSON.stringify(cursor)));
    if (step.record) {
      ids.push(step.record.row.id);
      expect(step.record.row.isTrashed).toBe(true);
    }
    cursor = step.next;
  }
  expect(ids).toEqual(Array.from({ length: 51 }, (_, index) => String(10000 + index)));
  expect(new Set(ids).size).toBe(51);
});

it('refuses a shifted recycle-bin page on resume rather than interpreting an offset against different metadata', async () => {
  const { client } = zohoTestConnection(fake);
  const first = await readZohoRecycledTaxonomyStep(client, initialZohoRecycledTaxonomy());
  if (!first.next) throw new Error('Missing recycle-bin checkpoint');
  fake.fixture.recycledTaxonomy![0]!.name = 'Changed source category';
  await expect(readZohoRecycledTaxonomyStep(client, first.next)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('refuses a vendor that ignores the next-page offset instead of looping through the same 50 records', async () => {
  const template = fake.fixture.recycledTaxonomy![1]!;
  const rows = Array.from({ length: 50 }, (_, index) => ({
    ...structuredClone(template),
    id: String(10000 + index),
    recycleBinEntityId: String(10000 + index),
    translations: [
      {
        id: String(20000 + index),
        categoryId: String(10000 + index),
        locale: 'en',
        name: `Recovered ${index}`,
      },
    ],
  }));
  fake.fixture.recycledTaxonomy = rows;
  const { client } = zohoTestConnection(fake);
  let cursor: ZohoRecycledTaxonomyCursor | null = initialZohoRecycledTaxonomy();
  while (cursor?.from === 1) cursor = (await readZohoRecycledTaxonomyStep(client, cursor)).next;
  if (!cursor) throw new Error('Missing second recycle-bin page');
  fake.failNext({
    path: '/api/v1/kbCategory/trashedCategories',
    status: 200,
    json: { data: rows },
  });
  await expect(readZohoRecycledTaxonomyStep(client, cursor)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it.each([429, 503])(
  'preserves the recycle-bin checkpoint after HTTP %i and resumes the next source record',
  async (status) => {
    const { client } = zohoTestConnection(fake);
    const first = await readZohoRecycledTaxonomyStep(client, initialZohoRecycledTaxonomy());
    if (!first.next) throw new Error('Missing recycle-bin checkpoint');
    fake.failNext({
      path: '/api/v1/kbCategory/trashedCategories',
      status,
      headers: { 'Retry-After': '2' },
    });
    await expect(readZohoRecycledTaxonomyStep(client, first.next)).rejects.toMatchObject(
      status === 429 ? { name: 'RateLimited' } : { code: 'vendor-unavailable' },
    );
    const resumed = await readZohoRecycledTaxonomyStep(
      zohoTestConnection(fake).client,
      JSON.parse(JSON.stringify(first.next)),
    );
    expect(resumed.record).toMatchObject({
      entity: 'section',
      row: { id: '4009', isTrashed: true, parentCategoryId: '4002' },
    });
  },
);
