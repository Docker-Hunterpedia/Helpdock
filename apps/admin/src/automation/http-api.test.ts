import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpAutomationApi } from './http-api.js';
import { MockAutomationApi } from './mock-api.js';

/**
 * The adapter against a stubbed `fetch`: which route each call reaches, what
 * it sends, and that every answer is parsed through the api's own schema.
 * The fixture supplies well-formed bodies.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpAutomationApi;
const fixture = new MockAutomationApi();

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpAutomationApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; method: string; body: unknown } => {
  const [url, init] = (fetchMock.mock.calls.at(-1) ?? []) as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('HttpAutomationApi', () => {
  it('reads the rules, of one kind when asked', async () => {
    const list = await fixture.rules(BRAND, 'scheduled');
    fetchMock.mockResolvedValue(json(list));

    await expect(api.rules(BRAND, 'scheduled')).resolves.toEqual(list);
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/rules?kind=scheduled`,
      method: 'GET',
    });
  });

  it('creates with POST, saves with PUT, toggles with PATCH and deletes', async () => {
    const [rule] = (await fixture.rules(BRAND)).rules;
    if (rule === undefined) {
      throw new Error('the fixture has no rules');
    }
    fetchMock.mockImplementation(() => Promise.resolve(json(rule)));

    await api.createRule(BRAND, { ...rule, description: null });
    expect(lastCall()).toMatchObject({ url: `/api/brands/${BRAND}/rules`, method: 'POST' });

    await api.updateRule(BRAND, rule.id, { ...rule, description: null });
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/rules/${rule.id}`,
      method: 'PUT',
    });

    await api.setRuleEnabled(BRAND, rule.id, false);
    expect(lastCall()).toMatchObject({ method: 'PATCH', body: { enabled: false } });

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.deleteRule(BRAND, rule.id);
    expect(lastCall()).toMatchObject({ method: 'DELETE' });
  });

  it('sends a reorder as the whole list of one kind', async () => {
    const list = await fixture.rules(BRAND, 'event');
    fetchMock.mockResolvedValue(json(list));
    const ids = list.rules.map((rule) => rule.id);

    await api.reorderRules(BRAND, 'event', ids);
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/rules/reorder`,
      method: 'POST',
      body: { kind: 'event', ruleIds: ids },
    });
  });

  it('filters the log only by what was asked', async () => {
    const runs = await fixture.runs(BRAND, {});
    fetchMock.mockImplementation(() => Promise.resolve(json(runs)));

    await api.runs(BRAND, {});
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/rules/runs`);

    await api.runs(BRAND, { result: 'stopped', q: 'HD-1041' });
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/rules/runs?result=stopped&q=HD-1041`);
  });

  it('reads the builder options, and test-runs a draft', async () => {
    fetchMock.mockResolvedValue(json(await fixture.options(BRAND)));
    await api.options(BRAND);
    expect(lastCall().url).toBe(`/api/brands/${BRAND}/rules/options`);

    fetchMock.mockResolvedValue(json({ outcome: null }));
    const draft = {
      name: 'Draft',
      kind: 'event' as const,
      trigger: 'ticket_created' as const,
      conditions: { match: 'all' as const, groups: [] },
      actions: [{ type: 'escalate' as const }],
    };
    await expect(api.testRun(BRAND, { rule: draft, ticket: 'HD-1' })).resolves.toEqual({
      outcome: null,
    });
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND}/rules/test-run`,
      method: 'POST',
    });
  });

  it('refuses an answer that is not the declared shape', async () => {
    fetchMock.mockResolvedValue(json({ rules: [{ id: 'nope' }] }));

    await expect(api.rules(BRAND)).rejects.toThrow();
  });
});
