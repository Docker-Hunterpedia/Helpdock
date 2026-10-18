import { afterEach, beforeEach, expect, it } from 'vitest';
import { zohoArticleIndexSchema } from './article-contracts.js';
import { readZohoArticleVersionStep } from './article-versions.js';
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

it('pins working and public content separately across serialized checkpoints', async () => {
  const { client } = zohoTestConnection(fake);
  const index = zohoArticleIndexSchema.parse(zohoArticleFixture[0]);
  const first = await readZohoArticleVersionStep(client, { index, working: null, published: null });
  expect(first.done).toBe(false);
  expect(first.state.working?.answer).toContain('Unpublished edit');
  expect(first.state.published).toBeNull();
  const resumed = await readZohoArticleVersionStep(client, JSON.parse(JSON.stringify(first.state)));
  expect(resumed.done).toBe(true);
  expect(resumed.state.published?.answer).toContain('Published answer');
  expect(resumed.state.published?.answer).not.toContain('Staff-only');
  expect(resumed.state.working?.attachments).toHaveLength(1);
  expect(resumed.state.published?.attachments).toEqual([]);
  expect(
    fake.calls
      .filter((call) => call.path.startsWith('/api/v1/articles/7001/translations/'))
      .map((call) => call.query.version),
  ).toEqual(['2.1', '2.0']);
});

it.each([2, 3])(
  'does not invent another published copy for a single-version or never-published translation (fixture %i)',
  async (fixture) => {
    const { client } = zohoTestConnection(fake);
    const index = zohoArticleIndexSchema.parse(zohoArticleFixture[fixture]);
    const result = await readZohoArticleVersionStep(client, {
      index,
      working: null,
      published: null,
    });
    expect(result.done).toBe(true);
    expect(result.state.working).not.toBeNull();
    expect(result.state.published?.currentVersion ?? null).toBe(index.latestPublishedVersion);
    expect(
      fake.calls.filter((call) =>
        call.path.startsWith(`/api/v1/articles/${index.id}/translations/`),
      ),
    ).toHaveLength(1);
  },
);

it('refuses a version/parent mismatch and propagates rate limits without replacing the public copy', async () => {
  const { client } = zohoTestConnection(fake);
  const index = zohoArticleIndexSchema.parse(zohoArticleFixture[0]);
  const first = await readZohoArticleVersionStep(client, { index, working: null, published: null });
  const path = '/api/v1/articles/7001/translations/en-US';
  fake.failNext({ path, status: 429, headers: { 'Retry-After': '2' } });
  await expect(readZohoArticleVersionStep(client, first.state)).rejects.toMatchObject({
    name: 'RateLimited',
  });
  fake.fixture.articles![1]!.translationId = '9999';
  // A new test connection has a fresh limiter; persisted source metadata is unchanged.
  await expect(
    readZohoArticleVersionStep(zohoTestConnection(fake).client, first.state),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
