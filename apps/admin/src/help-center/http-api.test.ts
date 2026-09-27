import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HelpCenterError } from './api.js';
import { HttpHelpCenterApi } from './http-api.js';
import { MOCK_HELP_CENTER, MockHelpCenterApi } from './mock-api.js';

/**
 * The adapter against a stubbed `fetch`: which route each call reaches, with
 * which method and body, and that a refusal becomes a `HelpCenterError`.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const ARTICLE = MOCK_HELP_CENTER.articles.timelines;
const base = `/api/brands/${BRAND}/help-center`;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpHelpCenterApi;
const fixture = new MockHelpCenterApi();

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpHelpCenterApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; method: string; body: unknown } => {
  const [url, init] = (fetchMock.mock.calls.at(-1) ?? []) as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
};

describe('HttpHelpCenterApi', () => {
  it('reads and orders the structure', async () => {
    const structure = await fixture.structure();
    fetchMock.mockImplementation(() => Promise.resolve(json(structure)));

    await expect(api.structure(BRAND)).resolves.toEqual(structure);
    expect(lastCall()).toMatchObject({ url: `${base}/structure`, method: 'GET' });

    await api.reorder(BRAND, 'sections', { parentId: ARTICLE, ids: [ARTICLE] });
    expect(lastCall()).toMatchObject({
      url: `${base}/sections/reorder`,
      method: 'POST',
      body: { parentId: ARTICLE, ids: [ARTICLE] },
    });
  });

  it('creates, renames and deletes categories and sections', async () => {
    const { categories, sections } = await fixture.structure();
    const names = { en: 'Orders', ar: '' };

    fetchMock.mockImplementation(() => Promise.resolve(json(categories[0])));
    await api.createCategory(BRAND, { names });
    expect(lastCall()).toMatchObject({ url: `${base}/categories`, method: 'POST' });
    await api.updateCategory(BRAND, ARTICLE, { names });
    expect(lastCall()).toMatchObject({ url: `${base}/categories/${ARTICLE}`, method: 'PATCH' });

    fetchMock.mockImplementation(() => Promise.resolve(json(sections[0])));
    await api.createSection(BRAND, { categoryId: ARTICLE, names });
    expect(lastCall()).toMatchObject({ url: `${base}/sections`, method: 'POST' });
    await api.updateSection(BRAND, ARTICLE, { names });
    expect(lastCall()).toMatchObject({ url: `${base}/sections/${ARTICLE}`, method: 'PATCH' });

    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    await api.deleteCategory(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/categories/${ARTICLE}`, method: 'DELETE' });
    await api.deleteSection(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/sections/${ARTICLE}`, method: 'DELETE' });
    await api.deleteArticle(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/articles/${ARTICLE}`, method: 'DELETE' });
  });

  it('saves a version, its status and its visibility on their own routes', async () => {
    const article = await fixture.article(BRAND, ARTICLE);
    fetchMock.mockImplementation(() => Promise.resolve(json(article)));

    await api.article(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/articles/${ARTICLE}`, method: 'GET' });
    await api.createArticle(BRAND, { sectionId: ARTICLE, locale: 'en', title: 'T' });
    expect(lastCall()).toMatchObject({ url: `${base}/articles`, method: 'POST' });
    await api.updateArticle(BRAND, ARTICLE, { slug: 'x' });
    expect(lastCall()).toMatchObject({ url: `${base}/articles/${ARTICLE}`, method: 'PATCH' });

    await api.saveVersion(BRAND, ARTICLE, 'ar', { title: 'T', description: '', bodyHtml: '' });
    expect(lastCall()).toMatchObject({
      url: `${base}/articles/${ARTICLE}/versions/ar`,
      method: 'PUT',
    });
    await api.setStatus(BRAND, ARTICLE, 'en', { status: 'published' });
    expect(lastCall()).toMatchObject({
      url: `${base}/articles/${ARTICLE}/versions/en/status`,
      body: { status: 'published' },
    });
    await api.setVisibility(BRAND, ARTICLE, 'en', 'internal');
    expect(lastCall()).toMatchObject({
      url: `${base}/articles/${ARTICLE}/versions/en/visibility`,
      body: { visibility: 'internal' },
    });
  });

  it('reads and writes who may read the help center', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ access: 'internal_only' })));

    await expect(api.settings(BRAND)).resolves.toEqual({ access: 'internal_only' });
    await api.updateSettings(BRAND, { access: 'internal_only' });
    expect(lastCall()).toMatchObject({ url: `${base}/settings`, method: 'PUT' });
  });

  it('presigns, uploads to the bucket, confirms and polls an image', async () => {
    const upload = {
      mediaId: ARTICLE,
      url: 'https://bucket.test/x',
      headers: { 'content-type': 'image/png' },
      expiresAt: '2026-10-01T00:00:00.000Z',
    };
    const media = {
      id: ARTICLE,
      status: 'ready',
      src: '/x',
      width: 1,
      height: 1,
      rejectReason: null,
    };

    fetchMock.mockImplementationOnce(() => Promise.resolve(json(upload)));
    await expect(
      api.presignImage(BRAND, { fileName: 'a.png', mime: 'image/png', size: 10 }),
    ).resolves.toEqual(upload);

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 200 })));
    await api.uploadImage(upload, new Blob(['x']));
    expect(lastCall()).toMatchObject({ url: upload.url, method: 'PUT' });

    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })));
    await expect(api.uploadImage(upload, new Blob(['x']))).rejects.toThrow();

    fetchMock.mockImplementation(() => Promise.resolve(json(media)));
    await api.confirmImage(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/media/${ARTICLE}/confirm`, method: 'POST' });
    await api.image(BRAND, ARTICLE);
    expect(lastCall()).toMatchObject({ url: `${base}/media/${ARTICLE}`, method: 'GET' });
  });

  it('turns a refusal into the reason the screen names', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'conflict',
            message: 'taken',
            requestId: 'r',
            helpCenter: { reason: 'slug-taken' },
          },
        },
        409,
      ),
    );

    const failure = await api.updateArticle(BRAND, ARTICLE, { slug: 'x' }).catch((error) => error);
    expect(failure).toBeInstanceOf(HelpCenterError);
    expect((failure as HelpCenterError).reason).toBe('slug-taken');
  });
});
