import type {
  WidgetConversation as WireConversation,
  WidgetMessage as WireMessage,
} from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteTransport, type LiveSocket, secretKeyFor } from './remote.js';
import type { ConnectionState, WidgetEvent } from './types.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const API = 'https://support.example.com';
const SECRET = 'a'.repeat(43);

const conversation = (fields: Partial<WireConversation> = {}): WireConversation => ({
  id: CONVERSATION,
  reference: 'HD-1042',
  subject: 'Chat conversation',
  state: 'open',
  channel: 'chat',
  lastSeq: 0,
  continuedById: null,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  ...fields,
});

const message = (seq: number, fields: Partial<WireMessage> = {}): WireMessage => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-${String(seq).padStart(12, '0')}`,
  conversationId: CONVERSATION,
  seq,
  clientId: null,
  author: 'agent',
  agent: null,
  text: `message ${String(seq)}`,
  html: null,
  attachments: [],
  createdAt: '2026-09-27T10:00:00.000Z',
  ...fields,
});

type Handler = (body: unknown, url: URL) => unknown;

/** A fake api: `METHOD /path` → handler; the answer is JSON, a thrown error is the network. */
function fakeApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(`/api/widget/${BRAND}`, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, body, auth: headers.authorization ?? null });
    const handler = routes[`${method} ${url.hostname === 'bucket' ? 'bucket' : path}`];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    }
    const answer = handler(body, url);
    return answer instanceof Response
      ? answer
      : new Response(answer === undefined ? null : JSON.stringify(answer), {
          status: answer === undefined ? 204 : 200,
        });
  });
  return { fetch, calls };
}

function fakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    connected: false,
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    emitWithAck: vi.fn(async () => ({ ok: true, data: { lastSeq: 0 } })),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const fire = (event: string, payload?: unknown) => handlers.get(event)?.(payload);
  const envelope = (event: string, data: unknown, seq: number | null = null) =>
    fire(event, { seq, at: '2026-09-27T10:00:00.000Z', data });
  return { socket, fire, envelope };
}

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function networkEvents() {
  const listeners = new Map<string, () => void>();
  return {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: 'online' | 'offline') => listeners.get(type)?.(),
  };
}

describe('the remote transport', () => {
  it('keeps the issued secret to itself and resumes the open chat', async () => {
    const store = memoryStore();
    const api = fakeApi({
      'POST /session': () => ({ visitorId: BRAND, visitorSecret: SECRET, verified: false }),
      'GET /conversations': () => ({
        conversations: [
          conversation({ id: '0192c3f0-1a2b-7c3d-8e4f-000000000009', channel: 'email' }),
          conversation(),
        ],
      }),
      [`GET /conversations/${CONVERSATION}/queue`]: () => ({
        conversationId: CONVERSATION,
        position: 2,
      }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: store,
      fetch: api.fetch,
      network: null,
    });

    const session = await transport.startSession({
      user_id: 'u1',
      email: 'omar@example.com',
      ts: 1,
      signature: 'f'.repeat(64),
    });

    expect(session).toEqual({
      visitor_id: BRAND,
      conversation: expect.objectContaining({ id: CONVERSATION, status: 'queued' }),
    });
    expect(JSON.stringify(session)).not.toContain(SECRET);
    expect(store.getItem(secretKeyFor(BRAND))).toBe(SECRET);
    expect(api.calls[0]?.body).toEqual({
      identity: {
        payload: { user_id: 'u1', email: 'omar@example.com', ts: 1 },
        signature: 'f'.repeat(64),
      },
    });
    expect(api.calls[1]?.auth).toBe(`Visitor ${SECRET}`);
  });

  it('opens a conversation without text, and repeats the same clientId when a start is retried', async () => {
    let attempts = 0;
    const api = fakeApi({
      'POST /conversations': () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError('Failed to fetch');
        }
        return { conversation: conversation(), message: null };
      },
      [`GET /conversations/${CONVERSATION}/queue`]: () => ({
        conversationId: CONVERSATION,
        position: null,
      }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });
    const input = { name: 'Omar', email: 'omar@example.com', fields: { order: '42', note: ' ' } };

    await expect(transport.startConversation(input)).rejects.toMatchObject({ code: 'network' });
    const started = await transport.startConversation({ ...input, captcha_token: 'tok' });

    const [first, second] = api.calls.filter((call) => call.path === '/conversations');
    const clientIdOf = (body: unknown) => (body as { clientId: string }).clientId;
    expect(clientIdOf(first?.body)).toBe(clientIdOf(second?.body));
    expect(second?.body).toEqual({
      clientId: expect.any(String),
      prechat: { name: 'Omar', email: 'omar@example.com', custom: { order: '42' } },
      captchaToken: 'tok',
    });
    expect(started).toMatchObject({
      id: CONVERSATION,
      status: 'active',
      visitor_email: 'omar@example.com',
    });
  });

  it('holds a file until its message is sent, and uploads it once however often the send is retried', async () => {
    let sends = 0;
    const api = fakeApi({
      [`POST /conversations/${CONVERSATION}/attachments`]: () => ({
        attachmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
        url: 'https://bucket/object',
        headers: { 'content-type': 'audio/webm' },
        expiresAt: '2026-09-27T10:05:00.000Z',
      }),
      'PUT bucket': () => undefined,
      [`POST /conversations/${CONVERSATION}/attachments/0192c3f0-1a2b-7c3d-8e4f-0000000000f1/confirm`]:
        () => ({
          id: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
          kind: 'audio',
          name: 'voice.webm',
          mime: 'audio/webm',
          size: 3,
          status: 'processing',
        }),
      [`POST /conversations/${CONVERSATION}/messages`]: (body) => {
        sends += 1;
        if (sends === 1) {
          return new Response(null, { status: 503 });
        }
        return {
          conversation: conversation(),
          message: message(1, {
            author: 'visitor',
            clientId: (body as { clientId: string }).clientId,
            text: '',
          }),
        };
      },
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });
    const blob = new Blob(['abc'], { type: 'audio/webm;codecs=opus' });

    const held = await transport.uploadAttachment(blob, 'voice.webm', 'voice');
    expect(api.calls).toEqual([]);
    const input = { client_id: CONVERSATION, body: '', attachment_ids: [held.id] };
    await expect(transport.sendMessage(CONVERSATION, input)).rejects.toMatchObject({
      code: 'unavailable',
    });
    const sent = await transport.sendMessage(CONVERSATION, input);

    expect(api.calls.filter((call) => call.path.endsWith('/attachments'))).toEqual([
      expect.objectContaining({
        body: { kind: 'audio', mime: 'audio/webm', size: 3, fileName: 'voice.webm' },
      }),
    ]);
    expect(api.calls.filter((call) => call.path.endsWith('/messages')).at(-1)?.body).toEqual({
      clientId: CONVERSATION,
      text: '',
      attachmentIds: ['0192c3f0-1a2b-7c3d-8e4f-0000000000f1'],
    });
    expect(sent).toMatchObject({ seq: 1, client_id: CONVERSATION, author: { kind: 'visitor' } });
  });

  it('pages a catch-up until the api says there is no more', async () => {
    const api = fakeApi({
      [`GET /conversations/${CONVERSATION}/messages`]: (_body, url) =>
        url.searchParams.get('after') === '2'
          ? { messages: [message(3)], lastSeq: 5, hasMore: true }
          : { messages: [message(6)], lastSeq: 6, hasMore: false },
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore(),
      fetch: api.fetch,
      network: null,
    });

    const messages = await transport.listMessages(CONVERSATION, 2);

    expect(messages.map((entry) => [entry.seq, entry.body])).toEqual([
      [3, 'message 3'],
      [6, 'message 6'],
    ]);
    expect(api.calls.map((call) => call.path)).toEqual([
      `/conversations/${CONVERSATION}/messages`,
      `/conversations/${CONVERSATION}/messages`,
    ]);
  });

  it("turns the socket's events into the UI's, and a null queue into an active conversation", async () => {
    const live = fakeSocket();
    const api = fakeApi({
      'GET /config': () => ({
        brandName: 'Acme',
        availability: {
          open: true,
          agentsOnline: false,
          agents: [],
          nextOpenAt: null,
          timezone: 'UTC',
        },
        popularArticles: [],
        theme: {
          colorScheme: 'auto',
          tokens: { light: {}, dark: {} },
          radius: { md: 6, lg: 10 },
          fontFamily: { sans: 's', arabic: 'a', mono: 'm' },
          fonts: [],
          launcher: { style: 'icon', label: null, position: 'end' },
        },
        prechat: { enabled: false, fields: [] },
        contactForm: { fields: [] },
        contentPolicy: {
          image: { enabled: true, maxBytes: 1, allowedMime: ['image/png'] },
          video: { enabled: true, maxBytes: 1, allowedMime: ['video/mp4'] },
          voice: { enabled: true, maxBytes: 1, allowedMime: ['audio/ogg'] },
          file: { enabled: true, maxBytes: 1, allowedMime: ['text/plain'] },
          maxAttachmentsPerMessage: 1,
        },
        captcha: null,
      }),
      'POST /conversations': () => ({ conversation: conversation(), message: null }),
      [`GET /conversations/${CONVERSATION}/queue`]: () => ({
        conversationId: CONVERSATION,
        position: 1,
      }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      openSocket: () => live.socket as unknown as LiveSocket,
      network: null,
    });
    await transport.getConfig('en');
    await transport.startConversation({});
    const events: WidgetEvent[] = [];
    const states: ConnectionState[] = [];
    transport.subscribe(CONVERSATION, {
      onEvent: (event) => events.push(event),
      onConnection: (state) => states.push(state),
    });

    live.socket.connected = true;
    live.fire('connect');
    live.envelope('message', message(1, { agent: { name: 'Lina', avatarUrl: null } }), 1);
    live.envelope('message', { ...message(2), conversationId: BRAND }, 2);
    live.envelope('queue', { conversationId: CONVERSATION, position: 3 });
    live.envelope('queue', { conversationId: CONVERSATION, position: null });
    live.envelope('typing', { conversationId: CONVERSATION, typing: true, agentName: null });
    live.envelope('receipt', { conversationId: CONVERSATION, kind: 'read', seq: 1 });
    live.envelope('presence', { agentsOnline: true, agents: [{ name: 'Lina', avatarUrl: null }] });
    live.envelope('conversation', {
      conversationId: CONVERSATION,
      state: 'closed',
      continuedById: null,
    });

    expect(live.socket.emitWithAck).toHaveBeenCalledWith('conversation:join', {
      conversationId: CONVERSATION,
    });
    expect(states).toEqual(['connecting', 'online']);
    expect(events).toEqual([
      { type: 'message', message: expect.objectContaining({ seq: 1, body: 'message 1' }) },
      { type: 'queue', position: 3, eta_seconds: null },
      { type: 'conversation', conversation: expect.objectContaining({ status: 'active' }) },
      { type: 'typing', typing: true, agent: { id: 'brand', name: 'Acme', avatar_url: null } },
      { type: 'receipt', kind: 'read', seq: 1 },
      {
        type: 'presence',
        availability: expect.objectContaining({
          state: 'online',
          timezone: 'UTC',
          agents_online: [{ id: 'online-0', name: 'Lina', avatar_url: null }],
        }),
      },
      { type: 'conversation', conversation: expect.objectContaining({ status: 'ended' }) },
    ]);

    transport.sendTyping(CONVERSATION, true);
    await transport.markRead(CONVERSATION, 1);
    expect(live.socket.emit).toHaveBeenCalledWith('typing:set', {
      conversationId: CONVERSATION,
      typing: true,
    });
    expect(live.socket.emit).toHaveBeenCalledWith('message:read', {
      conversationId: CONVERSATION,
      seq: 1,
    });
  });

  it('says it is reconnecting the moment the browser goes offline, and reconnects when it is back', () => {
    const live = fakeSocket();
    const network = networkEvents();
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: fakeApi({}).fetch,
      openSocket: () => live.socket as unknown as LiveSocket,
      network,
    });
    const states: ConnectionState[] = [];
    transport.subscribe(null, { onEvent: () => undefined, onConnection: (s) => states.push(s) });
    live.socket.connected = true;
    live.fire('connect');

    network.fire('offline');
    live.socket.connected = false;
    network.fire('online');

    expect(states).toEqual(['connecting', 'online', 'reconnecting']);
    expect(live.socket.connect).toHaveBeenCalledOnce();
  });

  it('says it is online again when the socket outlived the outage', () => {
    const live = fakeSocket();
    const network = networkEvents();
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: fakeApi({}).fetch,
      openSocket: () => live.socket as unknown as LiveSocket,
      network,
    });
    const states: ConnectionState[] = [];
    transport.subscribe(null, { onEvent: () => undefined, onConnection: (s) => states.push(s) });
    live.socket.connected = true;
    live.fire('connect');

    network.fire('offline');
    network.fire('online');

    expect(states).toEqual(['connecting', 'online', 'reconnecting', 'online']);
    expect(live.socket.connect).not.toHaveBeenCalled();
  });

  it('falls back to SSE after the socket fails to connect, and to REST for typing', async () => {
    const live = fakeSocket();
    const streamed: string[] = [];
    const api = fakeApi({
      'POST /conversations': () => ({ conversation: conversation(), message: null }),
      [`GET /conversations/${CONVERSATION}/queue`]: () => ({
        conversationId: CONVERSATION,
        position: null,
      }),
      'GET /stream': (_body, url) => {
        streamed.push(url.search);
        return new Response(
          `event: message\ndata: ${JSON.stringify({ seq: 1, at: 'x', data: message(1) })}\n\n`,
          { status: 200 },
        );
      },
      [`POST /conversations/${CONVERSATION}/typing`]: () => undefined,
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      openSocket: () => live.socket as unknown as LiveSocket,
      network: null,
      socketAttemptsBeforeSse: 2,
      setTimeout: () => undefined,
    });
    await transport.startConversation({});
    const events: WidgetEvent[] = [];
    const states: ConnectionState[] = [];
    transport.subscribe(CONVERSATION, {
      onEvent: (event) => events.push(event),
      onConnection: (state) => states.push(state),
    });

    live.fire('connect_error', new Error('websocket error'));
    live.fire('connect_error', new Error('websocket error'));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    transport.sendTyping(CONVERSATION, true);

    expect(live.socket.disconnect).toHaveBeenCalled();
    expect(streamed[0]).toContain(`conversationId=${CONVERSATION}`);
    expect(states).toContain('online');
    await vi.waitFor(() =>
      expect(api.calls.map((call) => call.path)).toContain(`/conversations/${CONVERSATION}/typing`),
    );
  });

  it('files a contact form as one conversation with its files, even when the send is retried', async () => {
    let sends = 0;
    const api = fakeApi({
      'POST /conversations': () => ({
        conversation: conversation({ reference: 'HD-1043' }),
        message: null,
      }),
      [`POST /conversations/${CONVERSATION}/attachments`]: () => ({
        attachmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f2',
        url: 'https://bucket/object',
        headers: {},
        expiresAt: '2026-09-27T10:05:00.000Z',
      }),
      'PUT bucket': () => undefined,
      [`POST /conversations/${CONVERSATION}/attachments/0192c3f0-1a2b-7c3d-8e4f-0000000000f2/confirm`]:
        () => ({
          id: '0192c3f0-1a2b-7c3d-8e4f-0000000000f2',
          kind: 'file',
          name: 'invoice.pdf',
          mime: 'application/pdf',
          size: 3,
          status: 'processing',
        }),
      [`POST /conversations/${CONVERSATION}/messages`]: () => {
        sends += 1;
        return sends === 1
          ? new Response(null, { status: 502 })
          : { conversation: conversation(), message: message(1, { author: 'visitor' }) };
      },
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });
    const file = await transport.uploadAttachment(
      new Blob(['pdf'], { type: 'application/pdf' }),
      'invoice.pdf',
      'file',
    );
    const form = {
      name: 'Omar',
      email: 'omar@example.com',
      message: 'My invoice is wrong',
      fields: {},
      attachment_ids: [file.id],
      captcha_token: 'tok',
    };

    await expect(transport.submitContactForm(form)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(transport.submitContactForm(form)).resolves.toEqual({ ticket_ref: 'HD-1043' });

    const starts = api.calls.filter((call) => call.path === '/conversations');
    const messages = api.calls.filter((call) => call.path.endsWith('/messages'));
    expect(new Set(starts.map((call) => (call.body as { clientId: string }).clientId)).size).toBe(
      1,
    );
    expect(new Set(messages.map((call) => (call.body as { clientId: string }).clientId)).size).toBe(
      1,
    );
    expect(starts[0]?.body).toMatchObject({
      prechat: { name: 'Omar', email: 'omar@example.com' },
      captchaToken: 'tok',
    });
    expect(messages.at(-1)?.body).toMatchObject({
      text: 'My invoice is wrong',
      attachmentIds: ['0192c3f0-1a2b-7c3d-8e4f-0000000000f2'],
    });
    expect(api.calls.filter((call) => call.path.endsWith('/attachments'))).toHaveLength(1);
  });

  it('carries "Still need help?"’s article on the start (M5-08)', async () => {
    const api = fakeApi({
      'POST /conversations': () => ({ conversation: conversation(), message: null }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });

    await transport.startConversation({ article_id: ARTICLE });

    expect(api.calls[0]?.body).toMatchObject({ articleId: ARTICLE });
  });

  it('hands a conversation to the team and records feedback over REST (M7-06)', async () => {
    const api = fakeApi({
      'POST /conversations': () => ({ conversation: conversation(), message: null }),
      [`POST /conversations/${CONVERSATION}/handoff`]: () => conversation({ aiHandedOff: true }),
      [`GET /conversations/${CONVERSATION}/queue`]: () => ({
        conversationId: CONVERSATION,
        position: 2,
      }),
      [`POST /conversations/${CONVERSATION}/messages/${ARTICLE}/feedback`]: () =>
        message(2, { author: 'ai' }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });
    await transport.startConversation({});

    const handedOff = await transport.handOff(CONVERSATION);
    await transport.sendFeedback(CONVERSATION, ARTICLE, 'not_helpful');

    expect(handedOff).toMatchObject({ status: 'queued', ai_handed_off: true });
    expect(api.calls.at(-1)?.body).toEqual({ feedback: 'not_helpful' });
  });
});

const ARTICLE = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const SEARCH = '0192c3f0-1a2b-7c3d-8e4f-0000000000a9';

const hit = (id: string) => ({
  id,
  title: 'Refund timelines',
  excerpt: 'Card refunds land in 3–5 days',
  section: 'Refunds',
  url: null,
});

describe('the help center over the remote transport (M5-10)', () => {
  const articleTransport = () => {
    const api = fakeApi({
      'GET /articles': (_body, url) => ({
        articles: [hit(ARTICLE)],
        searchId: url.searchParams.get('purpose') === 'suggest' ? null : SEARCH,
      }),
      [`GET /articles/${ARTICLE}`]: () => ({
        ...hit(ARTICLE),
        locale: 'ar',
        updatedAt: '2026-09-12T10:00:00.000Z',
        readingMinutes: 2,
        bodyHtml: '<p>We issue your refund…</p>',
      }),
    });
    const transport = createRemoteTransport({
      apiOrigin: API,
      brand: BRAND,
      storage: memoryStore({ [secretKeyFor(BRAND)]: SECRET }),
      fetch: api.fetch,
      network: null,
    });
    return { api, transport };
  };
  const urlOf = (api: ReturnType<typeof fakeApi>, index: number) =>
    new URL(api.fetch.mock.calls[index]?.[0] ?? '');

  it('searches the api, as the visitor, in the widget’s language', async () => {
    const { api, transport } = articleTransport();

    await expect(transport.searchArticles('refund & fees', 'ar')).resolves.toEqual([hit(ARTICLE)]);

    const url = urlOf(api, 0);
    expect(url.pathname).toBe(`/api/widget/${BRAND}/articles`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'refund & fees',
      locale: 'ar',
      purpose: 'search',
    });
    expect(api.calls[0]?.auth).toBe(`Visitor ${SECRET}`);
  });

  it('asks for suggestions without logging them', async () => {
    const { api, transport } = articleTransport();

    await transport.suggestArticles('my refund has not arrived', 'en');

    expect(urlOf(api, 0).searchParams.get('purpose')).toBe('suggest');
  });

  it('reads an article into the UI’s shape, naming the search it came from', async () => {
    const { api, transport } = articleTransport();
    await transport.searchArticles('refund', 'en');

    const article = await transport.getArticle(ARTICLE, 'en');

    expect(article).toEqual({
      ...hit(ARTICLE),
      updated_at: '2026-09-12T10:00:00.000Z',
      reading_minutes: 2,
      body_html: '<p>We issue your refund…</p>',
    });
    expect(Object.fromEntries(urlOf(api, 1).searchParams)).toEqual({
      locale: 'en',
      searchId: SEARCH,
    });
  });

  it('names no search for an article that was not one of its hits', async () => {
    const { api, transport } = articleTransport();
    await transport.suggestArticles('refund', 'en');

    await transport.getArticle(ARTICLE, 'en');

    expect(urlOf(api, 1).searchParams.has('searchId')).toBe(false);
  });

  it('turns a refused article into not_found', async () => {
    const { transport } = articleTransport();

    await expect(
      transport.getArticle('0192c3f0-1a2b-7c3d-8e4f-0000000000ff', 'en'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
