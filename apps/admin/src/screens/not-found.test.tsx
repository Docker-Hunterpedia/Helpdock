import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';

/** An unknown signed-in address (`Admin/UX-Fixes-2026-11`, "Not found"). */

function Where(): null {
  const { pathname } = useLocation();
  document.body.dataset.where = pathname;
  return null;
}

afterEach(() => {
  delete document.body.dataset.where;
});

const open = async (path: string) => {
  const apis = await signedInMockApis();
  return renderApp(
    <>
      <Where />
      <AppRoutes />
    </>,
    { authApi: apis.auth, staffApi: apis.staff, initialEntries: [path] },
  );
};

describe('an address that leads nowhere', () => {
  it('draws "Page not found" inside the shell, with a way to the tickets', async () => {
    const { user } = await open('/no/such/page');

    expect(await screen.findByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible();
    // Still inside the shell: the sidebar is there, the tab says where it is.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found · Helpdock');
    expect(document.body.dataset.where).toBe('/no/such/page');

    await user.click(screen.getByRole('link', { name: 'Go to tickets' }));

    await waitFor(() => {
      expect(document.body.dataset.where).toBe('/tickets');
    });
  });

  it('still sends an address from before the Settings area to its new home first', async () => {
    await open('/admin/ticketing/slas');

    await waitFor(() => {
      expect(document.body.dataset.where).toBe('/settings/inbox/slas');
    });
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull();
  });

  it('leaves the bare address opening the tickets', async () => {
    await open('/');

    await waitFor(() => {
      expect(document.body.dataset.where).toBe('/tickets');
    });
  });
});
