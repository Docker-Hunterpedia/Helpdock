import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { exportZohoArticles } from './articles-export.js';
import { zohoArticleFixture } from './testing/article-fixture.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';
import { zohoKnowledgeFixture } from './testing/knowledge-fixture.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    articles: structuredClone(zohoArticleFixture).map((row) => ({ ...row, attachments: [] })),
    kbRoots: structuredClone(zohoKnowledgeFixture.roots),
    kbSections: structuredClone(zohoKnowledgeFixture.sections),
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function trash(locale: string) {
  for (const row of fake.fixture.articles ?? []) {
    if (row.id !== '7001' || row.locale !== locale) continue;
    row.isTrashed = true;
    row.deletedTime = '2021-01-01T12:00:00.000Z';
  }
}

async function articles(resumeEachPage = false) {
  const { client } = zohoTestConnection(fake);
  const rows: ImportRecord[] = [];
  let cursor: ImportCursor | null = null;
  do {
    for await (const page of exportZohoArticles(client, cursor)) {
      rows.push(...page.records);
      cursor = page.cursor === null ? null : JSON.parse(JSON.stringify(page.cursor));
      if (resumeEachPage) break;
    }
  } while (cursor !== null);
  return rows.filter(
    (row) => row.entity === 'article' && row.payload.externalId.startsWith('article:7001:'),
  );
}

it.each([false, true])(
  'retains an entirely trashed bilingual article as private draft history across serialized resume=%s',
  async (resume) => {
    trash('en-US');
    trash('ar-SY');
    const rows = await articles(resume);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entity: 'article',
      payload: {
        externalId: 'article:7001:en',
        draft: true,
        internal: true,
        title: 'Original article',
        bodyHtml: expect.stringContaining('Unpublished edit'),
        published: { bodyHtml: expect.stringContaining('Published answer'), publishedAt: null },
      },
    });
    expect(rows[1]).toMatchObject({
      entity: 'article',
      payload: {
        externalId: 'article:7001:ar',
        draft: true,
        internal: true,
        translationOf: 'article:7001:en',
        title: 'المقالة الأصلية',
      },
    });
    expect(
      fake.calls.every((call) => call.method === 'GET' || call.path === '/oauth/v2/token'),
    ).toBe(true);
  },
);

it.each(['en-US', 'ar-SY'])(
  'groups an active/deleted pair when %s is deleted, without duplicate extraction or changing the live sibling visibility',
  async (deleted) => {
    trash(deleted);
    const rows = await articles();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.payload.externalId)).size).toBe(2);
    for (const row of rows) {
      if (row.entity !== 'article') throw new Error('Unexpected non-article');
      const isDeleted = row.payload.locale === deleted.split('-')[0];
      expect(row.payload.draft).toBe(isDeleted);
      expect(row.payload.internal).toBe(isDeleted);
    }
    expect(rows[1]?.payload).toMatchObject({
      externalId: 'article:7001:ar',
      translationOf: 'article:7001:en',
    });
  },
);

it('keeps the same English translation anchor when the native status sort lists the Arabic draft first', async () => {
  const arabic = fake.fixture.articles?.find((row) => row.locale === 'ar-SY');
  if (!arabic) throw new Error('Missing Arabic source');
  arabic.status = 'Draft';
  arabic.latestVersionStatus = 'Draft';
  arabic.latestPublishedVersion = null;
  const rows = await articles();
  expect(rows.map((row) => row.payload.externalId)).toEqual(['article:7001:en', 'article:7001:ar']);
  expect(rows[1]?.payload).toMatchObject({
    translationOf: 'article:7001:en',
    draft: true,
    published: null,
  });
});

it('refuses a deleted translation returned for the wrong native identity instead of attaching its body to a sibling', async () => {
  trash('ar-SY');
  const row = fake.fixture.articles?.find((row) => row.locale === 'ar-SY');
  if (!row) throw new Error('Missing deleted Arabic source');
  fake.failNext({
    path: '/api/v1/articles/7001/translations/ar-SY',
    status: 200,
    json: { ...row, translationId: '9999' },
  });
  await expect(articles()).rejects.toMatchObject({ code: 'invalid-response' });
});

it('retains an Arabic source anchor when English is added later rather than reversing the translation relationship', async () => {
  const english = (fake.fixture.articles ?? []).filter(
    (row) => row.id === '7001' && row.locale === 'en-US',
  );
  fake.fixture.articles = (fake.fixture.articles ?? []).filter((row) => !english.includes(row));
  const arabic = fake.fixture.articles.find((row) => row.id === '7001');
  if (!arabic) throw new Error('Missing Arabic source anchor');
  arabic.sourceLocale = 'ar-SY';
  expect((await articles())[0]?.payload).toMatchObject({ externalId: 'article:7001:ar' });
  fake.fixture.articles.push(...english.map((row) => ({ ...row, sourceLocale: 'ar-SY' })));
  const updated = await articles();
  expect(updated.map((row) => row.payload.externalId)).toEqual([
    'article:7001:ar',
    'article:7001:en',
  ]);
  expect(updated[0]?.payload).not.toHaveProperty('translationOf');
  expect(updated[1]?.payload).toMatchObject({ translationOf: 'article:7001:ar' });
});

it('emits the reviewed fallback relationship when English is added to a source whose native primary is unsupported', async () => {
  const english = (fake.fixture.articles ?? []).filter(
    (row) => row.id === '7001' && row.locale === 'en-US',
  );
  fake.fixture.articles = (fake.fixture.articles ?? [])
    .filter((row) => !english.includes(row))
    .map((row) => (row.id === '7001' ? { ...row, sourceLocale: 'fr-FR' } : row));
  const template = english[0];
  if (!template) throw new Error('Missing native article fixture');
  fake.fixture.articles.push({
    ...structuredClone(template),
    locale: 'fr-FR',
    sourceLocale: 'fr-FR',
    translationId: '8090',
    title: 'Réponse originale',
  });
  const initial = await articles();
  expect(initial.map((row) => row.payload.externalId)).toEqual(['article:7001:ar']);
  expect(initial[0]?.payload).not.toHaveProperty('translationOf');
  fake.fixture.articles.push(...english.map((row) => ({ ...row, sourceLocale: 'fr-FR' })));
  const delta = await articles();
  expect(delta.map((row) => row.payload.externalId)).toEqual([
    'article:7001:en',
    'article:7001:ar',
  ]);
  expect(delta[1]?.payload).toMatchObject({ translationOf: 'article:7001:en' });
  expect(fake.calls.some((call) => call.path.includes('/translations/fr-FR'))).toBe(false);
});
