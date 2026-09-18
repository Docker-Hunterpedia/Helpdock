import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE, MockAuthApi } from '../auth/mock-api.js';

/**
 * A `MockAuthApi` that already holds a session, obtained the way a person would
 * rather than by reaching into the fixture's internals: a test that starts
 * inside the shell still proves the sign-in path produces what the shell reads.
 */
export async function signedInMockApi(): Promise<MockAuthApi> {
  const api = new MockAuthApi();
  const result = await api.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD);

  if (result.kind !== 'totp-required') {
    throw new Error('expected a second factor to be required');
  }

  await api.verifyTotp(result.challengeId, MOCK_TOTP_CODE, { trustDevice: false });

  return api;
}
