import {
  type AgentSummary,
  type AiFeedback,
  type AiPart,
  type ArticleDetail,
  type Attachment,
  type AttachmentKind,
  type Availability,
  type ConnectionState,
  type ConversationSummary,
  type CsatCard,
  type SignedIdentity,
  type Subscription,
  TransportError,
  type WidgetConfig,
  type WidgetEvent,
  type WidgetLocale,
  type WidgetMessage,
  type WidgetTransport,
} from './types.js';

/**
 * An in-memory server for unit tests and the Playwright harness. It keeps the
 * contract the real transport keeps (seq per conversation, dedupe on
 * `client_id`, catch-up by cursor) and adds levers a test pulls to play the
 * agent side or the network: `agentReply`, `dropConnection`, `failNextSends`.
 */
export interface MockOptions {
  readonly config: (locale: WidgetLocale) => WidgetConfig;
  readonly articles?: readonly ArticleDetail[];
  /** A conversation the visitor already has, to exercise resume and the ended state. */
  readonly resume?: {
    readonly conversation: ConversationSummary;
    readonly messages: WidgetMessage[];
    /** M8-06: the ended conversation's satisfaction card. */
    readonly csat?: CsatCard;
  };
}

export class MockTransport implements WidgetTransport {
  readonly #options: MockOptions;
  #conversation: ConversationSummary | null;
  #messages: WidgetMessage[];
  readonly #subscribers = new Set<Subscription>();
  #online = true;
  #failures = 0;
  #uploads = 0;
  #tickets = 1042;
  #csat: CsatCard | null;
  #failRating = false;
  /** Every call a test may want to assert on, in order. */
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];

  constructor(options: MockOptions) {
    this.#options = options;
    this.#conversation = options.resume?.conversation ?? null;
    this.#messages = [...(options.resume?.messages ?? [])];
    this.#csat = options.resume?.csat ?? null;
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #assertOnline(): void {
    if (!this.#online) {
      throw new TransportError('network');
    }
  }

  async getConfig(locale: WidgetLocale): Promise<WidgetConfig> {
    this.#record('getConfig', locale);
    return this.#options.config(locale);
  }

  async startSession(identity: SignedIdentity | null) {
    this.#record('startSession', identity);
    return { visitor_id: 'visitor-1', conversation: this.#conversation };
  }

  async startConversation(input: Parameters<WidgetTransport['startConversation']>[0]) {
    this.#record('startConversation', input);
    this.#assertOnline();
    this.#conversation = {
      id: 'conversation-1',
      status: 'queued',
      agent: null,
      department: null,
      visitor_email: input.email ?? null,
      read_seq: 0,
    };
    this.#messages = [];
    return this.#conversation;
  }

  async sendMessage(conversationId: string, input: Parameters<WidgetTransport['sendMessage']>[1]) {
    this.#record('sendMessage', conversationId, input);
    this.#assertOnline();
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new TransportError('network');
    }
    const existing = this.#messages.find((message) => message.client_id === input.client_id);
    if (existing) {
      return existing;
    }
    const message = this.#store({
      client_id: input.client_id,
      author: { kind: 'visitor' },
      body: input.body,
      attachments: input.attachment_ids.map((id) => this.#attachment(id)),
      system: null,
    });
    this.#emit({ type: 'message', message });
    return message;
  }

  async listMessages(conversationId: string, after: number) {
    this.#record('listMessages', conversationId, after);
    this.#assertOnline();
    return this.#messages.filter((message) => message.seq > after);
  }

  subscribe(conversationId: string | null, subscription: Subscription) {
    this.#record('subscribe', conversationId);
    this.#subscribers.add(subscription);
    queueMicrotask(() => subscription.onConnection(this.#online ? 'online' : 'reconnecting'));
    return () => {
      this.#subscribers.delete(subscription);
    };
  }

  sendTyping(conversationId: string, typing: boolean): void {
    this.#record('sendTyping', conversationId, typing);
  }

  async markRead(conversationId: string, seq: number): Promise<void> {
    this.#record('markRead', conversationId, seq);
  }

  readonly #uploaded = new Map<string, Attachment>();

  async uploadAttachment(file: Blob, name: string, kind: AttachmentKind): Promise<Attachment> {
    this.#record('uploadAttachment', name, kind);
    this.#assertOnline();
    this.#uploads += 1;
    const attachment: Attachment = {
      id: `upload-${this.#uploads}`,
      kind,
      name,
      mime: file.type,
      size_bytes: file.size,
      duration_seconds: kind === 'voice' ? 14 : null,
    };
    this.#uploaded.set(attachment.id, attachment);
    return attachment;
  }

  #attachment(id: string): Attachment {
    const attachment = this.#uploaded.get(id);
    if (!attachment) {
      throw new TransportError('not_found');
    }
    return attachment;
  }

  async attachmentUrl(conversationId: string, attachmentId: string): Promise<string> {
    this.#record('attachmentUrl', conversationId, attachmentId);
    return `data:text/plain,${encodeURIComponent(attachmentId)}`;
  }

  async requestTranscript(conversationId: string, email: string): Promise<void> {
    this.#record('requestTranscript', conversationId, email);
    this.#assertOnline();
  }

  async handOff(conversationId: string): Promise<ConversationSummary> {
    this.#record('handOff', conversationId);
    this.#assertOnline();
    if (!this.#conversation) {
      throw new TransportError('not_found');
    }
    this.#conversation = { ...this.#conversation, ai_handed_off: true };
    return this.#conversation;
  }

  async sendFeedback(conversationId: string, messageId: string, feedback: AiFeedback) {
    this.#record('sendFeedback', conversationId, messageId, feedback);
    this.#assertOnline();
    this.#messages = this.#messages.map((message) =>
      message.id === messageId && message.ai
        ? { ...message, ai: { ...message.ai, feedback } }
        : message,
    );
  }

  async getCsat(conversationId: string): Promise<CsatCard | null> {
    this.#record('getCsat', conversationId);
    this.#assertOnline();
    return this.#csat;
  }

  async rateConversation(
    conversationId: string,
    rating: number,
    comment: string,
  ): Promise<CsatCard | null> {
    this.#record('rateConversation', conversationId, rating, comment);
    this.#assertOnline();
    if (this.#failRating) {
      this.#failRating = false;
      throw new TransportError('unavailable');
    }
    if (this.#csat?.state === 'open' || this.#csat?.state === 'skipped') {
      this.#csat = { ...this.#csat, state: 'rated', rating, comment: comment.trim() || null };
    }
    return this.#csat;
  }

  async skipCsat(conversationId: string): Promise<CsatCard | null> {
    this.#record('skipCsat', conversationId);
    this.#assertOnline();
    if (this.#csat?.state === 'open') {
      this.#csat = { ...this.#csat, state: 'skipped', skipped_at: new Date().toISOString() };
    }
    return this.#csat;
  }

  async submitContactForm(input: Parameters<WidgetTransport['submitContactForm']>[0]) {
    this.#record('submitContactForm', input);
    this.#assertOnline();
    this.#tickets += 1;
    return { ticket_ref: `HD-${this.#tickets}` };
  }

  /** Every article the fixture has (or the popular ones), matched on title and excerpt. */
  async searchArticles(query: string, locale: WidgetLocale) {
    this.#record('searchArticles', query, locale);
    this.#assertOnline();
    return this.#find(query, locale);
  }

  async suggestArticles(query: string, locale: WidgetLocale) {
    this.#record('suggestArticles', query, locale);
    return this.#find(query, locale);
  }

  #find(query: string, locale: WidgetLocale) {
    const needle = query.trim().toLowerCase();
    const catalog = this.#options.articles ?? this.#options.config(locale).popular_articles;
    return catalog
      .filter((article) => `${article.title} ${article.excerpt}`.toLowerCase().includes(needle))
      .map(({ id, title, excerpt, section, url }) => ({ id, title, excerpt, section, url }));
  }

  async getArticle(id: string, locale: WidgetLocale): Promise<ArticleDetail> {
    this.#record('getArticle', id, locale);
    this.#assertOnline();
    const article = this.#options.articles?.find((entry) => entry.id === id);
    if (!article) {
      throw new TransportError('not_found');
    }
    return article;
  }

  // --- levers for tests -------------------------------------------------------

  #store(fields: Omit<WidgetMessage, 'id' | 'seq' | 'conversation_id' | 'created_at'>) {
    const seq = (this.#messages.at(-1)?.seq ?? 0) + 1;
    const message: WidgetMessage = {
      ...fields,
      id: `message-${seq}`,
      seq,
      conversation_id: this.#conversation?.id ?? 'conversation-1',
      created_at: new Date().toISOString(),
    };
    this.#messages.push(message);
    return message;
  }

  #emit(event: WidgetEvent): void {
    if (!this.#online) {
      return;
    }
    for (const subscriber of this.#subscribers) {
      subscriber.onEvent(event);
    }
  }

  #connection(state: ConnectionState): void {
    for (const subscriber of this.#subscribers) {
      subscriber.onConnection(state);
    }
  }

  get messages(): readonly WidgetMessage[] {
    return this.#messages;
  }

  /** The agent writes; the event is lost when the connection is down, as a socket would lose it. */
  agentReply(agent: AgentSummary, body: string): WidgetMessage {
    const message = this.#store({
      client_id: null,
      author: { kind: 'agent', agent },
      body,
      attachments: [],
      system: null,
    });
    this.#emit({ type: 'message', message });
    return message;
  }

  /** M7-06: the assistant answers, with its sources, or hands off with the brand's text. */
  aiReply(body: string, ai: AiPart): WidgetMessage {
    const message = this.#store({
      client_id: null,
      author: { kind: 'ai' },
      body,
      attachments: [],
      system: null,
      ai,
    });
    this.#emit({ type: 'message', message });
    if (ai.kind === 'handoff' && this.#conversation) {
      this.#conversation = { ...this.#conversation, ai_handed_off: true };
      this.#emit({ type: 'conversation', conversation: this.#conversation });
    }
    return message;
  }

  /** Stores a message without emitting it, so the next live event arrives with a gap. */
  storeSilently(agent: AgentSummary, body: string): WidgetMessage {
    return this.#store({
      client_id: null,
      author: { kind: 'agent', agent },
      body,
      attachments: [],
      system: null,
    });
  }

  assign(agent: AgentSummary, department: string | null): void {
    if (!this.#conversation) {
      return;
    }
    this.#conversation = { ...this.#conversation, status: 'active', agent, department };
    const message = this.#store({
      client_id: null,
      author: { kind: 'system' },
      body: '',
      attachments: [],
      system: { code: 'agent_joined', name: agent.name },
    });
    this.#emit({ type: 'conversation', conversation: this.#conversation });
    this.#emit({ type: 'message', message });
  }

  end(): void {
    if (!this.#conversation) {
      return;
    }
    this.#conversation = { ...this.#conversation, status: 'ended' };
    const message = this.#store({
      client_id: null,
      author: { kind: 'system' },
      body: '',
      attachments: [],
      system: { code: 'conversation_ended', name: this.#conversation.agent?.name ?? null },
    });
    this.#emit({ type: 'conversation', conversation: this.#conversation });
    this.#emit({ type: 'message', message });
  }

  emit(event: WidgetEvent): void {
    this.#emit(event);
  }

  /** M8-06: the survey job offers the ended conversation's card. */
  offerCsat(card: CsatCard = { state: 'open', rating: null, comment: null, skipped_at: null }) {
    this.#csat = card;
    this.#emit({ type: 'csat', csat: card });
  }

  /** The next rating fails, as an api that cannot be reached would. */
  failNextRating(): void {
    this.#failRating = true;
  }

  setAvailability(availability: Availability): void {
    this.#emit({ type: 'presence', availability });
  }

  dropConnection(): void {
    this.#online = false;
    this.#connection('reconnecting');
  }

  restoreConnection(): void {
    this.#online = true;
    this.#connection('online');
  }

  /** The next `count` sends fail with a network error, as a flaky link would. */
  failNextSends(count: number): void {
    this.#failures = count;
  }
}
