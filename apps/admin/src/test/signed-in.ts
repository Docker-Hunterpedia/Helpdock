import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE, MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import { MockStaffApi } from '../staff/mock-api.js';

/**
 * The pair of fixtures with a session already in them, obtained the way a
 * person would rather than by reaching into their internals: a test that starts
 * inside the shell still proves the sign-in path produces what the shell reads.
 *
 * Both, and built together, because the app builds them together — the auth
 * fixture reads the staff fixture's invitations, and a test that made only one
 * would be exercising a wiring the browser never gets.
 */
export async function signedInMockApis(): Promise<AdminApis> {
  const staff = new MockStaffApi();
  const auth = new MockAuthApi(staff);

  const result = await auth.signInWithPassword(MOCK_EMAIL, MOCK_PASSWORD);
  if (result.kind !== 'totp-required') {
    throw new Error('expected a second factor to be required');
  }

  await auth.verifyTotp(result.challengeId, MOCK_TOTP_CODE, { trustDevice: false });

  return { auth, staff, contacts: new MockContactsApi() };
}
