import type { ImportRecord } from '@helpdock/schemas';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImportCursor } from '../connector.js';
import { collectAsync } from '../testing/collect.js';
import { exportZohoCsat } from './csat-export.js';
import { zohoTestConnection } from './testing/context.js';
import { zohoCoreFixture } from './testing/core-fixture.js';
import { FakeZoho } from './testing/fake-zoho.js';

let fake: FakeZoho;
beforeEach(async () => {
  fake = new FakeZoho(structuredClone(zohoCoreFixture));
  await fake.start();
});
afterEach(async () => {
  await fake.close();
});

function answers(count = 51) {
  fake.fixture.feedback = Array.from({ length: count }, (_, index) => ({
    id: String(8000 + index),
    ticketId: zohoCoreFixture.tickets[0]!.id,
    threadId: String(9000 + index),
    agentId: '9007199254740993301',
    contactId: '9007199254740993201',
    departmentId: '9007199254740993401',
    accountId: '-1',
    rating: ['GOOD', 'OKAY', 'BAD', 'UNKNOWN'][index % 4]!,
    feedback: 'Short source preview',
    ratedTime: '2020-01-01T14:36:20.291Z',
    ...(index % 2 === 0 ? { customerRatedTime: '2020-01-01T09:06:20.291Z' } : {}),
    timezoneOffset: 'GMT +5:30',
  }));
  fake.fixture.feedbackContent = Object.fromEntries(
    fake.fixture.feedback.map((row) => [row.threadId, `Full original feedback ${row.id}`]),
  );
}

it('preserves full feedback, both source times and original sentiment without guessing timezone arithmetic', async () => {
  answers(4);
  const log = vi.fn(async () => {});
  const pages = await collectAsync(exportZohoCsat(zohoTestConnection(fake, { log }).client, null));
  const records = pages.flatMap((page) => page.records);
  expect(
    records.map((record) => (record.entity === 'csat' ? record.payload.rating : undefined)),
  ).toEqual([5, 3, 1, null]);
  expect(records[0]).toMatchObject({
    entity: 'csat',
    payload: {
      externalId: '8000',
      ticketExternalId: zohoCoreFixture.tickets[0]!.id,
      comment: 'Full original feedback 8000',
      ratedAt: '2020-01-01T09:06:20.291Z',
      sourceDetails: {
        originalRating: 'GOOD',
        ratedTime: '2020-01-01T14:36:20.291Z',
        customerRatedTime: '2020-01-01T09:06:20.291Z',
        timezoneOffset: 'GMT +5:30',
        ratedAtBasis: 'customerRatedTime',
        accountExternalId: '-1',
      },
    },
  });
  expect(records[1]).toMatchObject({
    payload: { ratedAt: '2020-01-01T14:36:20.291Z', sourceDetails: { ratedAtBasis: 'ratedTime' } },
  });
  expect(records[3]).toMatchObject({
    payload: { sourceDetails: { ratingUnmapped: true, originalRating: 'UNKNOWN' } },
  });
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'import.csat.rating-unmapped' }),
  );
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'import.csat.timestamp-inferred' }),
  );
});

it('checkpoints individual answers across the 50-answer page boundary and rescans old edits on a new extraction', async () => {
  answers();
  const { client } = zohoTestConnection(fake);
  let checkpoint: ImportCursor | null = null;
  const committed: ImportRecord[] = [];
  for await (const page of exportZohoCsat(client, null)) {
    committed.push(...page.records);
    checkpoint = page.cursor;
    if (committed.length === 17) break;
  }
  const resumed = await collectAsync(
    exportZohoCsat(client, JSON.parse(JSON.stringify(checkpoint))),
  );
  const records = [...committed, ...resumed.flatMap((page) => page.records)];
  expect(records).toHaveLength(51);
  expect(new Set(records.map((record) => record.payload.externalId)).size).toBe(51);
  fake.fixture.feedbackContent!['9000'] = 'Edited original answer';
  const delta = (await collectAsync(exportZohoCsat(client, null))).flatMap((page) => page.records);
  expect(delta[0]).toMatchObject({ payload: { comment: 'Edited original answer' } });
});

it('refuses a shifted source page after restart rather than applying an old offset to new answers', async () => {
  answers();
  const { client } = zohoTestConnection(fake);
  const iterator = exportZohoCsat(client, null);
  let checkpoint: ImportCursor | null = null;
  for await (const page of iterator) {
    checkpoint = page.cursor;
    if (page.records.length) break;
  }
  fake.fixture.feedback![0]!.rating = 'BAD';
  await expect(collectAsync(exportZohoCsat(client, checkpoint))).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it.each([429, 503])(
  'propagates a %s feedback-content failure so the worker can resume its uncommitted answer',
  async (status) => {
    answers(1);
    fake.failNext({
      path: '/api/v1/customerHappiness/9000/content',
      status,
      headers: { 'Retry-After': '3' },
    });
    await expect(
      collectAsync(exportZohoCsat(zohoTestConnection(fake).client, null)),
    ).rejects.toMatchObject(
      status === 429 ? { retryAfterMs: 3000 } : { code: 'vendor-unavailable' },
    );
  },
);
