import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpQuickSearchApi, MockQuickSearchApi } from './api.js';

const BRAND_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET_ID = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
const CONTACT_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
const ARTICLE_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';

const answer = {
  tickets: {
    status: 'ok',
    items: [{ id: TICKET_ID, number: 1042, prefix: 'HD', subject: 'Refund' }],
  },
  contacts: { status: 'skipped' },
  articles: { status: 'failed' },
};

describe('HttpQuickSearchApi', () => {
  it('asks the brand’s quick-search with the query, limit, locale and the caller’s signal', async () => {
    const request = vi.spyOn(HttpTransport.prototype, 'request').mockResolvedValue(answer);
    const controller = new AbortController();

    const found = await new HttpQuickSearchApi().search(
      BRAND_ID,
      { q: 'a&b c', limit: 5, locale: 'ar' },
      controller.signal,
    );

    expect(request).toHaveBeenCalledWith(
      'GET',
      `/brands/${BRAND_ID}/quick-search?q=a%26b+c&limit=5&locale=ar`,
      undefined,
      { signal: controller.signal },
    );
    expect(found.tickets.status).toBe('ok');
    request.mockRestore();
  });

  it('refuses an answer that is not the contract', async () => {
    const request = vi
      .spyOn(HttpTransport.prototype, 'request')
      .mockResolvedValue({ tickets: { status: 'late' } });

    await expect(
      new HttpQuickSearchApi().search(BRAND_ID, { q: 'a', limit: 5, locale: 'en' }),
    ).rejects.toThrow();
    request.mockRestore();
  });
});

const sources = () => ({
  tickets: {
    list: vi.fn(async () => ({
      tickets: [{ id: TICKET_ID, number: 1042, prefix: 'HD', subject: 'Refund' }],
      nextCursor: null,
    })),
  },
  contacts: {
    listContacts: vi.fn(async () => ({
      contacts: [{ id: CONTACT_ID, name: 'Mona', primaryIdentity: { value: 'mona@example.com' } }],
      total: 1,
      nextCursor: null,
      duplicateCount: 0,
    })),
  },
  helpCenter: {
    structure: vi.fn(async () => ({
      articles: [
        {
          id: ARTICLE_ID,
          versions: [
            { locale: 'en', status: 'draft', title: 'Refund policy' },
            { locale: 'ar', status: 'archived', title: 'Refund old' },
          ],
        },
      ],
    })),
  },
});

type MockSources = ConstructorParameters<typeof MockQuickSearchApi>[0];
const mockApi = (role: 'admin' | 'agent' = 'admin') =>
  new MockQuickSearchApi(sources() as unknown as MockSources, () => role);

describe('MockQuickSearchApi', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers the three sections from the fixtures, a draft title only for who manages articles', async () => {
    const admin = await mockApi('admin').search(BRAND_ID, { q: 'refund', limit: 5, locale: 'en' });
    const agent = await mockApi('agent').search(BRAND_ID, { q: 'refund', limit: 5, locale: 'en' });

    expect(admin.tickets).toEqual({
      status: 'ok',
      items: [{ id: TICKET_ID, number: 1042, prefix: 'HD', subject: 'Refund' }],
    });
    expect(admin.contacts).toEqual({
      status: 'ok',
      items: [{ id: CONTACT_ID, name: 'Mona', identity: 'mona@example.com' }],
    });
    expect(admin.articles).toEqual({
      status: 'ok',
      items: [{ id: ARTICLE_ID, title: 'Refund policy', status: 'draft' }],
    });
    expect(agent.articles).toEqual({ status: 'ok', items: [] });
  });

  it('fails a section on request, and says nothing of it in the others', async () => {
    const api = mockApi();
    api.failSection('contacts');

    const found = await api.search(BRAND_ID, { q: 'refund', limit: 5, locale: 'en' });

    expect(found.contacts).toEqual({ status: 'failed' });
    expect(found.tickets.status).toBe('ok');
  });

  it('fails the sections a test seeds in storage', async () => {
    localStorage.setItem('helpdock.mock.quickSearchFail', 'tickets,articles');

    const found = await mockApi().search(BRAND_ID, { q: 'refund', limit: 5, locale: 'en' });

    expect([found.tickets.status, found.contacts.status, found.articles.status]).toEqual([
      'failed',
      'ok',
      'failed',
    ]);
  });

  it('stops when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      mockApi().search(BRAND_ID, { q: 'refund', limit: 5, locale: 'en' }, controller.signal),
    ).rejects.toBeDefined();
  });
});
