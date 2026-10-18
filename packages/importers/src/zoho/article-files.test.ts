import { afterEach, beforeEach, expect, it } from 'vitest';
import { zohoArticleSchema } from './article-contracts.js';
import { initialZohoArticleFilesScan, readZohoArticleFilesStep } from './article-files.js';
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
  const article = fake.fixture.articles![0]!,
    template = article.attachments[0]!;
  article.attachments = Array.from({ length: 31 }, (_, index) => {
    const resourceId = `native${index}`;
    const bytes = Buffer.from('original file');
    const url = fake.addArticleAttachment(
      { articleId: article.id, locale: article.locale, resourceId },
      bytes,
    );
    return {
      ...template,
      resourceId,
      size: String(bytes.length),
      viewUrl: url,
      downloadUrl: `${url}?inline=false`,
    };
  });
});
afterEach(async () => {
  await fake.close();
});

it.each(['single', 'data'] as const)(
  'reconciles every file across serialized one-item pages using the %s envelope',
  async (envelope) => {
    fake.articleAttachmentEnvelope = envelope;
    const logs: string[] = [];
    const { client } = zohoTestConnection(fake, {
      log: async (entry) => {
        logs.push(entry.message);
      },
    });
    const article = zohoArticleSchema.parse(fake.fixture.articles![0]);
    let scan = initialZohoArticleFilesScan();
    while (true) {
      const page = await readZohoArticleFilesStep(
        client,
        article,
        JSON.parse(JSON.stringify(scan)),
      );
      scan = page.next;
      if (page.done) break;
    }
    expect(scan.seen).toEqual(article.attachments.map((file) => file.resourceId));
    expect(scan.from).toBe(32);
    expect(logs).toEqual(
      envelope === 'data' ? ['import.zoho.article-files-envelope-inferred'] : [],
    );
  },
);

it('refuses an incomplete list instead of silently dropping files from the detail snapshot', async () => {
  const { client } = zohoTestConnection(fake);
  const article = zohoArticleSchema.parse(fake.fixture.articles![0]);
  fake.failNext({ path: '/api/v1/articles/7001/translations/en-US/attachments', status: 204 });
  await expect(
    readZohoArticleFilesStep(client, article, initialZohoArticleFilesScan()),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('refuses a repeated or changed file page on resume without claiming the file set is complete', async () => {
  const { client } = zohoTestConnection(fake);
  const article = zohoArticleSchema.parse(fake.fixture.articles![0]);
  const first = await readZohoArticleFilesStep(client, article, initialZohoArticleFilesScan());
  fake.fixture.articles![0]!.attachments[1] = structuredClone(
    fake.fixture.articles![0]!.attachments[0]!,
  );
  await expect(readZohoArticleFilesStep(client, article, first.next)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('refuses source changes after the list even when the pinned version label has not changed', async () => {
  fake.fixture.articles![0]!.attachments = [];
  const article = zohoArticleSchema.parse(fake.fixture.articles![0]);
  fake.fixture.articles![0]!.answer = '<p>Different source content</p>';
  await expect(
    readZohoArticleFilesStep(
      zohoTestConnection(fake).client,
      article,
      initialZohoArticleFilesScan(),
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

it('keeps its durable file offset after a rate limit and resumes at the next native resource', async () => {
  const article = zohoArticleSchema.parse(fake.fixture.articles![0]);
  const { client } = zohoTestConnection(fake);
  const first = await readZohoArticleFilesStep(client, article, initialZohoArticleFilesScan());
  fake.failNext({
    path: '/api/v1/articles/7001/translations/en-US/attachments',
    status: 429,
    headers: { 'Retry-After': '2' },
  });
  await expect(readZohoArticleFilesStep(client, article, first.next)).rejects.toMatchObject({
    name: 'RateLimited',
  });
  const resumed = await readZohoArticleFilesStep(
    zohoTestConnection(fake).client,
    article,
    first.next,
  );
  expect(resumed.next.seen).toEqual(['native0', 'native1']);
});
