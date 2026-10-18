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
    articles: structuredClone(zohoArticleFixture),
    kbRoots: structuredClone(zohoKnowledgeFixture.roots),
    kbSections: structuredClone(zohoKnowledgeFixture.sections),
  });
  await fake.start();
  const row = fake.fixture.articles![0]!,
    file = row.attachments[0]!;
  const bytes = Buffer.from('%PDF-1.7\nOriginal manual');
  file.size = String(bytes.length);
  file.viewUrl = fake.addArticleAttachment(
    { articleId: row.id, locale: row.locale, resourceId: file.resourceId },
    bytes,
  );
  file.downloadUrl = `${file.viewUrl}?inline=false`;
});
afterEach(async () => {
  await fake.close();
});

async function collect(resumeEachPage = false) {
  const { client } = zohoTestConnection(fake);
  const records: ImportRecord[] = [];
  let cursor: ImportCursor | null = null;
  do {
    const reader = exportZohoArticles(client, cursor);
    try {
      for await (const page of reader) {
        records.push(...page.records);
        cursor = page.cursor === null ? null : JSON.parse(JSON.stringify(page.cursor));
        if (resumeEachPage) break;
      }
    } finally {
      await reader.return(undefined);
    }
  } while (cursor !== null);
  return records;
}

it.each([false, true])(
  'retains both article copies, native dates, private drafts and Arabic across serialized resume=%s',
  async (resume) => {
    const rows = await collect(resume);
    expect(rows).toHaveLength(3);
    const english = rows.find(
      (row) => row.entity === 'article' && row.payload.externalId === 'article:7001:en',
    );
    if (english?.entity !== 'article') throw new Error('Missing original English article');
    expect(english.payload).toMatchObject({
      locale: 'en',
      sectionExternalId: 'section:4001',
      draft: false,
      internal: false,
      createdAt: '2013-11-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      title: 'Original article',
      assetOrigin: fake.root,
      bodyHtml: expect.stringContaining('Unpublished edit'),
      published: {
        title: 'Published article',
        assetOrigin: fake.root,
        bodyHtml: expect.stringContaining('Published answer'),
        publishedAt: null,
        attachments: [],
      },
    });
    expect(english.payload.attachments).toHaveLength(1);
    expect(english.payload.published?.bodyHtml).not.toContain('Staff-only');
    expect(rows.find((row) => row.payload.externalId === 'article:7001:ar')?.payload).toMatchObject(
      {
        locale: 'ar',
        translationOf: 'article:7001:en',
        title: 'المقالة الأصلية',
      },
    );
    expect(rows.find((row) => row.payload.externalId === 'article:7002:en')?.payload).toMatchObject(
      { draft: true, internal: true, published: null },
    );
  },
);

it('keeps public copies unpublished under a hidden ancestor and warns about restricted readership', async () => {
  const logs: string[] = [];
  fake.fixture.kbRoots![0]!.status = 'HIDE_IN_HELPCENTER';
  const { client } = zohoTestConnection(fake, {
    log: async (entry) => {
      logs.push(entry.message);
    },
  });
  const rows: ImportRecord[] = [];
  for await (const page of exportZohoArticles(client, null)) rows.push(...page.records);
  expect(
    rows
      .filter((row) => row.entity === 'article')
      .every((row) => row.entity === 'article' && row.payload.draft && row.payload.internal),
  ).toBe(true);
  expect(rows).toHaveLength(3);
  expect(logs).toContain('import.knowledge.readership-restricted');
});

it('refuses two regional translations targeting one local language rather than overwriting either', async () => {
  fake.fixture.articles!.push({
    ...structuredClone(zohoArticleFixture[2]!),
    locale: 'en-GB',
    translationId: '8099',
  });
  await expect(collect()).rejects.toMatchObject({ code: 'invalid-response' });
});

it('resumes from the last durable version checkpoint after 429 without re-reading the working answer', async () => {
  const { client } = zohoTestConnection(fake);
  let checkpoint: ImportCursor | null = null;
  for await (const page of exportZohoArticles(client, null)) {
    const cursor = page.cursor;
    if (
      cursor?.stage === 'versions' &&
      cursor.versions &&
      typeof cursor.versions === 'object' &&
      !Array.isArray(cursor.versions) &&
      cursor.versions.working !== null
    ) {
      checkpoint = JSON.parse(JSON.stringify(cursor));
      break;
    }
  }
  if (!checkpoint) throw new Error('Missing durable version checkpoint');
  const path = '/api/v1/articles/7001/translations/en-US';
  fake.failNext({ path, status: 429, headers: { 'Retry-After': '2' } });
  await expect(exportZohoArticles(client, checkpoint).next()).rejects.toMatchObject({
    name: 'RateLimited',
  });
  const reader = exportZohoArticles(zohoTestConnection(fake).client, checkpoint);
  let resumed: ImportRecord | undefined;
  for await (const page of reader) {
    if (page.records.length) {
      resumed = page.records[0];
      break;
    }
  }
  expect(resumed?.payload.externalId).toBe('article:7001:en');
  expect(
    fake.calls.filter((call) => call.path === path && call.query.version === '2.1'),
  ).toHaveLength(2);
});
