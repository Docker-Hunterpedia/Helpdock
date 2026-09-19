import { type RenderResult, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { AppProviders, createAdminQueryClient } from '../app/providers.tsx';
import type { AuthApi } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';
import type { ContactsApi } from '../contacts/api.js';
import { MockContactsApi } from '../contacts/mock-api.js';
import type { StaffApi } from '../staff/api.js';
import { MockStaffApi } from '../staff/mock-api.js';

export interface RenderAppOptions {
  readonly authApi?: AuthApi;
  /** Defaults to a fresh fixture, so a screen that reads it always has one. */
  readonly staffApi?: StaffApi;
  readonly contactsApi?: ContactsApi;
  readonly initialEntries?: readonly string[];
}

export interface RenderedApp extends RenderResult {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly authApi: AuthApi;
  readonly staffApi: StaffApi;
  readonly contactsApi: ContactsApi;
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
  const initialEntries = [...(options.initialEntries ?? ['/'])];
  const queryClient = createAdminQueryClient();

  const result = render(
    <AppProviders
      authApi={authApi}
      staffApi={staffApi}
      contactsApi={contactsApi}
      queryClient={queryClient}
      router={({ children }) => (
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      )}
    >
      {ui}
    </AppProviders>,
  );

  return { ...result, user: userEvent.setup(), authApi, staffApi, contactsApi };
}
