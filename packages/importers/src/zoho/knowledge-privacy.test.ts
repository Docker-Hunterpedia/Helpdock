import { afterEach, beforeEach, expect, it } from 'vitest';
import { type ZohoKnowledgePrivacy, zohoKnowledgePrivacyStep } from './knowledge-privacy.js';
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

function initial(nextId = '4002'): ZohoKnowledgePrivacy {
  return { rootId: '2001', nextId, seen: [], internal: false, draft: false };
}

it('retains inherited restrictions across serialized ancestor checkpoints without inventing local membership', async () => {
  const { client } = zohoTestConnection(fake);
  const first = await zohoKnowledgePrivacyStep(client, initial());
  expect(first).toMatchObject({ nextId: '4001', seen: ['4002'], internal: true, draft: true });
  const second = await zohoKnowledgePrivacyStep(client, JSON.parse(JSON.stringify(first)));
  const final = await zohoKnowledgePrivacyStep(client, JSON.parse(JSON.stringify(second)));
  expect(final).toEqual({
    rootId: '2001',
    nextId: null,
    seen: ['4002', '4001', '2001'],
    internal: true,
    draft: true,
  });
});

it('allows public ancestors but treats a restricted root as internal even when its child is public', async () => {
  const { client } = zohoTestConnection(fake);
  const section = await zohoKnowledgePrivacyStep(client, initial('4001'));
  expect(section).toMatchObject({ internal: false, draft: false });
  fake.fixture.kbRoots![0]!.visibility = 'PRIVATE_IP';
  expect(await zohoKnowledgePrivacyStep(client, section)).toMatchObject({
    nextId: null,
    internal: true,
    draft: false,
  });
});

it('refuses cross-root parents and ancestor cycles instead of publishing a partial privacy result', async () => {
  const { client } = zohoTestConnection(fake);
  fake.fixture.kbSections![0]!.parentCategoryId = '4002';
  let state = await zohoKnowledgePrivacyStep(client, initial());
  state = await zohoKnowledgePrivacyStep(client, state);
  await expect(zohoKnowledgePrivacyStep(client, state)).rejects.toMatchObject({
    code: 'invalid-response',
  });
  fake.fixture.kbSections![1]!.rootCategoryId = '2002';
  await expect(zohoKnowledgePrivacyStep(client, initial())).rejects.toMatchObject({
    code: 'invalid-response',
  });
});
