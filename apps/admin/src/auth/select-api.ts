import type { AutomationApi } from '../automation/api.js';
import { HttpAutomationApi } from '../automation/http-api.js';
import { MockAutomationApi } from '../automation/mock-api.js';
import type { ChannelsApi } from '../channels/api.js';
import { HttpChannelsApi } from '../channels/http-api.js';
import { MockChannelsApi } from '../channels/mock-api.js';
import type { ContactsApi } from '../contacts/api.js';
import { HttpContactsApi } from '../contacts/http-api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import type { DevelopersApi } from '../developers/api.js';
import { HttpDevelopersApi } from '../developers/http-api.js';
import { MockDevelopersApi } from '../developers/mock-api.js';
import type { DomainsApi } from '../domains/api.js';
import { HttpDomainsApi } from '../domains/http-api.js';
import { MockDomainsApi } from '../domains/mock-api.js';
import type { EmailApi } from '../email/api.js';
import { HttpEmailApi } from '../email/http-api.js';
import { MockEmailApi } from '../email/mock-api.js';
import type { HelpCenterApi } from '../help-center/api.js';
import { HttpHelpCenterApi } from '../help-center/http-api.js';
import { MockHelpCenterApi } from '../help-center/mock-api.js';
import { MockAttachmentUploader } from '../media/mock-uploader.js';
import type { AttachmentUploader } from '../media/upload.js';
import { HttpAttachmentUploader } from '../media/upload.js';
import type { NotificationsApi } from '../notifications/api.js';
import {
  type BrowserPush,
  MockBrowserPush,
  NavigatorBrowserPush,
} from '../notifications/browser-push.js';
import { HttpNotificationsApi } from '../notifications/http-api.js';
import { MockNotificationsApi } from '../notifications/mock-api.js';
import type { StaffApi } from '../staff/api.js';
import { HttpStaffApi } from '../staff/http-api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import type { TicketingApi } from '../ticketing/api.js';
import { HttpTicketingApi } from '../ticketing/http-api.js';
import { MockTicketingApi } from '../ticketing/mock-api.js';
import { MockBlockList } from '../ticketing/mock-block-list.js';
import type { TicketsApi } from '../tickets/api.js';
import { HttpTicketsApi } from '../tickets/http-api.js';
import { MockTicketsApi } from '../tickets/mock-api.js';
import type { AuthApi } from './api.js';
import { HttpAuthApi } from './http-api.js';
import { HttpTransport } from './http-transport.js';
import { MockAuthApi } from './mock-api.js';

export const AUTH_API_ADAPTERS = ['mock', 'http'] as const;
export type AuthApiAdapter = (typeof AUTH_API_ADAPTERS)[number];

/** The adapters the app is built from, always from the same source. */
export interface AdminApis {
  readonly auth: AuthApi;
  readonly staff: StaffApi;
  readonly contacts: ContactsApi;
  readonly ticketing: TicketingApi;
  readonly tickets: TicketsApi;
  /** M1-10's client half; the composer and the thread are its only callers. */
  readonly uploader: AttachmentUploader;
  /** M2-05's outbound email screens. */
  readonly email: EmailApi;
  /** M2: Channels › Mailboxes and the email card's remote images. */
  readonly channels: ChannelsApi;
  /** M3-03 to M3-05: `Admin/Automation`. */
  readonly automation: AutomationApi;
  /** M5-01, M5-02, M5-09: the Help center screens. */
  readonly helpCenter: HelpCenterApi;
  /** M3-07: the bell, its panel and the Notifications tab. */
  readonly notifications: NotificationsApi;
  /** M3-07: this browser's push half, which the mock replaces with a fixture too. */
  readonly browserPush: BrowserPush;
  /** M5-07: Brand › Domains. */
  readonly domains: DomainsApi;
  /** M8-01, M8-03: the Developers page. */
  readonly developers: DevelopersApi;
}

/**
 * `VITE_AUTH_API` wins when it names an adapter. Without it a production build
 * gets the real service and everything else gets the fixture, so shipping the
 * mock to an install takes a deliberate `VITE_AUTH_API=mock`.
 */
export function resolveAuthApiAdapter(
  configured: string | undefined,
  production: boolean,
): AuthApiAdapter {
  const named = AUTH_API_ADAPTERS.find((adapter) => adapter === configured);

  return named ?? (production ? 'http' : 'mock');
}

/**
 * Every adapter at once, sharing what they have to share: the http three share
 * one {@link HttpTransport}, so there is one access token and one refresh; the
 * mock auth and staff pair share one fixture, so an invitation sent on the
 * staff screen is the one the accept screen reads. The contacts and ticket
 * fixtures stand alone: nothing in auth reads either.
 */
export function createApis(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): AdminApis {
  if (adapter === 'http') {
    const transport = new HttpTransport();

    return {
      auth: new HttpAuthApi(transport),
      staff: new HttpStaffApi(transport),
      contacts: new HttpContactsApi(transport),
      ticketing: new HttpTicketingApi(transport),
      tickets: new HttpTicketsApi(transport),
      uploader: new HttpAttachmentUploader(transport),
      email: new HttpEmailApi(transport),
      channels: new HttpChannelsApi(transport),
      automation: new HttpAutomationApi(transport),
      helpCenter: new HttpHelpCenterApi(transport),
      notifications: new HttpNotificationsApi(transport),
      browserPush: new NavigatorBrowserPush(),
      domains: new HttpDomainsApi(transport),
      developers: new HttpDevelopersApi(transport),
    };
  }

  const staff = new MockStaffApi();
  // The ticket fixture reads the uploader's rows, so a file attached in the
  // composer is the file the thread draws.
  const uploads = new MockAttachmentUploader();
  const blockList = new MockBlockList();
  // And the contact fixture, so a ticket filed against a contact created in
  // this session names them the way the api would.
  const contacts = new MockContactsApi();
  const ticketing = new MockTicketingApi(blockList);

  return {
    auth: new MockAuthApi(staff),
    staff,
    contacts,
    // One block list for both, so a sender blocked from a ticket is on the
    // Spam tab (M1-11); and the ticketing fixture is the ticket fixture's list
    // of tags and fields, so a tag made in Ticketing › Tags can go on a ticket.
    ticketing,
    tickets: new MockTicketsApi(
      uploads,
      Date.now(),
      blockList,
      (id) => contacts.nameOf(id),
      ticketing,
    ),
    uploader: uploads,
    email: new MockEmailApi(),
    channels: new MockChannelsApi(),
    automation: new MockAutomationApi(),
    helpCenter: new MockHelpCenterApi(),
    notifications: new MockNotificationsApi(),
    browserPush: new MockBrowserPush(),
    domains: new MockDomainsApi(),
    developers: new MockDevelopersApi(),
  };
}
