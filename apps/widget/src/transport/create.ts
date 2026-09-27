import { TransportError, type WidgetTransport } from './types.js';

export interface TransportOptions {
  /** The Helpdock origin `widget.js` was served from; every call goes there. */
  readonly apiOrigin: string;
  /** The brand's public widget key, from `data-brand` or `<helpdock-widget brand>`. */
  readonly brand: string;
}

/**
 * The production transport. The server half of M4-04 (REST, the `/widget`
 * Socket.IO namespace and the SSE fallback) replaces this body; until then
 * every call reports `unavailable` and the widget stays hidden rather than
 * drawing a chat that cannot send.
 */
export function createTransport(_options: TransportOptions): WidgetTransport {
  const unavailable = () => Promise.reject(new TransportError('unavailable'));
  return {
    getConfig: unavailable,
    startSession: unavailable,
    startConversation: unavailable,
    sendMessage: unavailable,
    listMessages: unavailable,
    subscribe: () => () => undefined,
    sendTyping: () => undefined,
    markRead: unavailable,
    uploadAttachment: unavailable,
    attachmentUrl: unavailable,
    requestTranscript: unavailable,
    submitContactForm: unavailable,
    searchArticles: unavailable,
    getArticle: unavailable,
  };
}
