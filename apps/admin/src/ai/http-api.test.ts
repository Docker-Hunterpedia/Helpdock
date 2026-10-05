import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isAiError } from './api.js';
import { HttpAiApi } from './http-api.js';
import { MockAiApi } from './mock-api.js';

/**
 * The AI adapter against a stubbed `fetch`: the paths and bodies it sends,
 * that it parses what comes back, and what a refusal becomes. That the routes
 * behave is `ai.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpAiApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpAiApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; method: string; body: unknown } => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('HttpAiApi', () => {
  it('saves a provider under its id and parses the view', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        id: 'openai',
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: null,
        authType: 'apiKey',
        oauthExpiresAt: null,
      }),
    );
    const request = {
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: null,
      auth: { type: 'apiKey' as const, apiKey: 'sk-new' },
    };

    const view = await api.saveProvider('openai', request);

    expect(lastCall()).toEqual({
      url: '/api/install/ai/providers/openai',
      method: 'PUT',
      body: request,
    });
    expect(view.authType).toBe('apiKey');
  });

  it('pages the brand’s calls with the cursor it was given', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], nextCursor: null }));

    await api.calls(BRAND, 'abc=');

    expect(lastCall().url).toBe(`/api/brands/${BRAND}/ai/calls?cursor=abc%3D`);
  });

  it('sends the modes to their own route', async () => {
    const settings = await new MockAiApi().brandSettings(BRAND);
    fetchMock.mockResolvedValueOnce(json(settings));
    const modes = { ...settings.modes, aiCountsAsFirstResponse: true };

    await api.saveModes(BRAND, modes);

    expect(lastCall()).toMatchObject({ url: `/api/brands/${BRAND}/ai/modes`, method: 'PUT' });
  });

  it('turns a refusal into an AiError with its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'x',
            requestId: 'r',
            ai: { reason: 'reembed-not-confirmed' },
          },
        },
        409,
      ),
    );

    const failure = await api
      .saveEmbedding({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'text-embedding-3-large',
        dims: 1536,
        pricePerMillionTokens: 0.13,
      })
      .catch((error: unknown) => error);

    expect(isAiError(failure) && failure.reason).toBe('reembed-not-confirmed');
  });
});
