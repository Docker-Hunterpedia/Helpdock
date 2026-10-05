import { describe, expect, it } from 'vitest';
import { fakeService } from './fake-service.js';
import { browseNotion, exchangeNotionCode, loadNotion, notionAuthorizeUrl } from './notion.js';
import { ConnectorAuthError, type ConnectorEvent } from './types.js';

const BASE = 'https://notion.fake';

const page = (id: string, title: string) => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${id}`,
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: '2026-01-01T00:00:00.000Z',
  properties: {
    Name: { id: 'title', type: 'title', title: [{ type: 'text', plain_text: title }] },
  },
  parent: { type: 'workspace', workspace: true },
});

const markdown = (id: string, text: string) => ({
  object: 'page_markdown',
  id,
  markdown: text,
  truncated: false,
  unknown_block_ids: [],
});

const collect = async (generator: AsyncGenerator<ConnectorEvent>) => {
  const events: ConnectorEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
};

describe('loadNotion', () => {
  const service = fakeService({
    'GET /v1/pages/p1': { status: 200, json: page('p1', 'Playbook') },
    'GET /v1/pages/p1/markdown': {
      status: 200,
      json: markdown('p1', '# Escalation\n\nCall the lead.'),
    },
    'GET /v1/pages/p2': { status: 200, json: page('p2', 'Row') },
    'GET /v1/pages/p2/markdown': { status: 200, json: markdown('p2', 'A row page.') },
    'GET /v1/pages/p3': {
      status: 404,
      json: { object: 'error', code: 'object_not_found', message: 'gone' },
    },
    'GET /v1/databases/db1': {
      status: 200,
      json: {
        object: 'database',
        id: 'db1',
        title: [],
        data_sources: [{ id: 'ds1', name: 'Rows' }],
        properties: {},
        parent: { type: 'workspace', workspace: true },
        created_time: '2026-01-01T00:00:00.000Z',
        last_edited_time: '2026-01-01T00:00:00.000Z',
        is_inline: false,
        in_trash: false,
        is_locked: false,
        url: 'https://www.notion.so/db1',
        public_url: null,
        icon: null,
        cover: null,
        description: [],
      },
    },
    'POST /v1/data_sources/ds1/query': {
      status: 200,
      json: {
        object: 'list',
        results: [page('p2', 'Row'), page('p1', 'Playbook')],
        has_more: false,
        next_cursor: null,
      },
    },
  });

  it('reads picked pages and every page of a picked database as Markdown, once each', async () => {
    const events = await collect(
      loadNotion(
        { pageIds: ['p1', 'p3'], databaseIds: ['db1'] },
        { token: 'secret_token', fetch: service.fetch, baseUrl: BASE },
        { maxPages: 10 },
      ),
    );

    expect(events).toEqual([
      {
        type: 'document',
        externalId: 'p1',
        url: 'https://www.notion.so/p1',
        document: { title: 'Playbook', parts: [{ text: '# Escalation\n\nCall the lead.' }] },
      },
      { type: 'skipped', externalId: 'p3', name: 'p3', detail: expect.any(String) },
      {
        type: 'document',
        externalId: 'p2',
        url: 'https://www.notion.so/p2',
        document: { title: 'Row', parts: [{ text: 'A row page.' }] },
      },
    ]);
    expect(service.requests[0]?.headers.authorization).toBe('Bearer secret_token');
  });

  it('stops at the page limit', async () => {
    const events = await collect(
      loadNotion(
        { pageIds: ['p1'], databaseIds: ['db1'] },
        { token: 't', fetch: service.fetch, baseUrl: BASE },
        { maxPages: 1 },
      ),
    );

    expect(events.map((event) => event.externalId)).toEqual(['p1']);
  });

  it('reports a revoked token as an auth error, so the source asks to reconnect', async () => {
    const revoked = fakeService({
      'GET /v1/pages/p1': {
        status: 401,
        json: { object: 'error', code: 'unauthorized', message: 'API token is invalid.' },
      },
    });

    await expect(
      collect(
        loadNotion(
          { pageIds: ['p1'], databaseIds: [] },
          { token: 't', fetch: revoked.fetch, baseUrl: BASE },
          { maxPages: 5 },
        ),
      ),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe('browseNotion', () => {
  it('lists the pages and databases the token can see', async () => {
    const service = fakeService({
      'POST /v1/search': {
        status: 200,
        json: {
          object: 'list',
          has_more: false,
          next_cursor: null,
          results: [
            page('p1', 'Playbook'),
            {
              object: 'data_source',
              id: 'ds1',
              title: [{ type: 'text', plain_text: 'FAQ' }],
              parent: { type: 'database_id', database_id: 'db1' },
              properties: {},
            },
          ],
        },
      },
    });

    expect(await browseNotion({ token: 't', fetch: service.fetch, baseUrl: BASE }, 'play')).toEqual(
      [
        { id: 'p1', title: 'Playbook', kind: 'page' },
        { id: 'db1', title: 'FAQ', kind: 'database' },
      ],
    );
    expect(JSON.parse(service.requests[0]?.body ?? '{}')).toMatchObject({ query: 'play' });
  });
});

describe('Notion OAuth', () => {
  const app = { clientId: 'client', clientSecret: 'shh' };

  it('builds the authorize URL with the state', () => {
    const url = new URL(notionAuthorizeUrl(app, 'https://support.test/cb', 'state-1'));

    expect(url.origin + url.pathname).toBe('https://api.notion.com/v1/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client',
      response_type: 'code',
      owner: 'user',
      redirect_uri: 'https://support.test/cb',
      state: 'state-1',
    });
  });

  it('exchanges a code for tokens with the client credentials', async () => {
    const service = fakeService({
      'POST /v1/oauth/token': {
        status: 200,
        json: { access_token: 'ntn_access', refresh_token: 'ntn_refresh', token_type: 'bearer' },
      },
    });

    const tokens = await exchangeNotionCode(
      app,
      { code: 'code-1', redirectUri: 'https://support.test/cb' },
      { fetch: service.fetch, baseUrl: BASE },
    );

    expect(tokens).toEqual({
      accessToken: 'ntn_access',
      refreshToken: 'ntn_refresh',
      expiresAt: null,
    });
    expect(service.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('client:shh').toString('base64')}`,
    );
  });
});
