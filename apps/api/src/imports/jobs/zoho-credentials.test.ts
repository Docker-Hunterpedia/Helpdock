import { expect, it } from 'vitest';
import { decodedZohoCredentials } from './zoho-credentials.js';

const credentials = {
  region: 'us',
  orgId: '9007199254740993123',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-client-secret',
  refreshToken: 'synthetic-refresh',
};

it('separates an internal cached access token from the public credential context', () => {
  const accessToken = { value: 'synthetic-access', expiresAt: 1792195200000 };
  const parsed = decodedZohoCredentials({ ...credentials, accessToken });
  expect(parsed.credentials).toEqual(credentials);
  expect(parsed.credentials).not.toHaveProperty('accessToken');
  expect(parsed.accessToken).toEqual(accessToken);
});

it.each([
  { ...credentials, accessToken: { value: 'synthetic\nunsafe', expiresAt: 1792195200000 } },
  { ...credentials, accessToken: { value: 'synthetic-access', expiresAt: -1 } },
  { ...credentials, unexpectedSecret: 'synthetic-sensitive-extra' },
])('refuses malformed encrypted credential contents using a safe error code', (stored) => {
  expect(() => decodedZohoCredentials(stored)).toThrow('credentials-refused');
});
