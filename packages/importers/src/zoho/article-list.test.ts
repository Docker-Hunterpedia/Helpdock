import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ZohoArticleIndex } from './article-contracts.js';
import {
  initialZohoArticleList,
  readZohoArticleListStep,
  type ZohoArticleListCursor,
} from './article-list.js';
import { zohoArticleFixture } from './testing/article-fixture.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    articles: structuredClone(zohoArticleFixture),
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it.each([0, 1] as const)(
  'proves %i-based native offsets and resumes after a full page without losing the first article',
  async (origin) => {
    fake.articleOffsetOrigin = origin;
    const template = zohoArticleFixture[0]!;
    fake.fixture.articles = Array.from({ length: 51 }, (_, index) => ({
      ...structuredClone(template),
      id: String(10000 + index),
      translationId: String(20000 + index),
    }));
    const { client } = zohoTestConnection(fake);
    let cursor: ZohoArticleListCursor | null = initialZohoArticleList();
    const ids: string[] = [];
    while (cursor) {
      const step = await readZohoArticleListStep(client, JSON.parse(JSON.stringify(cursor)));
      if (step.row) ids.push(step.row.id);
      cursor = step.next;
    }
    expect(ids).toHaveLength(51);
    expect(new Set(ids).size).toBe(51);
    expect(ids[0]).toBe('10000');
    expect(ids.at(-1)).toBe('10050');
    const calls = fake.calls
      .filter((call) => call.path === '/api/v1/articles')
      .map((call) => new URLSearchParams(call.query));
    expect(calls[0]?.has('from')).toBe(false);
    expect(calls.some((query) => query.get('from') === String(50 + origin))).toBe(true);
  },
);

it('lists all publishing states and keeps original language identities in translation metadata', async () => {
  const { client } = zohoTestConnection(fake);
  const translations = [];
  let cursor: ZohoArticleListCursor | null = initialZohoArticleList();
  while (cursor) {
    const step = await readZohoArticleListStep(client, cursor, '7001');
    if (step.row) translations.push(step.row);
    cursor = step.next;
  }
  expect(translations.map((row) => row.locale)).toEqual(['en-US', 'ar-SY']);
  expect(translations.map((row) => row.translationId)).toEqual(['8001', '8002']);
  expect(translations[0]).not.toHaveProperty('answer');
  expect(
    new Set(
      fake.calls
        .filter((call) => call.path === '/api/v1/articles/7001/translations')
        .map((call) => call.query.status),
    ),
  ).toEqual(new Set(['Draft', 'Published', 'Review', 'Expired', 'Unpublished']));
});

it('refuses changed source pages on resume instead of using a positional index against different rows', async () => {
  const { client } = zohoTestConnection(fake);
  const first = await readZohoArticleListStep(client, initialZohoArticleList());
  if (!first.next || !first.row) throw new Error('Missing initial native article');
  const row = fake.fixture.articles?.find(
    (row) => row.id === first.row?.id && row.currentVersion === row.latestVersion,
  );
  if (!row) throw new Error('Missing native article fixture');
  row.title = 'Changed source title';
  await expect(readZohoArticleListStep(client, first.next)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('stops when an article endpoint ignores the next-page offset instead of extracting the same full page indefinitely', async () => {
  const template = zohoArticleFixture[0]!;
  fake.fixture.articles = Array.from({ length: 50 }, (_, index) => ({
    ...structuredClone(template),
    id: String(10000 + index),
    translationId: String(20000 + index),
  }));
  const { client } = zohoTestConnection(fake);
  let cursor = initialZohoArticleList();
  const firstPage: ZohoArticleIndex[] = [];
  while (cursor.from !== 51) {
    const step = await readZohoArticleListStep(client, cursor);
    if (step.row) firstPage.push(step.row);
    if (!step.next) throw new Error('Missing second article page');
    cursor = step.next;
  }
  fake.failNext({ path: '/api/v1/articles', status: 200, json: { data: firstPage } });
  await expect(readZohoArticleListStep(client, cursor)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});
