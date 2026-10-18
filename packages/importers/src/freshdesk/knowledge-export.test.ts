import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { FreshdeskClient } from './client.js';
import { exportFreshdeskKnowledge } from './knowledge-export.js';
import { freshdeskFolderPrivacyStep } from './knowledge-records.js';
import { freshdeskTestContext } from './testing/context.js';
import { FakeFreshdesk } from './testing/fake-freshdesk.js';
import { freshdeskKnowledgeFixture as fixture } from './testing/knowledge-fixture.js';

let fake: FakeFreshdesk;
let client: FreshdeskClient;
const log = vi.fn(async () => {});
beforeEach(async () => {
  log.mockClear();
  fake = new FakeFreshdesk(fixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: 0,
    pageSize: 2,
  });
  await fake.server.start();
  client = new FreshdeskClient(freshdeskTestContext(fake, log), fake.server.root);
});
afterEach(async () => {
  await fake.server.close();
});

it('preserves bilingual taxonomy and native ancestry when the vendor lists a child before its parent', async () => {
  const categories = await collectAsync(exportFreshdeskKnowledge(client, 'category', null));
  expect(categories.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'category',
      payload: {
        externalId: 'category:601',
        names: { en: 'Original help center', ar: 'مركز المساعدة الأصلي' },
      },
    },
  ]);
  const pages = await collectAsync(exportFreshdeskKnowledge(client, 'section', null));
  const records = [
    ...new Map(
      pages.flatMap((page) => page.records).map((record) => [record.payload.externalId, record]),
    ).values(),
  ];
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    entity: 'section',
    payload: {
      externalId: 'section:702',
      parentExternalId: 'category:601',
      parentSectionExternalId: 'section:701',
      names: { en: 'Nested guides', ar: 'أدلة متداخلة' },
    },
  });
});

it('preserves complete translations, per-language draft state and original dates while keeping restricted descendants internal', async () => {
  const pages = await collectAsync(exportFreshdeskKnowledge(client, 'article', null));
  const records = [
    ...new Map(
      pages.flatMap((page) => page.records).map((record) => [record.payload.externalId, record]),
    ).values(),
  ];
  expect(records).toEqual([
    {
      entity: 'article',
      payload: {
        externalId: 'article:801:en',
        sectionExternalId: 'section:702',
        locale: 'en',
        title: 'Original article',
        bodyHtml: '<p>Complete original guide</p>',
        draft: false,
        internal: true,
        createdAt: '2020-01-01T10:00:00Z',
        updatedAt: '2020-01-02T10:00:00Z',
      },
    },
    {
      entity: 'article',
      payload: {
        externalId: 'article:801:ar',
        sectionExternalId: 'section:702',
        locale: 'ar',
        title: 'المقال الأصلي',
        bodyHtml: '<p>الدليل الأصلي الكامل</p>',
        draft: true,
        internal: true,
        createdAt: '2020-01-01T10:00:00Z',
        updatedAt: '2020-01-02T10:00:00Z',
        translationOf: 'article:801:en',
      },
    },
  ]);
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'article',
    externalId: 'article:801:en',
    message: 'import.knowledge.readership-restricted',
  });
});

it('checkpoints one ancestor hop at a time so a resumed walk can finish with a fresh client', async () => {
  const first = await freshdeskFolderPrivacyStep(client, 601, {
    nextId: 702,
    seen: [],
    internal: false,
  });
  expect(first).toEqual({ nextId: 701, seen: [702], internal: false });
  const resumed = new FreshdeskClient(freshdeskTestContext(fake, log), fake.server.root);
  const second = await freshdeskFolderPrivacyStep(resumed, 601, JSON.parse(JSON.stringify(first)));
  expect(second).toEqual({ nextId: null, seen: [702, 701], internal: true });
  expect(fake.server.calls.map((call) => call.path)).toEqual([
    '/api/v2/solutions/folders/702',
    '/api/v2/solutions/folders/701',
  ]);
});

it('resumes a serialized article cursor with the same history and stable source identities', async () => {
  const iterator = exportFreshdeskKnowledge(client, 'article', null)[Symbol.asyncIterator]();
  let checkpoint: ImportCursor | null = null;
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error('Missing article fixture');
    if (next.value.records.length) {
      checkpoint = next.value.cursor;
      break;
    }
  }
  await iterator.return?.();
  const resumed = new FreshdeskClient(freshdeskTestContext(fake, log), fake.server.root);
  const pages = await collectAsync(
    exportFreshdeskKnowledge(resumed, 'article', JSON.parse(JSON.stringify(checkpoint))),
  );
  const records = pages.flatMap((page) => page.records);
  expect(new Set(records.map((record) => record.payload.externalId))).toEqual(
    new Set(['article:801:en', 'article:801:ar']),
  );
  expect(records.every((record) => record.entity === 'article' && record.payload.internal)).toBe(
    true,
  );
  expect(pages.at(-1)?.cursor).toBeNull();
});

it('reports missing optional translations without inventing translated content', async () => {
  fake.replaceFixture({ ...fixture, translations: { ...fixture.translations, 'article:801': {} } });
  const pages = await collectAsync(exportFreshdeskKnowledge(client, 'article', null));
  expect(
    new Set(pages.flatMap((page) => page.records).map((record) => record.payload.externalId)),
  ).toEqual(new Set(['article:801:en']));
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'article',
    externalId: 'article:801:ar',
    message: 'import.record-unavailable',
  });
});

it('uses Arabic as the primary content language when the source settings say so', async () => {
  const english = fixture.articles['702'][0];
  const arabic = fixture.translations['article:801'].ar;
  if (!english) throw new Error('Missing article fixture');
  fake.replaceFixture({
    ...fixture,
    helpdesk_settings: { primary_language: 'ar', supported_languages: ['en'] },
    articles: { '702': [arabic] },
    translations: { ...fixture.translations, 'article:801': { en: english } },
  });
  const pages = await collectAsync(exportFreshdeskKnowledge(client, 'article', null));
  const records = [
    ...new Map(
      pages.flatMap((page) => page.records).map((record) => [record.payload.externalId, record]),
    ).values(),
  ];
  expect(records[0]).toMatchObject({
    entity: 'article',
    payload: {
      externalId: 'article:801:ar',
      locale: 'ar',
      bodyHtml: '<p>الدليل الأصلي الكامل</p>',
    },
  });
  expect(records[0]?.payload).not.toHaveProperty('translationOf');
  expect(records[1]).toMatchObject({
    entity: 'article',
    payload: { externalId: 'article:801:en', locale: 'en', translationOf: 'article:801:ar' },
  });
});

it('pages through category inventories without dropping a category at a page boundary', async () => {
  const original = fixture.categories[0];
  if (!original) throw new Error('Missing category fixture');
  fake.replaceFixture({
    helpdesk_settings: { primary_language: 'en', supported_languages: [] },
    categories: [
      original,
      { ...original, id: 602, name: 'Second category' },
      { ...original, id: 603, name: 'Third category' },
    ],
  });
  const pages = await collectAsync(exportFreshdeskKnowledge(client, 'category', null));
  expect(pages.flatMap((page) => page.records).map((record) => record.payload.externalId)).toEqual([
    'category:601',
    'category:602',
    'category:603',
  ]);
  expect(
    fake.server.calls.some(
      (call) => call.path === '/api/v2/solutions/categories' && call.query.page === '2',
    ),
  ).toBe(true);
});

it('refuses inaccessible ancestors instead of treating incomplete permission information as public', async () => {
  fake.server.failNext({ path: '/api/v2/solutions/folders/701', status: 403 });
  await expect(
    collectAsync(exportFreshdeskKnowledge(client, 'article', null)),
  ).rejects.toMatchObject({ code: 'credentials-refused' });
});

it('refuses cyclic folder ancestry before importing article content', async () => {
  const root = fixture.folders['601'][1];
  const child = fixture.folders['601'][0];
  if (!root || !child) throw new Error('Missing folder fixture');
  fake.replaceFixture({
    ...fixture,
    folders: { '601': [child, { ...root, parent_folder_id: 702 }] },
  });
  await expect(
    collectAsync(exportFreshdeskKnowledge(client, 'article', null)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it.each([
  { primary_language: 'fr', supported_languages: ['en'] },
  { primary_language: 'en-US', supported_languages: ['en-GB'] },
  { primary_language: 'en-../../private', supported_languages: [] },
])(
  'refuses unsupported or colliding locale configurations rather than discarding content',
  async (helpdesk_settings) => {
    fake.replaceFixture({ ...fixture, helpdesk_settings });
    await expect(
      collectAsync(exportFreshdeskKnowledge(client, 'category', null)),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fake.server.calls.map((call) => call.path)).toEqual(['/api/v2/settings/helpdesk']);
  },
);

it('invalidates a resumed export when the configured primary language changes', async () => {
  const iterator = exportFreshdeskKnowledge(client, 'category', null)[Symbol.asyncIterator]();
  const first = await iterator.next();
  await iterator.return?.();
  fake.replaceFixture({
    ...fixture,
    helpdesk_settings: { primary_language: 'ar', supported_languages: ['en'] },
  });
  await expect(
    collectAsync(exportFreshdeskKnowledge(client, 'category', first.value?.cursor ?? null)),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
