import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { exportZohoTaxonomy, initialZohoRootScan, readZohoRootStep } from './taxonomy-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { zohoKnowledgeFixture } from './testing/knowledge-fixture.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    kbRoots: structuredClone(zohoKnowledgeFixture.roots),
    kbSections: structuredClone(zohoKnowledgeFixture.sections),
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it('hydrates bilingual categories and enumerates disabled, hidden and trashed taxonomy instead of relying on listing defaults', async () => {
  const records = (
    await collectAsync(exportZohoTaxonomy(zohoTestConnection(fake).client, 'category', null))
  ).flatMap((page) => page.records);
  expect(records.map((record) => record.payload.externalId)).toEqual([
    'category:2001',
    'category:2002',
    'category:2003',
  ]);
  expect(records[0]).toMatchObject({
    entity: 'category',
    payload: {
      names: { en: 'Original help', ar: 'المساعدة الأصلية' },
      descriptions: { en: 'Original category description', ar: 'وصف التصنيف الأصلي' },
    },
  });
});

it('preserves nested section relationships while deriving only supported English/Arabic locale aliases', async () => {
  const records = (
    await collectAsync(exportZohoTaxonomy(zohoTestConnection(fake).client, 'section', null))
  ).flatMap((page) => page.records);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    entity: 'section',
    payload: {
      externalId: 'section:4001',
      parentExternalId: 'category:2001',
      names: { en: 'Original section', ar: 'القسم الأصلي' },
    },
  });
  expect(records[1]).toMatchObject({
    entity: 'section',
    payload: {
      externalId: 'section:4002',
      parentExternalId: 'category:2001',
      parentSectionExternalId: 'section:4001',
    },
  });
});

it('resumes across a 50-root page boundary and refuses a shifted source page', async () => {
  const template = zohoKnowledgeFixture.roots[0]!;
  fake.fixture.kbRoots = Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(template),
    id: String(10000 + index),
    order: String(index),
    translations: template.translations.map((translation) => ({
      ...translation,
      categoryId: String(10000 + index),
    })),
  }));
  const { client } = zohoTestConnection(fake);
  const committed: ImportRecord[] = [];
  let checkpoint: ImportCursor | null = null;
  for await (const page of exportZohoTaxonomy(client, 'category', null)) {
    committed.push(...page.records);
    checkpoint = page.cursor;
    if (committed.length === 13) break;
  }
  const resumed = (
    await collectAsync(
      exportZohoTaxonomy(client, 'category', JSON.parse(JSON.stringify(checkpoint))),
    )
  ).flatMap((page) => page.records);
  expect([...committed, ...resumed]).toHaveLength(51);
  expect(new Set([...committed, ...resumed].map((record) => record.payload.externalId)).size).toBe(
    51,
  );
  fake.fixture.kbRoots.shift();
  await expect(
    collectAsync(exportZohoTaxonomy(client, 'category', checkpoint)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('warns about unsupported translations without replacing an English label with a different language', async () => {
  const root = fake.fixture.kbRoots![0]!;
  root.translations = [
    ...zohoKnowledgeFixture.roots[0]!.translations,
    { id: '9999', categoryId: '2001', locale: 'fr', name: 'Aide originale' },
  ];
  const log = vi.fn(async () => {});
  const records = (
    await collectAsync(
      exportZohoTaxonomy(zohoTestConnection(fake, { log }).client, 'category', null),
    )
  ).flatMap((page) => page.records);
  expect(records[0]).toMatchObject({
    payload: { names: { en: 'Original help', ar: 'المساعدة الأصلية' } },
  });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ entity: 'category', message: 'import.knowledge.locale-unsupported' }),
  );
});

it('refuses a root listing that repeats its first full page after the offset advances', async () => {
  const template = zohoKnowledgeFixture.roots[0]!;
  fake.fixture.kbRoots = Array.from({ length: 50 }, (_, index) => ({
    ...structuredClone(template),
    id: String(10000 + index),
    order: String(index),
    translations: [
      {
        id: String(20000 + index),
        categoryId: String(10000 + index),
        locale: 'en',
        name: `Root ${index}`,
      },
    ],
  }));
  const { client } = zohoTestConnection(fake);
  let cursor = initialZohoRootScan();
  while (cursor.from !== 51) {
    const step = await readZohoRootStep(client, cursor);
    if (!step.next) throw new Error('Missing second root page');
    cursor = step.next;
  }
  fake.failNext({
    path: '/api/v1/kbRootCategories',
    status: 200,
    json: {
      data: fake.fixture.kbRoots.map((row) => ({
        id: row.id,
        status: row.status,
        isTrashed: row.isTrashed,
      })),
    },
  });
  await expect(readZohoRootStep(client, cursor)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('refuses conflicting regional translations and wrong translation-parent IDs rather than silently overwriting names', async () => {
  const root = fake.fixture.kbRoots![0]!;
  root.translations = [
    ...zohoKnowledgeFixture.roots[0]!.translations,
    { id: '9999', categoryId: '2001', locale: 'en-GB', name: 'Conflicting English label' },
  ];
  await expect(
    collectAsync(exportZohoTaxonomy(zohoTestConnection(fake).client, 'category', null)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  root.translations = [{ id: '9999', categoryId: '9999', locale: 'en', name: 'Wrong parent' }];
  await expect(
    collectAsync(exportZohoTaxonomy(zohoTestConnection(fake).client, 'category', null)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
