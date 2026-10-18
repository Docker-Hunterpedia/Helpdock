import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  initialZohoRecycledArticles,
  readZohoRecycledArticleStep,
  type ZohoRecycledArticlesCursor,
} from './recycled-articles.js';
import { zohoArticleFixture } from './testing/article-fixture.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
beforeEach(async () => {
  const template = zohoArticleFixture[0]!;
  fake = new FakeZoho({
    ...structuredClone(zohoCoreFixture),
    articles: Array.from({ length: 51 }, (_, index) => ({
      ...structuredClone(template),
      id: String(10000 + index),
      translationId: String(20000 + index),
      isTrashed: true,
      deletedTime: '2021-01-01T12:00:00.000Z',
      attachments: [],
    })),
  });
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

it('resumes beyond the 50-translation recycle page limit without inventing a root category from the thin feed', async () => {
  const { client } = zohoTestConnection(fake);
  let cursor: ZohoRecycledArticlesCursor | null = initialZohoRecycledArticles();
  const ids: string[] = [];
  while (cursor) {
    const step = await readZohoRecycledArticleStep(client, JSON.parse(JSON.stringify(cursor)));
    if (step.group) {
      ids.push(step.group.articleId);
      expect(step.group.indices).toEqual([]);
      expect(step.group.hints).toMatchObject([
        { locale: 'en-US', isTrashed: true, latestVersion: '2.1' },
      ]);
    }
    cursor = step.next;
  }
  expect(ids).toEqual(Array.from({ length: 51 }, (_, index) => String(10000 + index)));
  expect(
    fake.calls.some(
      (call) =>
        call.path === '/api/v1/articleTranslations/trashedTranslations' && call.query.from === '51',
    ),
  ).toBe(true);
});

it('rejects changed recycle metadata at a saved offset rather than skipping a translation after a shifted page', async () => {
  const { client } = zohoTestConnection(fake);
  const first = await readZohoRecycledArticleStep(client, initialZohoRecycledArticles());
  if (!first.next) throw new Error('Missing recycle checkpoint');
  fake.fixture.articles![0]!.title = 'Changed recovered article';
  await expect(readZohoRecycledArticleStep(client, first.next)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it.each([429, 503])(
  'preserves its recycle offset after HTTP %i and resumes at the next native article',
  async (status) => {
    const { client } = zohoTestConnection(fake);
    const first = await readZohoRecycledArticleStep(client, initialZohoRecycledArticles());
    if (!first.next) throw new Error('Missing recycle checkpoint');
    fake.failNext({
      path: '/api/v1/articleTranslations/trashedTranslations',
      status,
      headers: { 'Retry-After': '2' },
    });
    await expect(readZohoRecycledArticleStep(client, first.next)).rejects.toMatchObject(
      status === 429 ? { name: 'RateLimited' } : { code: 'vendor-unavailable' },
    );
    const resumed = await readZohoRecycledArticleStep(
      zohoTestConnection(fake).client,
      JSON.parse(JSON.stringify(first.next)),
    );
    expect(resumed.group?.articleId).toBe('10001');
  },
);
