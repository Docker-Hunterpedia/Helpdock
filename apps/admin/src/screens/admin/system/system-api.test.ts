import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLogPage, healthySystemStatus } from './fixtures.js';
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
