import { type RenderResult, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { AppProviders, createAdminQueryClient } from '../app/providers.tsx';
import type { AuthApi } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import type { AutomationApi } from '../automation/api.js';
import { MockAutomationApi } from '../automation/mock-api.js';
import type { ChannelsApi } from '../channels/api.js';
import { MockChannelsApi } from '../channels/mock-api.js';
import type { ContactsApi } from '../contacts/api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import type { DomainsApi } from '../domains/api.js';
import { MockDomainsApi } from '../domains/mock-api.js';
import type { EmailApi } from '../email/api.js';
import { MockEmailApi } from '../email/mock-api.js';
import type { HelpCenterApi } from '../help-center/api.js';
import { MockHelpCenterApi } from '../help-center/mock-api.js';
import { MockAttachmentUploader } from '../media/mock-uploader.js';
import type { AttachmentUploader } from '../media/upload.js';
import type { NotificationsApi } from '../notifications/api.js';
import { type BrowserPush, MockBrowserPush } from '../notifications/browser-push.js';
import { MockNotificationsApi } from '../notifications/mock-api.js';
import type { StaffApi } from '../staff/api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import type { TelegramApi } from '../telegram/api.js';
import { MockTelegramApi } from '../telegram/mock-api.js';
import type { TicketingApi } from '../ticketing/api.js';
import { MockTicketingApi } from '../ticketing/mock-api.js';
import type { TicketsApi } from '../tickets/api.js';
import { MockTicketsApi } from '../tickets/mock-api.js';

export interface RenderAppOptions {
  readonly authApi?: AuthApi;
  /** Defaults to a fresh fixture, so a screen that reads it always has one. */
  readonly staffApi?: StaffApi;
  readonly contactsApi?: ContactsApi;
  /** Defaults to a fresh fixture, for the Ticketing screens. */
  readonly ticketingApi?: TicketingApi;
  readonly ticketsApi?: TicketsApi;
  readonly uploader?: AttachmentUploader;
  readonly emailApi?: EmailApi;
  readonly channelsApi?: ChannelsApi;
  /** Defaults to a fresh fixture, for `Admin/Automation`. */
  readonly automationApi?: AutomationApi;
  readonly notificationsApi?: NotificationsApi;
  readonly helpCenterApi?: HelpCenterApi;
  readonly browserPush?: BrowserPush;
  readonly domainsApi?: DomainsApi;
  readonly telegramApi?: TelegramApi;
  readonly initialEntries?: readonly string[];
}

export interface RenderedApp extends RenderResult {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly authApi: AuthApi;
  readonly staffApi: StaffApi;
  readonly contactsApi: ContactsApi;
  readonly ticketingApi: TicketingApi;
  readonly ticketsApi: TicketsApi;
  readonly uploader: AttachmentUploader;
  readonly emailApi: EmailApi;
  readonly channelsApi: ChannelsApi;
  readonly automationApi: AutomationApi;
  readonly notificationsApi: NotificationsApi;
  readonly helpCenterApi: HelpCenterApi;
  readonly browserPush: BrowserPush;
  readonly domainsApi: DomainsApi;
  readonly telegramApi: TelegramApi;
}

/**
 * The app's real provider stack with the router swapped for an in-memory one,
 * so a test exercises the same theme, catalogs and query client the browser
 * gets.
 */
export function renderApp(ui: ReactNode, options: RenderAppOptions = {}): RenderedApp {
  const staffApi = options.staffApi ?? new MockStaffApi();
  const authApi =
    options.authApi ?? new MockAuthApi(staffApi instanceof MockStaffApi ? staffApi : undefined);
  const contactsApi = options.contactsApi ?? new MockContactsApi();
  const ticketingApi = options.ticketingApi ?? new MockTicketingApi();
  const ticketsApi = options.ticketsApi ?? new MockTicketsApi();
  const uploader = options.uploader ?? new MockAttachmentUploader();
  const emailApi = options.emailApi ?? new MockEmailApi();
  const channelsApi = options.channelsApi ?? new MockChannelsApi();
  const automationApi = options.automationApi ?? new MockAutomationApi();
  const notificationsApi = options.notificationsApi ?? new MockNotificationsApi();
  const helpCenterApi = options.helpCenterApi ?? new MockHelpCenterApi();
  const browserPush = options.browserPush ?? new MockBrowserPush();
  const domainsApi = options.domainsApi ?? new MockDomainsApi();
  const telegramApi = options.telegramApi ?? new MockTelegramApi();
  const initialEntries = [...(options.initialEntries ?? ['/'])];
  const queryClient = createAdminQueryClient();

  const result = render(
    <AppProviders
      authApi={authApi}
      staffApi={staffApi}
      contactsApi={contactsApi}
      ticketingApi={ticketingApi}
      ticketsApi={ticketsApi}
      uploader={uploader}
      emailApi={emailApi}
      channelsApi={channelsApi}
      automationApi={automationApi}
      notificationsApi={notificationsApi}
      helpCenterApi={helpCenterApi}
      browserPush={browserPush}
      domainsApi={domainsApi}
      telegramApi={telegramApi}
      queryClient={queryClient}
      router={({ children }) => (
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      )}
    >
      {ui}
    </AppProviders>,
  );

  return {
    ...result,
    user: userEvent.setup(),
    authApi,
    staffApi,
    contactsApi,
    ticketingApi,
    ticketsApi,
    uploader,
    emailApi,
    channelsApi,
    automationApi,
    notificationsApi,
    helpCenterApi,
    browserPush,
    domainsApi,
    telegramApi,
  };
}
