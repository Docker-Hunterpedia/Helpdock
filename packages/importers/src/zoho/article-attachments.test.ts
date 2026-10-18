import { afterEach, beforeEach, expect, it } from 'vitest';
import { fetchZohoArticleAttachment, zohoArticleAttachmentRefs } from './article-attachments.js';
import { zohoArticleSchema } from './article-contracts.js';
import { zohoArticleFixture } from './testing/article-fixture.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
const bytes = Buffer.from('%PDF-1.7\nOriginal historical manual');
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

function fileFixture() {
  const row = fake.fixture.articles![0]!,
    file = row.attachments[0]!;
  const url = fake.addArticleAttachment(
    { articleId: row.id, locale: row.locale, resourceId: file.resourceId },
    bytes,
  );
  file.size = String(bytes.length);
  file.viewUrl = `${url}?orgId=${fake.fixture.orgId}`;
  file.downloadUrl = `${url}?orgId=${fake.fixture.orgId}&inline=false`;
  const { client } = zohoTestConnection(fake);
  const [ref] = zohoArticleAttachmentRefs(client, zohoArticleSchema.parse(row));
  if (!ref) throw new Error('Missing article attachment');
  return { client, ref, row, file, path: new URL(url).pathname };
}

it('preserves view/download aliases while sending credentials only to the exact article resource', async () => {
  const { client, ref, path } = fileFixture();
  expect(ref.sourceUrls).toHaveLength(2);
  const downloaded = await fetchZohoArticleAttachment(client, ref);
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(fake.calls.filter((call) => call.authenticated).map((call) => call.path)).toEqual([path]);
});

it('maps legacy display URLs without requesting them or allowing a foreign-origin alias', async () => {
  const { client, row, file } = fileFixture();
  file.viewUrl = `${fake.root}/support/DocsDisplay?attachId=old&action=view&zgId=group&entityId=entity`;
  file.downloadUrl = `${fake.root}/support/DocsDisplay?attachId=old&action=download&zgId=group&entityId=entity`;
  const [ref] = zohoArticleAttachmentRefs(client, zohoArticleSchema.parse(row));
  if (!ref) throw new Error('Missing legacy article file');
  (await fetchZohoArticleAttachment(client, ref)).stream.destroy();
  expect(fake.calls.some((call) => call.path.startsWith('/support/'))).toBe(false);
  file.viewUrl =
    'https://attacker.test/support/DocsDisplay?attachId=old&action=view&zgId=group&entityId=entity';
  expect(() => zohoArticleAttachmentRefs(client, zohoArticleSchema.parse(row))).toThrow();
});

it.each([403, 404, 410])(
  'refreshes pinned version metadata once after attachment HTTP %i without changing the public version',
  async (status) => {
    const { client, ref, path } = fileFixture();
    fake.failNext({ path, status });
    (await fetchZohoArticleAttachment(client, ref)).stream.destroy();
    const metadata = fake.calls.find(
      (call) => call.path === '/api/v1/articles/7001/translations/en-US',
    );
    expect(metadata?.query.version).toBe('2.1');
    expect(fake.calls.filter((call) => call.path === path)).toHaveLength(2);
  },
);

it('refuses a wrong-parent URL or alias before refreshing credentials', async () => {
  const { client, ref, path } = fileFixture();
  for (const forged of [
    { ...ref, url: `${fake.root}${path.replace('/7001/', '/9999/')}` },
    { ...ref, sourceUrls: [`${fake.root}${path}?inline=unexpected`] },
    { ...ref, sourceUrls: [`${fake.root}${path}?orgId=other`] },
  ])
    await expect(fetchZohoArticleAttachment(client, forged)).rejects.toMatchObject({
      code: 'invalid-response',
    });
  expect(fake.calls).toEqual([]);
});
