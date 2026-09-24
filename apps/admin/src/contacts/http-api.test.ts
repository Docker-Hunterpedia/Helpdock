import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../auth/http-transport.js';
import { HttpContactsApi } from './http-api.js';
import { MOCK_BRAND, MOCK_CONTACT_GMAIL, MOCK_CONTACT_MONA, MockContactsApi } from './mock-api.js';

/**
 * The merge half of the contacts adapter (M1-13) against a stubbed `fetch`:
 * the paths and bodies it sends, and that it parses the answers through the
 * schemas `apps/api` declares them with.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let api: HttpContactsApi;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  api = new HttpContactsApi(new HttpTransport());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastUrl = (): string => String(fetchMock.mock.calls.at(-1)?.[0]);
const lastInit = (): RequestInit => (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as RequestInit;
const base = `/api/brands/${MOCK_BRAND}/contacts/${MOCK_CONTACT_MONA}`;

describe('HttpContactsApi merges', () => {
  it('asks for a preview with the other contact in the query', async () => {
    const preview = await new MockContactsApi().mergePreview(
      MOCK_BRAND,
      MOCK_CONTACT_MONA,
      MOCK_CONTACT_GMAIL,
    );
    fetchMock.mockResolvedValue(json(preview));

    await expect(
      api.mergePreview(MOCK_BRAND, MOCK_CONTACT_MONA, MOCK_CONTACT_GMAIL),
    ).resolves.toEqual(preview);
    expect(lastUrl()).toBe(`${base}/merge-preview?otherContactId=${MOCK_CONTACT_GMAIL}`);
  });

  it('posts a merge to the survivor, and an undo to the merge', async () => {
    const detail = await new MockContactsApi().contact(MOCK_BRAND, MOCK_CONTACT_MONA);
    fetchMock.mockImplementation(() => Promise.resolve(json(detail)));

    await api.mergeContacts(MOCK_BRAND, MOCK_CONTACT_MONA, {
      mergedContactId: MOCK_CONTACT_GMAIL,
    });
    expect(lastUrl()).toBe(`${base}/merge`);
    expect(JSON.parse(String(lastInit().body))).toEqual({ mergedContactId: MOCK_CONTACT_GMAIL });

    await api.undoMerge(MOCK_BRAND, MOCK_CONTACT_MONA, 'merge-1');
    expect(lastUrl()).toBe(`${base}/merges/merge-1/undo`);
    expect(lastInit().method).toBe('POST');
  });
});
