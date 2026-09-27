import type { WidgetMessage, WidgetSendResponse } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { WidgetTransportError } from './contract.js';
import { EVENTS } from './protocol.js';
import {
  createSocketTransport,
  type KeyValueStore,
  type LiveSocket,
  secretKeyFor,
} from './socket.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const SECRET = 'a'.repeat(43);

const message = (seq: number, clientId: string | null = null): WidgetMessage => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-${String(seq).padStart(12, '0')}`,
  conversationId: CONVERSATION,
  seq,
  clientId,
  author: clientId === null ? 'agent' : 'visitor',
  agent: null,
  text: `message ${String(seq)}`,
  html: null,
  attachments: [],
  createdAt: '2026-09-27T10:00:00.000Z',
});

const sent = (seq: number, clientId: string): WidgetSendResponse => ({
  conversation: {
    id: CONVERSATION,
    reference: 'HD-1',
    subject: 'Hello',
    state: 'open',
    channel: 'chat',
    lastSeq: seq,
    continuedById: null,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
  },
  message: message(seq, clientId),
});

/** A Socket.IO client socket that the test drives by hand. */
class FakeSocket {
  connected = false;
  readonly emitted: { event: string; payload: unknown }[] = [];
  readonly #handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  joinAck: { ok: boolean; data?: { lastSeq: number } } = { ok: true, data: { lastSeq: 0 } };

  on(event: string, handler: (...args: unknown[]) => void) {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
    return this;
  }
  off() {
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }
  async emitWithAck(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return this.joinAck;
  }
  connect() {
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    if (event === 'connect') {
      this.connected = true;
    }
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const memory = (): KeyValueStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const harness = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => {
  const socket = new FakeSocket();
  const storage = memory();
  storage.setItem(secretKeyFor(BRAND), SECRET);
  const opened: unknown[] = [];
  let clock = 0;
  const transport = createSocketTransport({
    apiUrl: 'https://api.example.com',
    brandId: BRAND,
    storage,
    fetch,
    openSocket: (auth) => {
      opened.push(auth);
      return socket as unknown as LiveSocket;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    setTimeout: () => undefined,
  });
  return { transport, socket, storage, opened };
};

describe('createSocketTransport', () => {
  it('keeps the secret a first session issued, and opens the socket with it', async () => {
    const storage = memory();
    const opened: unknown[] = [];
    const transport = createSocketTransport({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      storage,
      fetch: async () => json({ visitorId: CONVERSATION, visitorSecret: SECRET, verified: false }),
      openSocket: (auth) => {
        opened.push(auth);
        return new FakeSocket() as unknown as LiveSocket;
      },
    });

    await transport.startSession();

    expect(storage.values.get(secretKeyFor(BRAND))).toBe(SECRET);
    expect(opened).toEqual([{ brandId: BRAND, visitorSecret: SECRET }]);
  });

  it('retries a send with the same clientId until it holds a seq', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const { transport } = harness(async (_url, init) => {
      bodies.push(String(init?.body));
      calls += 1;
      if (calls < 3) {
        throw new TypeError('Failed to fetch');
      }
      return json(sent(5, JSON.parse(String(init?.body)).clientId as string), 201);
    });

    const response = await transport.send(CONVERSATION, { text: 'hello' });

    expect(response.message.seq).toBe(5);
    expect(new Set(bodies).size).toBe(1);
    expect(calls).toBe(3);
  });

  it('gives up after ten seconds as "not sent", and never retries a refusal', async () => {
    const { transport } = harness(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(transport.send(CONVERSATION, { text: 'hello' })).rejects.toMatchObject({
      code: 'send_timeout',
    });

    const refused = harness(async () =>
      json({ error: { message: 'no', widget: { reason: 'read_only' } } }, 409),
    );
    await expect(refused.transport.send(CONVERSATION, { text: 'x' })).rejects.toBeInstanceOf(
      WidgetTransportError,
    );
  });

  it('delivers live messages in order, and catches up over REST on a gap', async () => {
    const urls: string[] = [];
    const { transport, socket } = harness(async (url) => {
      urls.push(url);
      return json({ messages: [message(5), message(6)], lastSeq: 6, hasMore: false });
    });
    const delivered: number[] = [];

    transport.subscribe(CONVERSATION, 3, { onMessage: (m) => delivered.push(m.seq) });
    socket.fire(EVENTS.message, { seq: 4, at: '', data: message(4) });
    socket.fire(EVENTS.message, { seq: 6, at: '', data: message(6) });
    await vi.waitFor(() => expect(delivered).toEqual([4, 5, 6]));

    expect(urls.at(-1)).toContain(`/conversations/${CONVERSATION}/messages?after=4`);
  });

  it('rejoins and catches up after a reconnect', async () => {
    const { transport, socket } = harness(async () =>
      json({ messages: [message(8)], lastSeq: 8, hasMore: false }),
    );
    const delivered: number[] = [];
    transport.subscribe(CONVERSATION, 7, { onMessage: (m) => delivered.push(m.seq) });
    socket.joinAck = { ok: true, data: { lastSeq: 8 } };

    socket.fire('connect');
    await vi.waitFor(() => expect(delivered).toEqual([8]));

    expect(socket.emitted).toContainEqual({
      event: EVENTS.join,
      payload: { conversationId: CONVERSATION },
    });
  });

  it('falls back to SSE after the socket fails to connect three times', async () => {
    const urls: string[] = [];
    const { transport, socket } = harness(async (url) => {
      urls.push(url);
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    });
    const channels: string[] = [];
    transport.onChannel((channel) => channels.push(channel));
    transport.subscribe(CONVERSATION, 2, {});

    for (let attempt = 0; attempt < 3; attempt += 1) {
      socket.fire('connect_error', new Error('websocket error'));
    }
    await vi.waitFor(() => expect(urls.some((url) => url.includes('/stream?'))).toBe(true));

    expect(urls.find((url) => url.includes('/stream?'))).toContain(
      `conversationId=${CONVERSATION}&after=2`,
    );
    expect(channels).toContain('sse');
    transport.close();
  });

  it('does not fall back when the socket refused the origin', () => {
    const { transport, socket } = harness(async () => json({}));
    transport.subscribe(CONVERSATION, 0, {});
    const refusal = Object.assign(new Error('no'), { data: { code: 'origin_not_allowed' } });

    socket.fire('connect_error', refusal);

    expect(socket.connected).toBe(false);
  });

  it('says typing over the socket when it is up, and over REST when it is not', async () => {
    const urls: string[] = [];
    const { transport, socket } = harness(async (url) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    });
    transport.subscribe(CONVERSATION, 0, {});

    transport.typing(CONVERSATION, true);
    socket.fire('connect');
    transport.typing(CONVERSATION, false);
    transport.markRead(CONVERSATION, 3);

    await vi.waitFor(() => expect(urls.some((url) => url.endsWith('/typing'))).toBe(true));
    expect(socket.emitted).toContainEqual({
      event: EVENTS.typingSet,
      payload: { conversationId: CONVERSATION, typing: false },
    });
    expect(socket.emitted).toContainEqual({
      event: EVENTS.read,
      payload: { conversationId: CONVERSATION, seq: 3 },
    });
  });

  it('routes typing, queue, receipts, conversation moves and presence to their listeners', () => {
    const { transport, socket } = harness(async () => json({}));
    const seen: string[] = [];
    transport.subscribe(CONVERSATION, 0, {
      onTyping: () => seen.push('typing'),
      onQueue: () => seen.push('queue'),
      onReceipt: () => seen.push('receipt'),
      onConversation: () => seen.push('conversation'),
    });
    transport.onPresence((online) => seen.push(`presence:${String(online)}`));
    const data = { conversationId: CONVERSATION };

    socket.fire(EVENTS.typing, {
      seq: null,
      at: '',
      data: { ...data, typing: true, agentName: null },
    });
    socket.fire(EVENTS.queue, { seq: null, at: '', data: { ...data, position: 2 } });
    socket.fire(EVENTS.receipt, { seq: null, at: '', data: { ...data, kind: 'read', seq: 3 } });
    socket.fire(EVENTS.conversation, {
      seq: null,
      at: '',
      data: { ...data, state: 'closed', continuedById: null },
    });
    socket.fire(EVENTS.presence, { seq: null, at: '', data: { agentsOnline: true } });

    expect(seen).toEqual(['typing', 'queue', 'receipt', 'conversation', 'presence:true']);
  });

  it('uploads through a presigned URL and confirms', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const { transport } = harness(async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith('/attachments')) {
        return json({
          attachmentId: CONVERSATION,
          url: 'https://bucket.example.com/put',
          headers: { 'content-type': 'image/png' },
          expiresAt: '2026-09-27T10:05:00.000Z',
        });
      }
      if (url.startsWith('https://bucket')) {
        return new Response(null, { status: 200 });
      }
      return json({
        id: CONVERSATION,
        kind: 'image',
        name: 'a.png',
        mime: 'image/png',
        size: 3,
        status: 'processing',
      });
    });
    const file = Object.assign(new Blob(['png'], { type: 'image/png' }), { name: 'a.png' });

    const attachment = await transport.upload(CONVERSATION, file, 'image');

    expect(attachment.status).toBe('processing');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'POST']);
  });
});
