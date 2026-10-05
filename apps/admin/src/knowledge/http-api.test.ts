import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { isKnowledgeError } from './api.js';
import { HttpKnowledgeApi } from './http-api.js';
import { MockKnowledgeApi } from './mock-api.js';

/**
 * The knowledge adapter against a stubbed `fetch`: the presign, put and
 * confirm of an upload, and what a refusal becomes. That the routes behave is
 * `knowledge.integration.test.ts` in the api.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpKnowledgeApi', () => {
  it('uploads a file: presign, put with the presigned headers, then confirm', async () => {
    const view = (await new MockKnowledgeApi().sources(BRAND)).sources[1];
    const put = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const api = new HttpKnowledgeApi(new HttpTransport(), put);
    fetchMock
      .mockResolvedValueOnce(
        json({
          sourceId: view?.id,
          url: 'https://bucket.test/k/1',
          headers: { 'content-type': 'application/pdf' },
          expiresAt: '2026-10-05T12:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(json(view));
    const file = new File(['%PDF'], 'Billing FAQ.pdf', { type: 'application/pdf' });

    await api.uploadFile(BRAND, file, 'public');

    const [presignUrl, presign] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(presignUrl).toBe(`/api/brands/${BRAND}/knowledge/files`);
    expect(JSON.parse(String(presign.body))).toEqual({
      fileName: 'Billing FAQ.pdf',
      mime: 'application/pdf',
      size: 4,
      visibility: 'public',
    });
    expect(put).toHaveBeenCalledWith('https://bucket.test/k/1', {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: file,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/brands/${BRAND}/knowledge/sources/${view?.id ?? ''}/confirm`,
    );
  });

  it('turns a refusal into a KnowledgeError with its reason', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: 'x',
            requestId: 'r',
            knowledge: { reason: 'oauth-not-configured' },
          },
        },
        409,
      ),
    );

    const failure = await new HttpKnowledgeApi(new HttpTransport())
      .oauthStart(BRAND, '0192c3f0-1a2b-7c3d-8e4f-0000000000aa', 'gdrive')
      .catch((error: unknown) => error);

    expect(isKnowledgeError(failure) && failure.reason).toBe('oauth-not-configured');
  });
});
