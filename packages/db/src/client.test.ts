import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';

// A URL that is never dialled: postgres-js connects on the first query, so a
// handle can be opened and closed without a server. Behaviour against a real
// Postgres is covered by the integration suites.
const URL = 'postgres://helpdock_app:password@127.0.0.1:1/helpdock';

let handle: DbHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('createDb', () => {
  it('does not dial the server until a query runs, so boot order is free', async () => {
    handle = createDb({ url: URL, max: 1 });

    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined;
  });
});
