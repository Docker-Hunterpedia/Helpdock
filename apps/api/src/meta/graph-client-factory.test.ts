import { GraphClient } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { createGraphClient } from './graph-client-factory.js';

describe('createGraphClient', () => {
  it('builds a client from the defaults when no key is set', () => {
    expect(createGraphClient({ OUTBOUND_ALLOW_CIDRS: [] })).toBeInstanceOf(GraphClient);
  });

  it('accepts the three META_* keys that point a suite at a stand-in', () => {
    const client = createGraphClient({
      META_GRAPH_VERSION: 'v25.0',
      META_GRAPH_API_ROOT: 'http://127.0.0.1:4010',
      META_INSTAGRAM_API_ROOT: 'http://127.0.0.1:4011',
      OUTBOUND_ALLOW_CIDRS: ['127.0.0.0/8'],
    });

    expect(client).toBeInstanceOf(GraphClient);
  });

  it('refuses a version Graph does not spell, at boot rather than at the first call', () => {
    expect(() => createGraphClient({ META_GRAPH_VERSION: '25', OUTBOUND_ALLOW_CIDRS: [] })).toThrow(
      TypeError,
    );
  });

  it('logs every destination the client refuses, by host and code and never the query string', async () => {
    const warn = vi.fn();
    const client = createGraphClient({ OUTBOUND_ALLOW_CIDRS: [] }, { warn });

    await expect(
      client.download('https://evil.example.com/file.jpg?signature=SECRET', { maxBytes: 1_000 }),
    ).rejects.toMatchObject({ reason: 'host-not-allowed' });

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { host: 'evil.example.com', address: undefined, code: 'destination-blocked' },
      'a Meta call to a destination Helpdock does not allow was refused',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});
