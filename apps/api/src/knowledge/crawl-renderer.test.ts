import type { Route } from 'playwright';
import { describe, expect, it } from 'vitest';
import { answerRoute, type RenderFetch } from './crawl-renderer.js';

/** The part of a Playwright route the handler touches. */
const routeFor = (resourceType: string) => {
  const calls: { fulfilled?: unknown; aborted?: string } = {};
  const route = {
    request: () => ({
      resourceType: () => resourceType,
      url: () => 'https://docs.example.com/app.js',
      method: () => 'GET',
      allHeaders: async () => ({ accept: '*/*' }),
      postDataBuffer: () => null,
    }),
    fulfill: async (response: unknown) => {
      calls.fulfilled = response;
    },
    abort: async (reason: string) => {
      calls.aborted = reason;
    },
  } as unknown as Route;
  return { route, calls };
};

describe('answerRoute', () => {
  it('answers the browser’s request through the safe client', async () => {
    const asked: string[] = [];
    const through: RenderFetch = async (url) => {
      asked.push(url);
      return {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
        body: Buffer.from('1'),
      };
    };
    const { route, calls } = routeFor('script');

    await answerRoute(route, through);

    expect(asked).toEqual(['https://docs.example.com/app.js']);
    expect(calls.fulfilled).toMatchObject({
      status: 200,
      headers: { 'content-type': 'text/javascript' },
    });
  });

  it('aborts what the safe client refuses, and never fetches images or fonts', async () => {
    const refused = routeFor('xhr');
    await answerRoute(refused.route, async () => {
      throw new Error('destination blocked');
    });
    const image = routeFor('image');
    await answerRoute(image.route, async () => {
      throw new Error('not reached');
    });

    expect(refused.calls.aborted).toBe('blockedbyclient');
    expect(image.calls.aborted).toBe('blockedbyclient');
  });
});
