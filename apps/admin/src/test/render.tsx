import { type RenderResult, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { AppProviders, createAdminQueryClient } from '../app/providers.tsx';
import type { AuthApi } from '../auth/api.js';
import { MockAuthApi } from '../auth/mock-api.js';

export interface RenderAppOptions {
  readonly authApi?: AuthApi;
  readonly initialEntries?: readonly string[];
}

export interface RenderedApp extends RenderResult {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly authApi: AuthApi;
}

/**
 * The app's real provider stack with the router swapped for an in-memory one,
 * so a test exercises the same theme, catalogs and query client the browser
 * gets.
 */
export function renderApp(ui: ReactNode, options: RenderAppOptions = {}): RenderedApp {
  const authApi = options.authApi ?? new MockAuthApi();
  const initialEntries = [...(options.initialEntries ?? ['/'])];
  const queryClient = createAdminQueryClient();

  const result = render(
    <AppProviders
      authApi={authApi}
      queryClient={queryClient}
      router={({ children }) => (
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      )}
    >
      {ui}
    </AppProviders>,
  );

  return { ...result, user: userEvent.setup(), authApi };
}
