import type {
  AgentSummary,
  Attachment,
  AttachmentKind,
  Availability,
  ConnectionState,
  ConversationSummary,
  SignedIdentity,
  StartConversationInput,
  WidgetConfig,
  WidgetEvent,
  WidgetLocale,
  WidgetMessage,
  WidgetTransport,
} from '../transport/types.js';
import { checkFile, checkFiles, type FileLike, kindOf, type PolicyProblem } from './policy.js';
import { uuidv7, withRetries } from './send.js';
import {
  addPending,
  applyCatchUp,
  applyLive,
  applyReadReceipt,
  emptyThread,
  setPendingStatus,
  type ThreadState,
} from './thread.js';

/**
 * Everything the widget draws, and the actions that change it. Components read
 * this state and call these actions; only this module talks to the transport,
 * so the delivery rules (DOMAIN-RULES §7) live in one place.
 */
export interface WidgetState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly locale: WidgetLocale;
  readonly config: WidgetConfig | null;
  readonly open: boolean;
  readonly conversation: ConversationSummary | null;
  readonly thread: ThreadState;
  readonly availability: Availability | null;
  readonly typing: AgentSummary | null;
  readonly queue: { readonly position: number; readonly eta_seconds: number | null } | null;
  readonly connection: ConnectionState;
  /** Set after a reconnect's catch-up, for "Back online" and the "N new messages" divider. */
  readonly reconnected: { readonly newCount: number; readonly firstNewSeq: number | null } | null;
  readonly unread: number;
  readonly visitorEmail: string | null;
  /** The system line drawn after the visitor's first message (`WidgetStatesEN`, columns 2 and 4). */
  readonly firstMessageNotice: 'talking' | 'closed' | null;
  readonly attachmentProblem: PolicyProblem | null;
}

type Listener = (state: WidgetState) => void;

interface Draft {
  readonly body: string;
  readonly files: readonly {
    readonly blob: Blob;
    readonly name: string;
    readonly kind: AttachmentKind;
  }[];
  uploaded: Attachment[];
}

const TYPING_IDLE_MS = 3_000;

export class WidgetController {
  #state: WidgetState;
  readonly #listeners = new Set<Listener>();
  readonly #transport: WidgetTransport;
  readonly #drafts = new Map<string, Draft>();
  readonly #inFlight = new Set<string>();
  #identity: SignedIdentity | null = null;
  #unsubscribe: (() => void) | null = null;
  #wasDisconnected = false;
  #typingTimer: ReturnType<typeof setTimeout> | null = null;
  #starting: Promise<ConversationSummary> | null = null;
  #articleId: string | null = null;

  constructor(transport: WidgetTransport, locale: WidgetLocale) {
    this.#transport = transport;
    this.#state = {
      status: 'loading',
      locale,
      config: null,
      open: false,
      conversation: null,
      thread: emptyThread,
      availability: null,
      typing: null,
      queue: null,
      connection: 'connecting',
      reconnected: null,
      unread: 0,
      visitorEmail: null,
      firstMessageNotice: null,
      attachmentProblem: null,
    };
  }

  get state(): WidgetState {
    return this.#state;
  }

  get transport(): WidgetTransport {
    return this.#transport;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<WidgetState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }

  async init(): Promise<void> {
    try {
      const identity = this.#identity;
      const [config, first] = await Promise.all([
        this.#transport.getConfig(this.#state.locale),
        this.#transport.startSession(identity),
      ]);
      // `Helpdock('identify')` may land while the anonymous session was starting.
      const session =
        this.#identity === identity ? first : await this.#transport.startSession(this.#identity);
      this.#set({ config, availability: config.availability, status: 'ready' });
      await this.#attach(session.conversation);
    } catch {
      this.#set({ status: 'failed' });
    }
  }

  /** M4-02: the host page's signed identity. A later call restarts the session under it. */
  async identify(identity: SignedIdentity): Promise<void> {
    this.#identity = identity;
    if (this.#state.status !== 'ready') {
      return;
    }
    const session = await this.#transport.startSession(identity);
    await this.#attach(session.conversation);
  }

  async #attach(conversation: ConversationSummary | null): Promise<void> {
    this.#unsubscribe?.();
    this.#set({
      conversation,
      // Messages queued before the conversation existed are what start it.
      thread: {
        ...emptyThread,
        pending: this.#state.thread.pending,
        readSeq: conversation?.read_seq ?? 0,
      },
      visitorEmail: conversation?.visitor_email ?? this.#state.visitorEmail,
      typing: null,
      queue: null,
      reconnected: null,
    });
    this.#unsubscribe = this.#transport.subscribe(conversation?.id ?? null, {
      onEvent: (event) => this.#onEvent(event),
      onConnection: (state) => this.#onConnection(state),
    });
    if (conversation) {
      await this.#catchUp(false);
    }
  }

  setOpen(open: boolean): void {
    this.#set({ open, ...(open ? { unread: 0 } : {}) });
    if (open) {
      this.#markRead();
    }
  }

  #markRead(): void {
    const { conversation, thread } = this.#state;
    if (conversation && thread.lastSeq > 0) {
      this.#transport.markRead(conversation.id, thread.lastSeq).catch(() => undefined);
    }
  }

  /**
   * M5-08: the help center article "Still need help?" was pressed on
   * (`Helpdock('open', { article })`). The next conversation the visitor
   * starts carries it, so the agents see where they came from; then it is spent.
   */
  setArticleContext(articleId: string | null): void {
    this.#articleId = articleId;
  }

  get articleId(): string | null {
    return this.#articleId;
  }

  #withArticle(input: StartConversationInput): StartConversationInput {
    return this.#articleId === null ? input : { ...input, article_id: this.#articleId };
  }

  async startConversation(input: StartConversationInput): Promise<void> {
    const conversation = await this.#transport.startConversation(this.#withArticle(input));
    this.#articleId = null;
    this.#set({ visitorEmail: input.email ?? this.#state.visitorEmail });
    await this.#attach(conversation);
  }

  /** One conversation however many messages are queued before it exists. */
  #ensureConversation(): Promise<ConversationSummary> {
    const { conversation } = this.#state;
    if (conversation) {
      return Promise.resolve(conversation);
    }
    this.#starting ??= this.#transport
      .startConversation(this.#withArticle({}))
      .then(async (started) => {
        this.#articleId = null;
        await this.#attach(started);
        return started;
      })
      .finally(() => {
        this.#starting = null;
      });
    return this.#starting;
  }

  send(body: string): void {
    const text = body.trim();
    if (text) {
      this.#queue({ body: text, files: [], uploaded: [] });
    }
  }

  sendFiles(files: readonly (FileLike & Blob)[]): void {
    const { config } = this.#state;
    if (!config) {
      return;
    }
    const problem = checkFiles(files, config.content_policy);
    this.#set({ attachmentProblem: problem });
    if (!problem && files.length > 0) {
      this.#queue({
        body: '',
        files: files.map((file) => ({ blob: file, name: file.name, kind: kindOf(file.type) })),
        uploaded: [],
      });
    }
  }

  sendVoice(blob: Blob, name: string): void {
    const { config } = this.#state;
    if (!config) {
      return;
    }
    const problem = checkFile(
      { name, type: blob.type, size: blob.size },
      'voice',
      config.content_policy.voice,
    );
    this.#set({ attachmentProblem: problem });
    if (!problem) {
      this.#queue({ body: '', files: [{ blob, name, kind: 'voice' }], uploaded: [] });
    }
  }

  dismissAttachmentProblem(): void {
    this.#set({ attachmentProblem: null });
  }

  #queue(draft: Draft): void {
    const clientId = uuidv7();
    this.#drafts.set(clientId, draft);
    const isFirst =
      this.#state.thread.pending.length === 0 &&
      !this.#state.thread.confirmed.some((message) => message.author.kind === 'visitor');

    this.#set({
      thread: addPending(this.#state.thread, {
        client_id: clientId,
        body: draft.body,
        attachments: draft.files.map((file, index) => ({
          id: `${clientId}:${index}`,
          kind: file.kind,
          name: file.name,
          mime: file.blob.type,
          size_bytes: file.blob.size,
          duration_seconds: null,
        })),
        status: 'sending',
        created_at: new Date().toISOString(),
      }),
      ...(isFirst && this.#state.visitorEmail
        ? {
            firstMessageNotice: this.#state.availability?.state === 'closed' ? 'closed' : 'talking',
          }
        : {}),
    });
    this.#stopTyping();
    // While the socket is down the message waits as "sending"; it goes out on
    // reconnect (`WidgetStatesEN`, column 5).
    if (this.#state.connection !== 'reconnecting') {
      void this.#deliver(clientId);
    }
  }

  retry(clientId: string): void {
    this.#set({ thread: setPendingStatus(this.#state.thread, clientId, 'sending') });
    void this.#deliver(clientId);
  }

  async #deliver(clientId: string): Promise<void> {
    const draft = this.#drafts.get(clientId);
    if (!draft || this.#inFlight.has(clientId)) {
      return;
    }
    this.#inFlight.add(clientId);
    try {
      const conversation = await withRetries(() => this.#ensureConversation());
      for (const file of draft.files.slice(draft.uploaded.length)) {
        draft.uploaded.push(
          await withRetries(() =>
            this.#transport.uploadAttachment(file.blob, file.name, file.kind),
          ),
        );
      }
      const message = await withRetries(() =>
        this.#transport.sendMessage(conversation.id, {
          client_id: clientId,
          body: draft.body,
          attachment_ids: draft.uploaded.map((attachment) => attachment.id),
        }),
      );
      this.#drafts.delete(clientId);
      this.#applyLive(message);
    } catch {
      this.#set({ thread: setPendingStatus(this.#state.thread, clientId, 'failed') });
    } finally {
      this.#inFlight.delete(clientId);
    }
  }

  #applyLive(message: WidgetMessage): void {
    const result = applyLive(this.#state.thread, message);
    const fromOthers = result.added.filter((entry) => entry.author.kind !== 'visitor').length;
    this.#set({
      thread: result.state,
      unread: this.#state.open ? 0 : this.#state.unread + fromOthers,
      ...(fromOthers > 0 ? { typing: null } : {}),
    });
    if (fromOthers > 0 && this.#state.open) {
      this.#markRead();
    }
    if (result.gap) {
      void this.#catchUp(false);
    }
  }

  async #catchUp(announce: boolean): Promise<void> {
    const { conversation } = this.#state;
    if (!conversation) {
      return;
    }
    try {
      const messages = await this.#transport.listMessages(
        conversation.id,
        this.#state.thread.lastSeq,
      );
      const result = applyCatchUp(this.#state.thread, messages);
      const fresh = result.added.filter((entry) => entry.author.kind !== 'visitor');
      this.#set({
        thread: result.state,
        ...(announce
          ? { reconnected: { newCount: fresh.length, firstNewSeq: fresh[0]?.seq ?? null } }
          : {}),
        unread: this.#state.open ? 0 : this.#state.unread + (announce ? fresh.length : 0),
      });
      if (this.#state.open) {
        this.#markRead();
      }
    } catch {
      // The next reconnect or gap tries again; REST stays the source of truth.
    }
  }

  #onConnection(connection: ConnectionState): void {
    const recovering = connection === 'online' && this.#wasDisconnected;
    if (connection === 'reconnecting') {
      this.#wasDisconnected = true;
    }
    this.#set({ connection, ...(connection === 'reconnecting' ? { reconnected: null } : {}) });
    if (!recovering) {
      return;
    }
    this.#wasDisconnected = false;
    void this.#catchUp(true);
    for (const entry of this.#state.thread.pending) {
      this.retry(entry.client_id);
    }
  }

  #onEvent(event: WidgetEvent): void {
    switch (event.type) {
      case 'message':
        this.#applyLive(event.message);
        break;
      case 'receipt':
        if (event.kind === 'read') {
          this.#set({ thread: applyReadReceipt(this.#state.thread, event.seq) });
        }
        break;
      case 'typing':
        this.#set({ typing: event.typing ? event.agent : null });
        break;
      case 'presence':
        this.#set({ availability: event.availability });
        break;
      case 'queue':
        this.#set({ queue: { position: event.position, eta_seconds: event.eta_seconds } });
        break;
      case 'conversation':
        this.#set({
          conversation: event.conversation,
          ...(event.conversation.status === 'queued' ? {} : { queue: null }),
          ...(event.conversation.status === 'ended' ? { typing: null } : {}),
        });
        break;
    }
  }

  clearReconnected(): void {
    this.#set({ reconnected: null });
  }

  /** Called on every keystroke; tells the agent side once, then again after a pause. */
  visitorTyping(): void {
    const { conversation } = this.#state;
    if (!conversation) {
      return;
    }
    if (!this.#typingTimer) {
      this.#transport.sendTyping(conversation.id, true);
    } else {
      clearTimeout(this.#typingTimer);
    }
    this.#typingTimer = setTimeout(() => this.#stopTyping(), TYPING_IDLE_MS);
  }

  #stopTyping(): void {
    if (!this.#typingTimer) {
      return;
    }
    clearTimeout(this.#typingTimer);
    this.#typingTimer = null;
    const { conversation } = this.#state;
    if (conversation) {
      this.#transport.sendTyping(conversation.id, false);
    }
  }

  async requestTranscript(email: string): Promise<void> {
    const { conversation } = this.#state;
    if (conversation) {
      await this.#transport.requestTranscript(conversation.id, email);
    }
  }

  async newConversation(): Promise<void> {
    this.#drafts.clear();
    this.#set({ thread: emptyThread, firstMessageNotice: null, attachmentProblem: null });
    await this.#attach(null);
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#typingTimer) {
      clearTimeout(this.#typingTimer);
    }
    this.#listeners.clear();
  }
}
