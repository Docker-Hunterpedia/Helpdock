import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeDeletion,
  auditLogPage,
  healthySystemStatus,
  installBrands,
  OLD_STORE_BRAND,
  productMetrics,
  QUEUE_BOARD_PASS,
} from './fixtures.js';
import { HttpSystemApi, NotAllowedError, SystemApiError } from './system-api.js';

const respondWith = (body: unknown, status = 200): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSystemApi', () => {
  it('reads the install-scope endpoint and returns the parsed status', async () => {
    const status = healthySystemStatus();
    respondWith(status);

    expect(await new HttpSystemApi().status()).toEqual(status);
    expect(fetch).toHaveBeenCalledWith('/api/install/system', expect.anything());
  });

  it('tells a 403 apart, because the page draws it as a state rather than a failure', async () => {
    respondWith({ error: { code: 'forbidden' } }, 403);

    await expect(new HttpSystemApi().status()).rejects.toBeInstanceOf(NotAllowedError);
  });

  it('reports any other failure with the status it got', async () => {
    respondWith({ error: { code: 'internal_error' } }, 500);

    await expect(new HttpSystemApi().status()).rejects.toThrow('the api answered 500');
  });

  it('refuses a body that does not match the schema instead of drawing a blank card', async () => {
    respondWith({ ...healthySystemStatus(), redis: { status: 'ok' } });

    await expect(new HttpSystemApi().status()).rejects.toBeInstanceOf(SystemApiError);
  });
});

describe('HttpSystemApi.auditLog (M3-08)', () => {
  it('asks with only the filters that are set, and parses the page', async () => {
    const page = auditLogPage();
    respondWith(page);

    expect(await new HttpSystemApi().auditLog({})).toEqual(page);
    expect(fetch).toHaveBeenLastCalledWith('/api/install/audit-log', expect.anything());

    await new HttpSystemApi().auditLog({ action: 'ticket.*', cursor: 'abc' });
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/install/audit-log?action=ticket.*&cursor=abc',
      expect.anything(),
    );
  });
});

describe('HttpSystemApi, the M8 routes', () => {
  it('sends the access token the app holds', async () => {
    respondWith(productMetrics());

    await new HttpSystemApi(async () => 'token').productMetrics();

    expect(fetch).toHaveBeenCalledWith(
      '/api/install/system/metrics',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer token' }),
      }),
    );
  });

  it('asks for a queue board pass and answers its address', async () => {
    respondWith({ url: QUEUE_BOARD_PASS });

    expect(await new HttpSystemApi().queueBoardPass()).toBe(QUEUE_BOARD_PASS);
    expect(fetch).toHaveBeenCalledWith(
      '/api/install/system/queue-board',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts the typed prefix to delete a brand, and keeps the status of a refusal', async () => {
    respondWith({ error: { code: 'bad_request' } }, 400);

    const refused = await new HttpSystemApi()
      .deleteBrand(OLD_STORE_BRAND, 'XX')
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(SystemApiError);
    expect((refused as SystemApiError).status).toBe(400);
    expect(fetch).toHaveBeenCalledWith(
      `/api/install/brands/${OLD_STORE_BRAND}/deletion`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirmPrefix: 'XX' }) }),
    );
  });

  it('restores with DELETE on the same route, and lists the brands', async () => {
    respondWith(activeDeletion(OLD_STORE_BRAND));
    expect(await new HttpSystemApi().restoreBrand(OLD_STORE_BRAND)).toEqual(
      activeDeletion(OLD_STORE_BRAND),
    );
    expect(fetch).toHaveBeenCalledWith(
      `/api/install/brands/${OLD_STORE_BRAND}/deletion`,
      expect.objectContaining({ method: 'DELETE' }),
    );

    respondWith({ brands: installBrands() });
    expect(await new HttpSystemApi().brands()).toHaveLength(4);
  });
});
