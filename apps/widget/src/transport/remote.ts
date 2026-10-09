import type {
  AttachmentPresignResponse,
  WidgetArticleSearch,
  WidgetConversationEvent,
  WidgetConversationList,
  WidgetCsat,
  WidgetCsatResponse,
  WidgetEnvelope,
  WidgetMessagePage,
  WidgetPresence,
  WidgetQueue,
  WidgetReceipt,
  WidgetSendResponse,
  WidgetSession,
  WidgetStartResponse,
  WidgetTyping,
  WidgetArticle as WireArticle,
  WidgetAttachment as WireAttachment,
  WidgetAvailability as WireAvailability,
  WidgetConfig as WireConfig,
  WidgetConversation as WireConversation,
  WidgetConversationHours as WireHours,
  WidgetMessage as WireMessage,
} from '@helpdock/schemas';
import { io, type Socket } from 'socket.io-client';
import { uuidv7 } from '../state/send.js';
import { type FetchLike, HttpClient } from './http.js';
import {
  agentOf,
  statusOf,
  toArticle,
  toAvailability,
  toConfig,
  toConversation,
  toCsat,
  toHours,
  toMessage,
  toWireKind,
} from './map.js';
import { EVENTS, NAMESPACE, PAGE_MAX, SOCKET_PATH } from './protocol.js';
import { openSseStream, type SseFrame } from './sse.js';
import type {
  Attachment,
  AttachmentKind,
  ConnectionState,
  ConversationHours,
  ConversationStatus,
  ConversationSummary,
  StartConversationInput,
  Subscription,
  WidgetEvent,
  WidgetTransport,
} from './types.js';

/**
 * The real transport (M4-04), loaded in its own chunk so `widget.js` stays
 * inside its 40 KB (DOMAIN-RULES §14). REST for everything that must happen,
 * the `/widget` socket for being told, and SSE over `fetch` when a WebSocket
 * will not connect.
 *
 * What it keeps to itself, so the UI never has to:
 * - **The credential.** `visitor_secret` is issued by the first session call
 *   and kept in `localStorage` for the brand (DOMAIN-RULES §4.1). It goes out
 *   in the `Authorization` header and the socket handshake, and nothing else
 *   — the UI, the element and `window.Helpdock` never see it.
 * - **Idempotent starts.** A conversation is opened with a `clientId` chosen
 *   once and repeated by every retry, so a start whose answer was lost does
 *   not open a second one.
 * - **Uploads.** A file is held until the message (or the contact form) that
 *   carries it is sent, because only then is there a conversation to upload
 *   it to; the upload runs once however often the send is retried.
 *
 * Gap detection, dedupe and the catch-up cursor are the UI controller's
 * (`state/thread.ts`); this reports connection changes and events, mapped to
 * the UI's types (`map.ts`).
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The subset of a Socket.IO client socket used here; a test passes a fake. */
export type LiveSocket = Pick<
  Socket,
  'on' | 'emit' | 'emitWithAck' | 'connect' | 'disconnect' | 'connected'
>;

/** What the transport listens to for the browser's own idea of the network. */
export interface NetworkEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

export interface RemoteTransportOptions {
  /** The Helpdock origin `widget.js` was served from. */
  readonly apiOrigin: string;
  /** The brand's id, from `data-brand`. */
  readonly brand: string;
  readonly storage?: KeyValueStore;
  readonly fetch?: FetchLike;
  readonly openSocket?: (auth: { brandId: string; visitorSecret: string }) => LiveSocket;
  readonly network?: NetworkEvents | null;
  /** Failed socket connects before falling back to SSE. */
  readonly socketAttemptsBeforeSse?: number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** A handshake refusal a retry or a fallback cannot fix. */
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

/** `localStorage`, or memory where the browser refuses it (a sandboxed frame, private mode). */
const defaultStore = (): KeyValueStore => {
  try {
    const store = globalThis.localStorage;
    store.getItem('helpdock:probe');
    return store;
  } catch {
    return memoryStore();
  }
};

export const secretKeyFor = (brandId: string): string => `helpdock:${brandId}:visitor`;

interface HeldUpload {
  readonly blob: Blob;
  readonly name: string;
  readonly kind: AttachmentKind;
  /** Set once uploaded, with the conversation it was uploaded to. */
  uploaded: { readonly conversationId: string; readonly attachment: WireAttachment } | null;
}

interface Current {
  readonly id: string;
  status: ConversationStatus;
  readonly visitorEmail: string | null;
  aiHandedOff: boolean;
  /** M7-06: the team's hours as the server last judged them; undefined from an older server. */
  hours: ConversationHours | undefined;
}

export function createRemoteTransport(options: RemoteTransportOptions): WidgetTransport {
  const store = options.storage ?? defaultStore();
  const key = secretKeyFor(options.brand);
  const http = new HttpClient({
    apiUrl: options.apiOrigin,
    brandId: options.brand,
    secret: () => store.getItem(key),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const openSocket =
    options.openSocket ??
    ((auth) =>
      io(`${options.apiOrigin.replace(/\/$/, '')}${NAMESPACE}`, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        auth,
        reconnectionDelayMax: 10_000,
      }));
  const network =
    options.network === undefined ? (globalThis as unknown as NetworkEvents) : options.network;
  const attemptsBeforeSse = options.socketAttemptsBeforeSse ?? 3;

  let brandName = '';
  let availability: WireAvailability | null = null;
  /** The last search's log row and its hits, sent back when the visitor opens one of them. */
  let lastSearch: { readonly id: string; readonly articleIds: ReadonlySet<string> } | null = null;
  let current: Current | null = null;
  let listener: Subscription | null = null;
  let socket: LiveSocket | null = null;
  let closeSse: (() => void) | null = null;
  let failedConnects = 0;
  let connection: ConnectionState = 'connecting';
  /** The `clientId` of a start not yet answered, repeated by its retries. */
  let pendingStart: string | null = null;
  /** The contact form's ids, kept until the whole submission has landed. */
  let pendingForm: { readonly start: string; readonly message: string } | null = null;
  const uploads = new Map<string, HeldUpload>();

  const report = (state: ConnectionState): void => {
    connection = state;
    listener?.onConnection(state);
  };
  const emit = (event: WidgetEvent): void => listener?.onEvent(event);

  const summary = (): ConversationSummary | null =>
    current === null
      ? null
      : {
          id: current.id,
          status: current.status,
          agent: null,
          department: null,
          visitor_email: current.visitorEmail,
          read_seq: 0,
          ai_handed_off: current.aiHandedOff,
          ...(current.hours === undefined ? {} : { hours: current.hours }),
        };

  const announce = (): void => {
    const conversation = summary();
    if (conversation !== null) {
      emit({ type: 'conversation', conversation });
    }
  };

  const moveTo = (status: ConversationStatus): boolean => {
    if (current === null || current.status === status) {
      return false;
    }
    current.status = status;
    announce();
    return true;
  };

  /** M7-06: the assistant stepped back, once and for good; the UI hides "Talk to a human". */
  const handOver = (handedOff: boolean): boolean => {
    if (current === null || !handedOff || current.aiHandedOff) {
      return false;
    }
    current.aiHandedOff = true;
    announce();
    return true;
  };

  /** M7-06: keeps the hours a frame carries; true when they differ from the ones held. */
  const keepHours = (wire: WireHours | undefined): boolean => {
    if (current === null || wire === undefined) {
      return false;
    }
    const next = toHours(wire);
    const held = current.hours;
    if (
      held?.open === next.open &&
      held.next_open_at === next.next_open_at &&
      held.timezone === next.timezone
    ) {
      return false;
    }
    current.hours = next;
    return true;
  };

  /** One handler for a socket frame and an SSE frame alike: they are the same envelope. */
  const dispatch = (event: string, envelope: WidgetEnvelope<unknown>): void => {
    const mine = (conversationId: string) => current?.id === conversationId;
    switch (event) {
      case EVENTS.message: {
        const message = envelope.data as WireMessage;
        if (mine(message.conversationId)) {
          emit({ type: 'message', message: toMessage(message, brandName) });
        }
        return;
      }
      case EVENTS.receipt: {
        const receipt = envelope.data as WidgetReceipt;
        if (mine(receipt.conversationId)) {
          emit({ type: 'receipt', kind: receipt.kind, seq: receipt.seq });
        }
        return;
      }
      case EVENTS.typing: {
        const typing = envelope.data as WidgetTyping;
        if (mine(typing.conversationId)) {
          emit({
            type: 'typing',
            typing: typing.typing,
            agent: typing.typing ? agentOf(typing.agentName, null, brandName) : null,
          });
        }
        return;
      }
      case EVENTS.queue: {
        const queue = envelope.data as WidgetQueue;
        if (!mine(queue.conversationId) || current?.status === 'ended') {
          return;
        }
        if (queue.position === null) {
          moveTo('active');
        } else {
          moveTo('queued');
          emit({ type: 'queue', position: queue.position, eta_seconds: null });
        }
        return;
      }
      case EVENTS.conversation: {
        const moved = envelope.data as WidgetConversationEvent;
        if (mine(moved.conversationId)) {
          // Hours first, so a frame that also hands off or closes says them once, in that event.
          const hoursMoved = keepHours(moved.hours);
          const handedOver = handOver(moved.aiHandedOff === true);
          const statusMoved = moveTo(statusOf(moved, null));
          if (hoursMoved && !handedOver && !statusMoved) {
            announce();
          }
        }
        return;
      }
      case EVENTS.csat: {
        const csat = envelope.data as WidgetCsat;
        if (mine(csat.conversationId)) {
          emit({ type: 'csat', csat: toCsat(csat) });
        }
        return;
      }
      case EVENTS.presence: {
        const { agentsOnline, agents } = envelope.data as WidgetPresence;
        if (availability !== null) {
          availability = { ...availability, agentsOnline, agents };
          emit({ type: 'presence', availability: toAvailability(availability) });
        }
        return;
      }
    }
  };

  const join = (live: LiveSocket): void => {
    if (current !== null) {
      void live.emitWithAck(EVENTS.join, { conversationId: current.id }).catch(() => undefined);
    }
  };

  const openStream = (): void => {
    if (current === null || closeSse !== null) {
      // With no conversation there is nothing to stream; REST alone answers.
      report('online');
      return;
    }
    const conversationId = current.id;
    let last = 0;
    closeSse = openSseStream({
      http,
      conversationId,
      after: () => last,
      onFrame: (frame: SseFrame) => {
        last = Math.max(last, frame.envelope.seq ?? 0);
        dispatch(frame.event, frame.envelope);
      },
      onOpen: () => report('online'),
      onError: () => report('reconnecting'),
      ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    });
  };

  const fallBackToSse = (): void => {
    socket?.disconnect();
    socket = null;
    openStream();
  };

  const ensureLive = (): void => {
    const secret = store.getItem(key);
    if (secret === null) {
      return;
    }
    if (failedConnects >= attemptsBeforeSse) {
      openStream();
      return;
    }
    if (socket !== null) {
      if (socket.connected) {
        join(socket);
      }
      return;
    }
    const live = openSocket({ brandId: options.brand, visitorSecret: secret });
    socket = live;
    for (const event of Object.values(EVENTS)) {
      live.on(event, (envelope: WidgetEnvelope<unknown>) => dispatch(event, envelope));
    }
    live.on('connect', () => {
      failedConnects = 0;
      join(live);
      report('online');
    });
    live.on('disconnect', () => report('reconnecting'));
    live.on('connect_error', (error: Error & { data?: { code?: string } }) => {
      failedConnects += 1;
      if (FINAL_HANDSHAKE_CODES.has(error.data?.code ?? '')) {
        live.disconnect();
        socket = null;
        return;
      }
      if (failedConnects >= attemptsBeforeSse) {
        fallBackToSse();
      } else if (connection === 'online') {
        report('reconnecting');
      }
    });
  };

  // The browser knows before a socket's ping times out: say so at once, and
  // reconnect the moment it is back, so the UI catches up without anybody
  // pressing anything (DOMAIN-RULES §7).
  const onOffline = () => report('reconnecting');
  const onOnline = () => {
    if (socket?.connected === true) {
      // The socket outlived the outage, so nothing will reconnect it: say so
      // here, and the UI catches up on whatever the outage hid.
      report('online');
    } else if (socket !== null) {
      socket.connect();
    } else if (closeSse === null) {
      ensureLive();
    }
  };

  const conversationPath = (conversationId: string, rest = ''): string =>
    `/conversations/${conversationId}${rest}`;

  const positionOf = async (conversation: WireConversation): Promise<number | null> => {
    if (conversation.state === 'closed') {
      return null;
    }
    try {
      return (await http.get<WidgetQueue>(conversationPath(conversation.id, '/queue'))).position;
    } catch {
      // The socket's join sends the position too; until then it waits in the queue.
      return 1;
    }
  };

  const adopt = async (
    conversation: WireConversation,
    visitorEmail: string | null,
  ): Promise<ConversationSummary> => {
    const position = await positionOf(conversation);
    current = {
      id: conversation.id,
      status: statusOf(conversation, position),
      visitorEmail,
      aiHandedOff: conversation.aiHandedOff ?? false,
      hours: conversation.hours === undefined ? undefined : toHours(conversation.hours),
    };
    return toConversation(conversation, position, visitorEmail);
  };

  const start = async (
    clientId: string,
    input: StartConversationInput,
  ): Promise<WireConversation> => {
    const custom = Object.fromEntries(
      Object.entries(input.fields ?? {}).filter(([, value]) => value.trim() !== ''),
    );
    const prechat = {
      ...(input.name ? { name: input.name } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(Object.keys(custom).length === 0 ? {} : { custom }),
    };
    const response = await http.post<WidgetStartResponse>('/conversations', {
      clientId,
      ...(Object.keys(prechat).length === 0 ? {} : { prechat }),
      ...(input.captcha_token === undefined ? {} : { captchaToken: input.captcha_token }),
      ...(input.article_id === undefined ? {} : { articleId: input.article_id }),
    });
    return response.conversation;
  };

  const findArticles = async (
    query: string,
    locale: string,
    purpose: 'search' | 'suggest',
  ): Promise<WidgetArticleSearch> =>
    http.get<WidgetArticleSearch>(
      `/articles?q=${encodeURIComponent(query)}&locale=${locale}&purpose=${purpose}`,
    );

  /** Presign, PUT and confirm (ARCHITECTURE §9), once per held file and conversation. */
  const upload = async (conversationId: string, id: string): Promise<string> => {
    const held = uploads.get(id);
    if (held === undefined) {
      return id;
    }
    if (held.uploaded?.conversationId !== conversationId) {
      const presign = await http.post<AttachmentPresignResponse>(
        conversationPath(conversationId, '/attachments'),
        {
          kind: toWireKind(held.kind),
          // `MediaRecorder` names its codec (`audio/webm;codecs=opus`); the api wants the type.
          mime: (held.blob.type.split(';')[0] ?? '').trim() || 'application/octet-stream',
          size: held.blob.size,
          fileName: held.name,
        },
      );
      await http.put(presign.url, presign.headers, held.blob);
      held.uploaded = {
        conversationId,
        attachment: await http.post<WireAttachment>(
          conversationPath(conversationId, `/attachments/${presign.attachmentId}/confirm`),
          {},
        ),
      };
    }
    return held.uploaded.attachment.id;
  };

  const send = async (
    conversationId: string,
    clientId: string,
    text: string,
    attachmentIds: readonly string[],
  ): Promise<WidgetSendResponse> => {
    const ids: string[] = [];
    for (const id of attachmentIds) {
      ids.push(await upload(conversationId, id));
    }
    const response = await http.post<WidgetSendResponse>(
      conversationPath(conversationId, '/messages'),
      { clientId, text, attachmentIds: ids },
    );
    for (const id of attachmentIds) {
      uploads.delete(id);
    }
    return response;
  };

  return {
    async getConfig(locale) {
      const config = await http.get<WireConfig>(`/config?locale=${locale}`);
      brandName = config.brandName;
      availability = config.availability;

      return toConfig(config);
    },

    async startSession(identity) {
      const session = await http.post<WidgetSession>('/session', {
        ...(identity === null
          ? {}
          : {
              identity: {
                payload: {
                  user_id: identity.user_id,
                  ...(identity.email === undefined ? {} : { email: identity.email }),
                  ...(identity.name === undefined ? {} : { name: identity.name }),
                  ts: identity.ts,
                },
                signature: identity.signature,
              },
            }),
      });
      if (session.visitorSecret !== null) {
        store.setItem(key, session.visitorSecret);
      }
      const { conversations } = await http.get<WidgetConversationList>('/conversations');
      // Newest first: the open chat this visitor may pick up again, if any.
      const resumable = conversations.find(
        (conversation) => conversation.state === 'open' && conversation.channel === 'chat',
      );
      return {
        visitor_id: session.visitorId,
        conversation: resumable === undefined ? null : await adopt(resumable, null),
      };
    },

    async startConversation(input) {
      pendingStart ??= uuidv7();
      const conversation = await start(pendingStart, input);
      pendingStart = null;
      return adopt(conversation, input.email ?? null);
    },

    async sendMessage(conversationId, input) {
      const response = await send(
        conversationId,
        input.client_id,
        input.body,
        input.attachment_ids,
      );
      return toMessage(response.message, brandName);
    },

    async listMessages(conversationId, after) {
      const messages: WireMessage[] = [];
      let cursor = after;
      for (;;) {
        const page = await http.get<WidgetMessagePage>(
          conversationPath(conversationId, `/messages?after=${String(cursor)}&limit=${PAGE_MAX}`),
        );
        messages.push(...page.messages);
        if (!page.hasMore || page.lastSeq <= cursor) {
          break;
        }
        cursor = page.lastSeq;
      }
      return messages.map((message) => toMessage(message, brandName));
    },

    subscribe(conversationId, subscription) {
      listener = subscription;
      if (current?.id !== conversationId) {
        current = null;
      }
      closeSse?.();
      closeSse = null;
      subscription.onConnection(connection);
      network?.addEventListener('offline', onOffline);
      network?.addEventListener('online', onOnline);
      ensureLive();

      return () => {
        if (listener === subscription) {
          listener = null;
        }
        network?.removeEventListener('offline', onOffline);
        network?.removeEventListener('online', onOnline);
        if (conversationId !== null) {
          socket?.emit(EVENTS.leave, { conversationId });
        }
      };
    },

    sendTyping(conversationId, typing) {
      if (socket?.connected === true) {
        socket.emit(EVENTS.typingSet, { conversationId, typing });
        return;
      }
      void http
        .post(conversationPath(conversationId, '/typing'), { typing })
        .catch(() => undefined);
    },

    async markRead(conversationId, seq) {
      if (socket?.connected === true) {
        socket.emit(EVENTS.read, { conversationId, seq });
        return;
      }
      await http.post(conversationPath(conversationId, '/read'), { seq });
    },

    async uploadAttachment(file, name, kind): Promise<Attachment> {
      const id = uuidv7();
      uploads.set(id, { blob: file, name, kind, uploaded: null });
      return {
        id,
        kind,
        name,
        mime: file.type,
        size_bytes: file.size,
        duration_seconds: null,
      };
    },

    async attachmentUrl(conversationId, attachmentId) {
      const held = uploads.get(attachmentId);
      if (held !== undefined) {
        return URL.createObjectURL(held.blob);
      }
      const download = await http.get<{ url: string }>(
        conversationPath(conversationId, `/attachments/${attachmentId}`),
      );
      return download.url;
    },

    async requestTranscript(conversationId, email) {
      await http.post(conversationPath(conversationId, '/transcript'), { email });
    },

    async handOff(conversationId) {
      const conversation = await http.post<WireConversation>(
        conversationPath(conversationId, '/handoff'),
        {},
      );
      if (current?.id === conversationId) {
        current.aiHandedOff = conversation.aiHandedOff ?? true;
        keepHours(conversation.hours);
      }
      return toConversation(
        conversation,
        await positionOf(conversation),
        current?.visitorEmail ?? null,
      );
    },

    async sendFeedback(conversationId, messageId, feedback) {
      await http.post(conversationPath(conversationId, `/messages/${messageId}/feedback`), {
        feedback,
      });
    },

    async getCsat(conversationId) {
      const { csat } = await http.get<WidgetCsatResponse>(
        conversationPath(conversationId, '/csat'),
      );
      return csat === null ? null : toCsat(csat);
    },

    async rateConversation(conversationId, rating, comment) {
      const { csat } = await http.post<WidgetCsatResponse>(
        conversationPath(conversationId, '/csat'),
        { rating, ...(comment.trim() === '' ? {} : { comment }) },
      );
      return csat === null ? null : toCsat(csat);
    },

    async skipCsat(conversationId) {
      const { csat } = await http.post<WidgetCsatResponse>(
        conversationPath(conversationId, '/csat/skip'),
        {},
      );
      return csat === null ? null : toCsat(csat);
    },

    async submitContactForm(input) {
      pendingForm ??= { start: uuidv7(), message: uuidv7() };
      const form = pendingForm;
      const conversation = await start(form.start, {
        name: input.name,
        email: input.email,
        fields: input.fields,
        ...(input.captcha_token === undefined ? {} : { captcha_token: input.captcha_token }),
        ...(input.article_id === undefined ? {} : { article_id: input.article_id }),
      });
      await send(conversation.id, form.message, input.message, input.attachment_ids);
      pendingForm = null;
      return { ticket_ref: conversation.reference };
    },

    async searchArticles(query, locale) {
      const found = await findArticles(query, locale, 'search');
      lastSearch =
        found.searchId === null
          ? null
          : { id: found.searchId, articleIds: new Set(found.articles.map(({ id }) => id)) };
      return found.articles;
    },

    async suggestArticles(query, locale) {
      return (await findArticles(query, locale, 'suggest')).articles;
    },

    async getArticle(id, locale) {
      const searchId = lastSearch?.articleIds.has(id) ? lastSearch.id : null;
      const article = await http.get<WireArticle>(
        `/articles/${encodeURIComponent(id)}?locale=${locale}${searchId === null ? '' : `&searchId=${searchId}`}`,
      );
      return toArticle(article);
    },
  };
}
