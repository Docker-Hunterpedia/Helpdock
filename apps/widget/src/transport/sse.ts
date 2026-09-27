import type { WidgetEnvelope } from '@helpdock/schemas';
import type { HttpClient } from './http.js';

/**
 * The SSE fallback of DOMAIN-RULES §7: `GET …/stream?conversationId=…&after=…`
 * read with `fetch`, because `EventSource` cannot send the `Authorization`
 * header. The frames are the socket's envelopes under the socket's event
 * names, so one handler serves both.
 *
 * The server ends a stream after five minutes; this reopens it after the
 * `retry` the server asked for, from the cursor the caller holds *now*, so a
 * reconnect never replays and never skips.
 */

export interface SseFrame {
  readonly event: string;
  readonly envelope: WidgetEnvelope<unknown>;
}

/** Splits a text buffer into complete frames and what is left over. */
export const parseSse = (
  buffer: string,
): { readonly frames: SseFrame[]; readonly rest: string; readonly retryMs: number | null } => {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames: SseFrame[] = [];
  let retryMs: number | null = null;

  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        data.push(value);
      } else if (field === 'retry' && /^\d+$/.test(value)) {
        retryMs = Number(value);
      }
    }
    if (data.length > 0) {
      try {
        frames.push({ event, envelope: JSON.parse(data.join('\n')) as WidgetEnvelope<unknown> });
      } catch {
        // A frame that is not JSON is not ours; the next catch-up covers it.
      }
    }
  }

  return { frames, rest, retryMs };
};

export interface SseStreamOptions {
  readonly http: HttpClient;
  readonly conversationId: string;
  /** Read at every (re)connect, so the stream resumes from the cursor as it is then. */
  readonly after: () => number;
  readonly onFrame: (frame: SseFrame) => void;
  readonly onOpen?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
}

/** Opens the stream and keeps it open until the returned function is called. */
export const openSseStream = (options: SseStreamOptions): (() => void) => {
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  let closed = false;
  let retryMs = 2_000;
  let controller: AbortController | null = null;

  const connect = async (): Promise<void> => {
    if (closed) {
      return;
    }
    controller = new AbortController();
    try {
      const response = await options.http.stream(
        `/stream?conversationId=${options.conversationId}&after=${String(options.after())}`,
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!response.ok || reader === undefined) {
        throw new Error(`The stream answered ${String(response.status)}`);
      }
      options.onOpen?.();

      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        const parsed = parseSse(buffer + decoder.decode(chunk.value, { stream: true }));
        buffer = parsed.rest;
        retryMs = parsed.retryMs ?? retryMs;
        for (const frame of parsed.frames) {
          options.onFrame(frame);
        }
      }
    } catch (error) {
      if (!closed) {
        options.onError?.(error);
      }
    }
    if (!closed) {
      schedule(() => void connect(), retryMs);
    }
  };

  void connect();

  return () => {
    closed = true;
    controller?.abort();
  };
};
