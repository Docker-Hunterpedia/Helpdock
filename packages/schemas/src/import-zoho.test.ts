import { expect, it } from 'vitest';
import { importConnectionRequestSchema } from './import-api.js';
import { zohoCredentialsSchema } from './import-zoho.js';

const credentials = {
  region: 'ca',
  orgId: '9007199254740993123',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-client-secret',
  refreshToken: 'synthetic-refresh',
};

it('preserves long native organization IDs while refusing token snapshots supplied through the public connection boundary', () => {
  expect(importConnectionRequestSchema.parse({ credentials }).credentials).toEqual(credentials);
  expect(
    importConnectionRequestSchema.safeParse({
      credentials: {
        ...credentials,
        accessToken: { value: 'synthetic-access', expiresAt: 9999999999999 },
      },
    }).success,
  ).toBe(false);
});

it.each([
  { region: 'https://attacker.test' },
  { orgId: '00123' },
  { clientId: 'synthetic\r\ninjected' },
  { clientSecret: 'synthetic\u0000secret' },
  { refreshToken: 'synthetic\nrefresh' },
])(
  'refuses a credential shape that could change the native account or inject a header: %o',
  (forged) => {
    expect(zohoCredentialsSchema.safeParse({ ...credentials, ...forged }).success).toBe(false);
  },
);
