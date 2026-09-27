import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';
import { openSseStream, parseSse } from './sse.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const envelope = (seq: number | null) => ({
  seq,
  at: '2026-09-27T10:00:00.000Z',
  data: { n: seq },
});

describe('parseSse', () => {
  it('splits complete frames from the partial one, and reads retry', () => {
    const text = `retry: 2000\n\nevent: message\ndata: ${JSON.stringify(envelope(4))}\n\n: keep-alive\n\nevent: presence\ndata: {"se`;

    const parsed = parseSse(text);

    expect(parsed.retryMs).toBe(2000);
    expect(parsed.frames).toEqual([{ event: 'message', envelope: envelope(4) }]);
    expect(parsed.rest).toBe('event: presence\ndata: {"se');
  });

  it('skips a frame that is not JSON', () => {
    expect(parseSse('event: message\ndata: nope\n\n').frames).toEqual([]);
  });
});

describe('openSseStream', () => {
  const streamOf = (chunks: string[], status = 200): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      }),
      { status, headers: { 'content-type': 'text/event-stream' } },
    );

  it('hands every frame on, and reconnects from the cursor as it is then', async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return streamOf([`event: message\ndata: ${JSON.stringify(envelope(urls.length + 3))}\n\n`]);
    });
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => 's',
      fetch,
    });
    let cursor = 3;
    const frames: unknown[] = [];
    const reconnects: (() => void)[] = [];

    const close = openSseStream({
      http,
      conversationId: CONVERSATION,
      after: () => cursor,
      onFrame: (frame) => {
        frames.push(frame.envelope.seq);
        cursor = frame.envelope.seq ?? cursor;
      },
      setTimeout: (fn) => reconnects.push(fn),
    });
    await vi.waitFor(() => expect(reconnects).toHaveLength(1));
    reconnects[0]?.();
    await vi.waitFor(() => expect(frames).toEqual([4, 5]));
    close();

    expect(urls[0]).toContain(`conversationId=${CONVERSATION}&after=3`);
    expect(urls[1]).toContain('after=4');
  });

  it('reports a refused stream and tries again later', async () => {
    const onError = vi.fn();
    const reconnects: (() => void)[] = [];
    const http = new HttpClient({
      apiUrl: 'https://api.example.com',
      brandId: BRAND,
      secret: () => 's',
      fetch: async () => streamOf([], 401),
    });

    const close = openSseStream({
      http,
      conversationId: CONVERSATION,
      after: () => 0,
      onFrame: () => undefined,
      onError,
      setTimeout: (fn) => reconnects.push(fn),
    });
    await vi.waitFor(() => expect(reconnects).toHaveLength(1));
    close();

    expect(onError).toHaveBeenCalledOnce();
  });
});
