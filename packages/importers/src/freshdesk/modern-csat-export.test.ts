import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectAsync } from '../testing/collect.js';
import { FreshdeskClient } from './client.js';
import { exportFreshdeskModernCsat } from './modern-csat-export.js';
import { freshdeskTestContext } from './testing/context.js';
import { FakeFreshdesk, type FreshdeskFixture } from './testing/fake-freshdesk.js';

const surveyId = 'e0de74e5-215c-4ee2-8668-3c9f405cc881';
const path = `/api/v2/customer-satisfaction/surveys/${surveyId}/responses`;
const response = {
  id: '_4-62',
  survey_id: surveyId,
  survey_version_id: 'V1',
  user_id: '566186',
  agent_id: '566184',
  group_id: null,
  ticket_id: 1,
  status: 'COMPLETE',
  answers: [
    { question_id: 'Q_1', question_text: 'How was the support?', value: 7 },
    { question_id: 'Q_23', question_text: 'Your feedback', value: 'Great support experience!' },
    { question_id: 'Q_20', question_text: 'Reasons', value: ['1', '2'] },
  ],
  created_at: '2020-02-02T17:09:45.703Z',
  updated_at: '2020-02-02T17:09:45.703Z',
};
const fixture: FreshdeskFixture = {
  surveys: [{ id: surveyId, title: 'Support feedback', state: 'active' }],
  survey_responses: {
    [surveyId]: [response, { ...response, id: '_4-63', ticket_id: 2, status: 'PARTIAL' }],
  },
};
let fake: FakeFreshdesk;
let client: FreshdeskClient;
const log = vi.fn(async () => {});
beforeEach(async () => {
  log.mockClear();
  fake = new FakeFreshdesk(fixture, {
    authorization: `Basic ${Buffer.from('synthetic-key:X').toString('base64')}`,
    now: 0,
    pageSize: 1,
  });
  await fake.server.start();
  client = new FreshdeskClient(freshdeskTestContext(fake, log), fake.server.root);
});
afterEach(async () => {
  await fake.server.close();
});

it('preserves all answer types, original dates and partial responses without interpreting an unknown historical scale', async () => {
  const pages = await collectAsync(exportFreshdeskModernCsat(client, null));
  expect(pages.flatMap((page) => page.records)).toMatchObject([
    {
      entity: 'csat',
      payload: {
        rating: null,
        ratedAt: response.created_at,
        sourceDetails: {
          ratingUnmapped: true,
          originalAnswers: response.answers,
          surveyVersionId: 'V1',
          responseStatus: 'COMPLETE',
        },
      },
    },
    {
      entity: 'csat',
      payload: { ticketExternalId: '2', sourceDetails: { responseStatus: 'PARTIAL' } },
    },
  ]);
  expect(log).toHaveBeenCalledWith({
    level: 'warning',
    entity: 'csat',
    message: 'import.csat.rating-unmapped',
  });
  expect(
    fake.server.calls.every(
      (call) => call.method === 'GET' && call.query.created_since === undefined,
    ),
  ).toBe(true);
});

it('resumes a serialized response checkpoint and rescans edited old responses on the next extraction', async () => {
  const iterator = exportFreshdeskModernCsat(client, null);
  const first = await iterator.next();
  await iterator.return(undefined);
  const remainder = await collectAsync(
    exportFreshdeskModernCsat(client, JSON.parse(JSON.stringify(first.value?.cursor))),
  );
  expect(remainder.flatMap((page) => page.records)).toMatchObject([
    { payload: { ticketExternalId: '2' } },
  ]);
  fake.replaceFixture({
    ...fixture,
    survey_responses: {
      [surveyId]: [
        {
          ...response,
          updated_at: '2026-10-17T00:00:00Z',
          answers: [
            {
              ...response.answers[0],
              question_id: 'Q_1',
              question_text: 'How was the support?',
              value: 2,
            },
          ],
        },
      ],
    },
  });
  const delta = await collectAsync(exportFreshdeskModernCsat(client, null));
  expect(delta.flatMap((page) => page.records)).toMatchObject([
    {
      payload: {
        externalId: `modern:${surveyId}:_4-62`,
        sourceDetails: { originalAnswers: [{ value: 2 }] },
      },
    },
  ]);
});

it.each([401, 403, 429, 503])(
  'propagates HTTP %s without treating access or rate errors as an empty survey',
  async (status) => {
    fake.server.failNext({ path, status, json: {}, headers: { 'retry-after': '3' } });
    await expect(collectAsync(exportFreshdeskModernCsat(client, null))).rejects.toMatchObject({
      name: status === 429 ? 'RateLimited' : 'ConnectorError',
    });
  },
);

it.each([
  'https://outside.example/api/v2/customer-satisfaction/surveys?next_token=secret',
  `/api/v2/contacts?next_token=secret`,
  `http://user:secret@127.0.0.1/steal?next_token=secret`,
])('refuses a continuation that could redirect account authorization: %s', async (next) => {
  fake.server.failNext({
    path,
    status: 200,
    json: {
      data: [response],
      paging: { next: next.startsWith('/') ? `${fake.server.root}${next}` : next, previous: null },
    },
  });
  await expect(collectAsync(exportFreshdeskModernCsat(client, null))).rejects.toThrow();
  expect(fake.server.calls.some((call) => call.path === '/api/v2/contacts')).toBe(false);
});

it('refuses a response belonging to another survey', async () => {
  fake.replaceFixture({
    ...fixture,
    survey_responses: {
      [surveyId]: [{ ...response, survey_id: '0193b000-0000-7000-8000-000000000911' }],
    },
  });
  await expect(collectAsync(exportFreshdeskModernCsat(client, null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('stops a nontrivial token cycle instead of accumulating or looping over repeated pages', async () => {
  const page = (token: string) => ({
    data: [response],
    paging: { next: `${fake.server.root}${path}?per_page=100&next_token=${token}`, previous: null },
  });
  for (const next of ['a', 'b', 'c', 'a', 'b', 'c'])
    fake.server.failNext({ path, status: 200, json: page(next) });
  await expect(collectAsync(exportFreshdeskModernCsat(client, null))).rejects.toMatchObject({
    code: 'invalid-response',
  });
  expect(fake.server.calls.filter((call) => call.path === path)).toHaveLength(6);
});
