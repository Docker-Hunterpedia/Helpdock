import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { PostgresSettingsStore } from './settings-store.js';
import { uuidv7 } from './uuid.js';

// No query is made here, so postgres-js never dials. Reads and writes against a
// real Postgres are covered by `settings-store.integration.test.ts`.
const handle = createDb({ url: 'postgres://helpdock_app:password@127.0.0.1:1/helpdock' });

afterAll(async () => {
  await handle.close();
});

describe('PostgresSettingsStore', () => {
  it('reports install scope as null rather than as the sentinel brand', () => {
    expect(new PostgresSettingsStore({ db: handle.db }).brandId).toBeNull();
  });

  it('keeps the brand it was bound to', () => {
    const brandId = uuidv7();

    expect(new PostgresSettingsStore({ db: handle.db, brandId }).brandId).toBe(brandId);
  });

  it.each(['acme', '', "0199a2bc-1f00-7a3d-8b2e-1f6c9d2e4a7b' --"])(
    'refuses %s as a brand id',
    (brandId) => {
      expect(() => new PostgresSettingsStore({ db: handle.db, brandId })).toThrow(TypeError);
    },
  );
});
