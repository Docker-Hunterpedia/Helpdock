import { MockAiApi } from '../ai/mock-api.js';
import { MockAssistApi } from '../assist/mock-api.js';
import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE, MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { MockAutomationApi } from '../automation/mock-api.js';
import { MockChannelsApi } from '../channels/mock-api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import { MockDevelopersApi } from '../developers/mock-api.js';
import { MockDomainsApi } from '../domains/mock-api.js';
import { MockEmailApi } from '../email/mock-api.js';
import { MockHelpCenterApi } from '../help-center/mock-api.js';
import { MockImportsApi } from '../imports/mock-api.js';
import { MockKeyboardApi } from '../keyboard/api.js';
import { MockKnowledgeApi } from '../knowledge/mock-api.js';
import { MockAttachmentUploader } from '../media/mock-uploader.js';
import { MockMetaApi } from '../meta/mock-api.js';
import { MockBrowserPush } from '../notifications/browser-push.js';
import { MockNotificationsApi } from '../notifications/mock-api.js';
import { HttpReportsApi } from '../reports/api.js';
import { HttpSystemApi } from '../screens/admin/system/system-api.js';
import { MockSettingsApi } from '../settings/mock-api.js';
import { MockSsoApi } from '../sso/mock-api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import { MockTelegramApi } from '../telegram/mock-api.js';
import { MockTicketingApi } from '../ticketing/mock-api.js';
import { MockBlockList } from '../ticketing/mock-block-list.js';
import { MockTicketsApi } from '../tickets/mock-api.js';

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

  // Shared, as `createApis` shares it: a sender blocked from a ticket is on the
  // Spam tab (M1-11).
  const blockList = new MockBlockList();
  const ticketing = new MockTicketingApi(blockList);

  return {
    imports: new MockImportsApi('happy', { ticketing, staff }),
    sso: new MockSsoApi(auth),
    auth,
    staff,
    contacts: new MockContactsApi(),
    ticketing,
    tickets: new MockTicketsApi(undefined, Date.now(), blockList, undefined, ticketing),
    uploader: new MockAttachmentUploader(),
    email: new MockEmailApi(),
    channels: new MockChannelsApi(),
    automation: new MockAutomationApi(),
    helpCenter: new MockHelpCenterApi(),
    notifications: new MockNotificationsApi(),
    browserPush: new MockBrowserPush(),
    domains: new MockDomainsApi(),
    ai: new MockAiApi(),
    knowledge: new MockKnowledgeApi(),
    reports: new HttpReportsApi(),
    system: new HttpSystemApi(),
    settings: new MockSettingsApi(),
    telegram: new MockTelegramApi(),
    meta: new MockMetaApi(),
    assist: new MockAssistApi(),
    developers: new MockDevelopersApi(),
    keyboard: new MockKeyboardApi(auth),
  };
}

/**
 * The auth fixture of {@link signedInMockApis}, typed as the fixture it is, for
 * a test that drives its account (M14-01's single-key switch).
 */
export async function signedInMockAuth(): Promise<MockAuthApi> {
  const { auth } = await signedInMockApis();
  if (!(auth instanceof MockAuthApi)) {
    throw new Error('signedInMockApis always builds a MockAuthApi');
  }
  return auth;
}
