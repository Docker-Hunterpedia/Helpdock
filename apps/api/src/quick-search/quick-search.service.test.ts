import type { DbTransaction } from '@helpdock/db';
import type { ContactList, TicketList } from '@helpdock/schemas';
import { HttpException, Logger } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactsService } from '../contacts/contacts.service.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import type { HelpCenterSearch, SearchQuery } from '../help-center/ports.js';
import type { TicketsService } from '../tickets/tickets.service.js';
import {
  QUICK_SEARCH_RULE,
  type QuickSearchScope,
  QuickSearchService,
  SECTION_BUDGET_MS,
} from './quick-search.service.js';

const BRAND_ID = '0190a000-0000-7000-8000-000000000001';
const VIEWER_ID = '0190a000-0000-7000-8000-000000000002';
const TICKET_ID = '0190a000-0000-7000-8000-000000000003';
const CONTACT_ID = '0190a000-0000-7000-8000-000000000004';
const ARTICLE_ID = '0190a000-0000-7000-8000-000000000005';
const DRAFT_ID = '0190a000-0000-7000-8000-000000000006';

const EVERYTHING: QuickSearchScope = {
  brandId: BRAND_ID,
  viewerId: VIEWER_ID,
  can: { tickets: true, contacts: true, articles: true, manageArticles: true },
};

const dialect = new PgDialect();

/** A transaction that records the statements it was given and answers the two reads the service makes itself. */
const fakeTransaction = (drafts: readonly Record<string, unknown>[] = []) => {
  const statements: string[] = [];
  const tx: { execute: unknown; transaction: unknown } = {
    transaction: vi.fn(async (run: (nested: unknown) => Promise<unknown>) => {
      statements.push('nested transaction');
      return run(tx);
    }),
    execute: vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const text = dialect.sqlToQuery(query).sql;
      statements.push(text);
      if (text.includes('current_setting')) {
        return [{ timeout: '0' }];
      }
      return text.includes('hc_article_versions') ? drafts : [];
    }),
  };
  return { tx: tx as unknown as DbTransaction, statements };
};

const ticketList = (subjects: readonly string[]): TicketList =>
  ({
    tickets: subjects.map((subject) => ({
      id: TICKET_ID,
      number: 1042,
      prefix: 'HD',
      subject,
      status: { name: 'Open' },
    })),
    nextCursor: null,
  }) as unknown as TicketList;

const contactList = (): ContactList =>
  ({
    contacts: [
      { id: CONTACT_ID, name: 'Mona Khalil', primaryIdentity: { value: 'mona@example.com' } },
      { id: CONTACT_ID, name: 'Anonymous', primaryIdentity: null },
    ],
    total: 2,
    nextCursor: null,
    duplicateCount: 0,
  }) as unknown as ContactList;

interface Doubles {
  readonly tickets?: () => Promise<TicketList>;
  readonly contacts?: () => Promise<ContactList>;
  readonly articles?: (query: SearchQuery) => Promise<{ hits: never[]; total: number }>;
  readonly allowed?: boolean;
  readonly drafts?: readonly Record<string, unknown>[];
}

const run = async (scope: QuickSearchScope, doubles: Doubles = {}) => {
  const { tx, statements } = fakeTransaction(doubles.drafts);
  const list = vi.fn(doubles.tickets ?? (async () => ticketList(['Refund not received'])));
  const contacts = vi.fn(doubles.contacts ?? (async () => contactList()));
  const search = vi.fn(doubles.articles ?? (async () => ({ hits: [], total: 0 })));
  const consume = vi.fn(async () => doubles.allowed ?? true);
  const service = new QuickSearchService(
    { list } as unknown as TicketsService,
    { list: contacts } as unknown as ContactsService,
    { search } as unknown as HelpCenterSearch,
    { consume },
  );
  const context = new RequestContext({ requestId: 'quick-search', method: 'GET', path: '/' });
  context.tx = tx;
  context.principal = {
    type: 'staff',
    id: VIEWER_ID,
    installAdmin: false,
    brands: { [BRAND_ID]: { role: 'agent', departmentIds: 'all' } },
  };
  context.targetBrandId = BRAND_ID;
  const result = await runInRequestContext(context, () =>
    service.search(scope, { q: '1042', limit: 5, locale: 'en' }).then(
      (found) => ({ found }),
      (error: unknown) => ({ error }),
    ),
  );
  return { result, statements, list, contacts, search, consume };
};

beforeEach(() => {
  // A failed section is logged; the tests that make one fail do not need the line.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('QuickSearchService', () => {
  it('answers tickets, contacts and articles, each trimmed to what a row needs', async () => {
    const { result, list, contacts, search } = await run(EVERYTHING, {
      articles: async () => ({
        hits: [
          {
            articleId: ARTICLE_ID,
            title: 'Refund policy',
            slug: 'refund',
            locale: 'en',
            snippet: 'x',
            sectionTitle: 's',
          },
        ] as never[],
        total: 1,
      }),
    });

    expect(result).toEqual({
      found: {
        tickets: {
          status: 'ok',
          items: [{ id: TICKET_ID, number: 1042, prefix: 'HD', subject: 'Refund not received' }],
        },
        contacts: {
          status: 'ok',
          items: [
            { id: CONTACT_ID, name: 'Mona Khalil', identity: 'mona@example.com' },
            { id: CONTACT_ID, name: 'Anonymous', identity: null },
          ],
        },
        articles: {
          status: 'ok',
          items: [{ id: ARTICLE_ID, title: 'Refund policy', status: 'published' }],
        },
      },
    });
    expect(list).toHaveBeenCalledWith(
      { brandId: BRAND_ID, viewerId: VIEWER_ID },
      expect.objectContaining({ q: '1042', limit: 5 }),
      { withContacts: false },
    );
    expect(contacts).toHaveBeenCalledWith(expect.anything(), { search: '1042', limit: 5 });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'internal', log: false, q: '1042', limit: 5 }),
    );
  });

  it('skips a section the person may not read without calling its source', async () => {
    const { result, list, contacts, search, statements } = await run({
      ...EVERYTHING,
      can: { tickets: false, contacts: false, articles: false, manageArticles: false },
    });

    expect(result).toEqual({
      found: {
        tickets: { status: 'skipped' },
        contacts: { status: 'skipped' },
        articles: { status: 'skipped' },
      },
    });
    expect([list, contacts, search].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    expect(statements).toEqual([]);
  });

  it('marks a section that errors as failed, rolls its savepoint back and still answers the others', async () => {
    const { result, statements } = await run(EVERYTHING, {
      contacts: async () => {
        throw new Error('statement timeout');
      },
    });

    expect(result).toMatchObject({
      found: {
        tickets: { status: 'ok' },
        contacts: { status: 'failed' },
        articles: { status: 'ok' },
      },
    });
    expect(statements.filter((text) => text === 'nested transaction')).toHaveLength(3);
  });

  it('marks a section that outlasts its budget as failed', async () => {
    vi.useFakeTimers();
    const pending = run(EVERYTHING, { articles: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(SECTION_BUDGET_MS + 1);
    const { result } = await pending;

    expect(result).toMatchObject({
      found: { tickets: { status: 'ok' }, articles: { status: 'failed' } },
    });
  });

  it('refuses with 429 and reads nothing once the person is over their rate', async () => {
    const { result, list, consume } = await run(EVERYTHING, { allowed: false });

    expect(result).toMatchObject({ error: expect.any(HttpException) });
    expect((result as { error: HttpException }).error.getStatus()).toBe(429);
    expect(consume).toHaveBeenCalledWith(QUICK_SEARCH_RULE, VIEWER_ID);
    expect(list).not.toHaveBeenCalled();
  });

  it('adds draft titles for who manages articles, never twice and within the limit', async () => {
    const { result } = await run(EVERYTHING, {
      articles: async () => ({
        hits: [{ articleId: ARTICLE_ID, title: 'Refund policy' }] as never[],
        total: 1,
      }),
      drafts: [
        { article_id: ARTICLE_ID, title: 'Refund policy', status: 'draft' },
        { article_id: DRAFT_ID, title: 'Refund draft', status: 'scheduled' },
      ],
    });

    expect(result).toMatchObject({
      found: {
        articles: {
          items: [
            { id: ARTICLE_ID, status: 'published' },
            { id: DRAFT_ID, title: 'Refund draft', status: 'scheduled' },
          ],
        },
      },
    });
  });

  it('does not read drafts for somebody who cannot manage articles', async () => {
    const { statements } = await run({
      ...EVERYTHING,
      can: { ...EVERYTHING.can, manageArticles: false },
    });

    expect(statements.some((text) => text.includes('hc_article_versions'))).toBe(false);
  });
});
