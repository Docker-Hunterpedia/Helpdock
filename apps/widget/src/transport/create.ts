import type { RemoteTransportOptions } from './remote.js';
import { TransportError, type WidgetTransport } from './types.js';

export interface TransportOptions {
  /** The Helpdock origin `widget.js` was served from; every call goes there. */
  readonly apiOrigin: string;
  /** The brand's id, from `data-brand` or `<helpdock-widget brand>`. */
  readonly brand: string;
}

type Loader = (options: RemoteTransportOptions) => Promise<WidgetTransport>;

const loadRemote: Loader = (options) =>
  import('./remote.js').then((module) => module.createRemoteTransport(options));

/**
 * The production transport, as a thin shell in `widget.js`: the real one
 * (`remote.ts`, with socket.io-client and the SSE reader) is its own lazy
 * chunk, fetched on the first call, so the entry stays inside the 40 KB of
 * DOMAIN-RULES §14. A chunk that cannot be fetched is a network failure,
 * which the widget words as it words any other.
 */
export function createTransport(
  options: TransportOptions,
  load: Loader = loadRemote,
): WidgetTransport {
  let loading: Promise<WidgetTransport> | null = null;
  const remote = (): Promise<WidgetTransport> => {
    loading ??= load(options).catch((error: unknown) => {
      loading = null;
      throw new TransportError('network', error instanceof Error ? error.message : 'offline');
    });
    return loading;
  };

  return {
    getConfig: (locale) => remote().then((t) => t.getConfig(locale)),
    startSession: (identity) => remote().then((t) => t.startSession(identity)),
    startConversation: (input) => remote().then((t) => t.startConversation(input)),
    sendMessage: (id, input) => remote().then((t) => t.sendMessage(id, input)),
    listMessages: (id, after) => remote().then((t) => t.listMessages(id, after)),
    subscribe(conversationId, subscription) {
      let unsubscribe: (() => void) | null = null;
      let cancelled = false;
      remote().then(
        (t) => {
          if (!cancelled) {
            unsubscribe = t.subscribe(conversationId, subscription);
          }
        },
        () => subscription.onConnection('reconnecting'),
      );
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
    sendTyping(id, typing) {
      remote().then(
        (t) => t.sendTyping(id, typing),
        () => undefined,
      );
    },
    markRead: (id, seq) => remote().then((t) => t.markRead(id, seq)),
    uploadAttachment: (file, name, kind) =>
      remote().then((t) => t.uploadAttachment(file, name, kind)),
    attachmentUrl: (id, attachmentId) => remote().then((t) => t.attachmentUrl(id, attachmentId)),
    requestTranscript: (id, email) => remote().then((t) => t.requestTranscript(id, email)),
    submitContactForm: (input) => remote().then((t) => t.submitContactForm(input)),
    searchArticles: (query, locale) => remote().then((t) => t.searchArticles(query, locale)),
    suggestArticles: (query, locale) => remote().then((t) => t.suggestArticles(query, locale)),
    getArticle: (id, locale) => remote().then((t) => t.getArticle(id, locale)),
  };
}
