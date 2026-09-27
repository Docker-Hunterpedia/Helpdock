import type {
  AttachmentKind,
  AttachmentPresignResponse,
  WidgetAttachment,
  WidgetConfig,
  WidgetConversation,
  WidgetConversationEvent,
  WidgetConversationList,
  WidgetEnvelope,
  WidgetMessage,
  WidgetMessagePage,
  WidgetQueue,
  WidgetReceipt,
  WidgetSendResponse,
  WidgetSession,
  WidgetTyping,
} from '@helpdock/schemas';
import { io, type Socket } from 'socket.io-client';
import {
  type ConversationHandlers,
  type LiveChannel,
  type SendInput,
  type StartConversationInput,
  type WidgetTransport,
  WidgetTransportError,
} from './contract.js';
import { ConversationCursor } from './cursor.js';
import { type FetchLike, HttpClient, isRetryable } from './http.js';
import { EVENTS, NAMESPACE, SEND_TIMEOUT_MS, SOCKET_PATH, uuidv7 } from './protocol.js';
import { openSseStream, type SseFrame } from './sse.js';

/**
 * The real transport (M4-04): REST for everything that must happen, the
 * `/widget` socket for being told, and SSE over `fetch` when a WebSocket will
 * not connect. DOMAIN-RULES §7, from the client's side:
 *
 * - **Send** is a `POST` with a `clientId` chosen once and repeated on every
 *   retry; it resolves with the message's `seq`, or rejects with
 *   `send_timeout` after ten seconds of trying.
 * - **Receive** goes through a {@link ConversationCursor} per conversation, so
 *   a gap, a reconnect or a switch to SSE all end in one catch-up from the
 *   last `seq`, and the UI sees each message once, in order.
 * - **The credential** is issued by the first session call and kept per brand
 *   in `localStorage`; clearing it is a new anonymous visitor (§4.1).
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The subset of a Socket.IO client socket the transport uses; a test passes a fake. */
export type LiveSocket = Pick<
  Socket,
  'on' | 'off' | 'emit' | 'emitWithAck' | 'connect' | 'disconnect' | 'connected'
>;

export interface SocketTransportOptions {
  /** Where the api is: `https://api.example.com`. */
  readonly apiUrl: string;
  readonly brandId: string;
  readonly storage?: KeyValueStore;
  readonly fetch?: FetchLike;
  /** Opens the `/widget` socket. Defaults to `socket.io-client`, WebSocket only. */
  readonly openSocket?: (auth: { brandId: string; visitorSecret: string }) => LiveSocket;
  /** Consecutive failed connects before falling back to SSE. */
  readonly socketAttemptsBeforeSse?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
}

interface Subscription {
  readonly cursor: ConversationCursor;
  readonly handlers: Set<ConversationHandlers>;
  closeSse: (() => void) | null;
}

/** Refusals a fallback cannot fix: the socket was reached and said no. */
const FINAL_HANDSHAKE_CODES = new Set(['origin_not_allowed', 'unauthenticated', 'unavailable']);

const memoryStore = (): KeyValueStore => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

/** `localStorage`, or memory where a browser refuses it (a sandboxed frame, private mode). */
const defaultStore = (): KeyValueStore => {
  try {
    const store = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    if (store !== undefined) {
      store.getItem('helpdock:probe');
      return store;
    }
  } catch {
    // Storage is blocked; the visitor lasts as long as the page.
  }
  return memoryStore();
};

export const secretKeyFor = (brandId: string): string => `helpdock:${brandId}:visitor`;

export const createSocketTransport = (options: SocketTransportOptions): WidgetTransport => {
  const store = options.storage ?? defaultStore();
  const key = secretKeyFor(options.brandId);
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attemptsBeforeSse = options.socketAttemptsBeforeSse ?? 3;
  const http = new HttpClient({
    apiUrl: options.apiUrl,
    brandId: options.brandId,
    secret: () => store.getItem(key),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const openSocket =
    options.openSocket ??
    ((auth) =>
      io(`${options.apiUrl.replace(/\/$/, '')}${NAMESPACE}`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        auth,
        reconnectionDelayMax: 10_000,
      }));

  const subscriptions = new Map<string, Subscription>();
  const presenceListeners = new Set<(agentsOnline: boolean) => void>();
  const channelListeners = new Set<(channel: LiveChannel) => void>();
  let socket: LiveSocket | null = null;
  let channel: LiveChannel = 'offline';
  let failedConnects = 0;

  const setChannel = (next: LiveChannel): void => {
    if (next !== channel) {
      channel = next;
      for (const listener of channelListeners) {
        listener(next);
      }
    }
  };

  const each = (conversationId: string, fn: (handlers: ConversationHandlers) => void): void => {
    for (const handlers of subscriptions.get(conversationId)?.handlers ?? []) {
      fn(handlers);
    }
  };

  /** One handler for a socket frame and an SSE frame alike: they are the same envelope. */
  const dispatch = (event: string, envelope: WidgetEnvelope<unknown>): void => {
    switch (event) {
      case EVENTS.message: {
        const message = envelope.data as WidgetMessage;
        subscriptions.get(message.conversationId)?.cursor.receive(message);
        return;
      }
      case EVENTS.typing: {
        const typing = envelope.data as WidgetTyping;
        each(typing.conversationId, (handlers) => handlers.onTyping?.(typing));
        return;
      }
      case EVENTS.queue: {
        const queue = envelope.data as WidgetQueue;
        each(queue.conversationId, (handlers) => handlers.onQueue?.(queue));
        return;
      }
      case EVENTS.receipt: {
        const receipt = envelope.data as WidgetReceipt;
        each(receipt.conversationId, (handlers) => handlers.onReceipt?.(receipt));
        return;
      }
      case EVENTS.conversation: {
        const moved = envelope.data as WidgetConversationEvent;
        each(moved.conversationId, (handlers) => handlers.onConversation?.(moved));
        return;
      }
      case EVENTS.presence: {
        const { agentsOnline } = envelope.data as { agentsOnline: boolean };
        for (const listener of presenceListeners) {
          listener(agentsOnline);
        }
        return;
      }
    }
  };

  const join = async (live: LiveSocket, conversationId: string): Promise<void> => {
    const subscription = subscriptions.get(conversationId);
    if (subscription === undefined) {
      return;
    }
    const ack = (await live.emitWithAck(EVENTS.join, { conversationId })) as
      | { ok: true; data: { lastSeq: number } }
      | { ok: false };
    if (!ack.ok || ack.data.lastSeq > subscription.cursor.last) {
      await subscription.cursor.catchUp();
    }
  };

  const openStream = (conversationId: string, subscription: Subscription): void => {
    subscription.closeSse ??= openSseStream({
      http,
      conversationId,
      after: () => subscription.cursor.last,
      onFrame: (frame: SseFrame) => dispatch(frame.event, frame.envelope),
      onOpen: () => setChannel('sse'),
      ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    });
  };

  const fallBackToSse = (): void => {
    socket?.disconnect();
    socket = null;
    for (const [conversationId, subscription] of subscriptions) {
      openStream(conversationId, subscription);
    }
  };

  const ensureSocket = (): void => {
    const secret = store.getItem(key);
    if (socket !== null || secret === null || failedConnects >= attemptsBeforeSse) {
      return;
    }
    const live = openSocket({ brandId: options.brandId, visitorSecret: secret });
    socket = live;
    for (const event of Object.values(EVENTS)) {
      live.on(event, (envelope: WidgetEnvelope<unknown>) => dispatch(event, envelope));
    }
    live.on('connect', () => {
      failedConnects = 0;
      setChannel('socket');
      // A reconnect is a gap of unknown size: every conversation catches up.
      for (const conversationId of subscriptions.keys()) {
        void join(live, conversationId);
      }
    });
    live.on('disconnect', () => setChannel('offline'));
    live.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      failedConnects += 1;
      if (FINAL_HANDSHAKE_CODES.has(error.data?.code ?? '')) {
        live.disconnect();
        socket = null;
        return;
      }
      if (failedConnects >= attemptsBeforeSse) {
        fallBackToSse();
      }
    });
  };

  /** Retries with the same body until it lands or ten seconds have passed (§7). */
  const withRetry = async <T>(attempt: () => Promise<T>): Promise<T> => {
    const deadline = now() + SEND_TIMEOUT_MS;
    let delay = 500;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (!isRetryable(error)) {
          throw error;
        }
        if (now() + delay >= deadline) {
          throw new WidgetTransportError('send_timeout', 'The message could not be sent');
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 4_000);
      }
    }
  };

  const conversationPath = (conversationId: string, rest = ''): string =>
    `/conversations/${conversationId}${rest}`;

  return {
    config: () => http.get<WidgetConfig>('/config'),

    async startSession(session = {}) {
      const result = await http.post<WidgetSession>('/session', {
        ...(session.identity === undefined ? {} : { identity: session.identity }),
        ...(session.locale === undefined ? {} : { locale: session.locale }),
      });
      if (typeof result.visitorSecret === 'string') {
        store.setItem(key, result.visitorSecret);
      }
      ensureSocket();
      return result;
    },

    async conversations(): Promise<readonly WidgetConversation[]> {
      return (await http.get<WidgetConversationList>('/conversations')).conversations;
    },

    startConversation(input: StartConversationInput) {
      const body = { ...input, clientId: input.clientId ?? uuidv7(now()) };
      return withRetry(() => http.post<WidgetSendResponse>('/conversations', body));
    },

    async send(conversationId: string, input: SendInput) {
      const body = {
        clientId: input.clientId ?? uuidv7(now()),
        text: input.text,
        attachmentIds: [...(input.attachmentIds ?? [])],
      };
      const response = await withRetry(() =>
        http.post<WidgetSendResponse>(conversationPath(conversationId, '/messages'), body),
      );
      subscriptions.get(response.conversation.id)?.cursor.receive(response.message);
      return response;
    },

    catchUp: (conversationId, after) =>
      http.get<WidgetMessagePage>(
        conversationPath(conversationId, `/messages?after=${String(after)}`),
      ),

    subscribe(conversationId, after, handlers) {
      let subscription = subscriptions.get(conversationId);
      if (subscription === undefined) {
        const created: Subscription = {
          handlers: new Set(),
          closeSse: null,
          cursor: new ConversationCursor({
            after,
            fetchAfter: (from) =>
              http.get<WidgetMessagePage>(
                conversationPath(conversationId, `/messages?after=${String(from)}`),
              ),
            deliver: (message) => {
              for (const listener of created.handlers) {
                listener.onMessage?.(message);
              }
            },
          }),
        };
        subscription = created;
        subscriptions.set(conversationId, created);
        if (socket?.connected === true) {
          void join(socket, conversationId);
        } else if (failedConnects >= attemptsBeforeSse) {
          openStream(conversationId, created);
        } else {
          ensureSocket();
        }
      }
      subscription.handlers.add(handlers);
      const owned = subscription;

      return () => {
        owned.handlers.delete(handlers);
        if (owned.handlers.size === 0) {
          owned.closeSse?.();
          subscriptions.delete(conversationId);
          socket?.emit(EVENTS.leave, { conversationId });
        }
      };
    },

    onPresence(listener) {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },

    onChannel(listener) {
      channelListeners.add(listener);
      listener(channel);
      return () => channelListeners.delete(listener);
    },

    typing(conversationId, typing) {
      if (socket?.connected === true) {
        socket.emit(EVENTS.typingSet, { conversationId, typing });
        return;
      }
      void http
        .post(conversationPath(conversationId, '/typing'), { typing })
        .catch(() => undefined);
    },

    markRead(conversationId, seq) {
      if (socket?.connected === true) {
        socket.emit(EVENTS.read, { conversationId, seq });
        return;
      }
      void http.post(conversationPath(conversationId, '/read'), { seq }).catch(() => undefined);
    },

    async upload(conversationId, file, kind: AttachmentKind): Promise<WidgetAttachment> {
      const presign = await http.post<AttachmentPresignResponse>(
        conversationPath(conversationId, '/attachments'),
        { kind, mime: file.type, size: file.size, fileName: file.name },
      );
      const put = await (options.fetch ?? fetch)(presign.url, {
        method: 'PUT',
        headers: presign.headers,
        body: file,
      });
      if (!put.ok) {
        throw new WidgetTransportError('network', `The upload answered ${String(put.status)}`);
      }
      return http.post<WidgetAttachment>(
        conversationPath(conversationId, `/attachments/${presign.attachmentId}/confirm`),
        {},
      );
    },

    requestTranscript: (conversationId, email) =>
      http.post<void>(conversationPath(conversationId, '/transcript'), { email }),

    close() {
      socket?.disconnect();
      socket = null;
      for (const subscription of subscriptions.values()) {
        subscription.closeSse?.();
      }
      subscriptions.clear();
      setChannel('offline');
    },
  };
};
