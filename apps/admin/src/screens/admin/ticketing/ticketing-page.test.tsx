import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The page around the tabs: that the row is whole from the start, that a tab is
 * a url, and that a tab whose deliverable has not landed says which one it is
 * waiting for rather than pretending to be empty.
 */

const renderTicketing = async (path = '/admin/ticketing') => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: [path],
  });

  await screen.findByRole('heading', { name: 'Ticketing', level: 1 });

  return rendered;
};

describe('the tab row', () => {
  it('offers every tab M1 will fill, so nothing has to be added later', async () => {
    await renderTicketing();

    for (const label of [
      'Departments',
      'Statuses',
      'Priorities',
      'Tags',
      'Custom fields',
      'Templates',
      'Views',
      'Assignment',
    ]) {
      expect(await screen.findByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('says which brand it is describing', async () => {
    await renderTicketing();

    expect(
      await screen.findByText(/Helpdock brand · how tickets are shaped and routed/),
    ).toBeInTheDocument();
  });

  it.each([
    ['names no tab', '/admin/ticketing'],
    ['names a tab nobody has', '/admin/ticketing/nonsense'],
    ['names it outright', '/admin/ticketing/departments'],
  ])('selects Departments when the url %s', async (_case, path) => {
    await renderTicketing(path);

    expect(await screen.findByRole('tab', { name: 'Departments', selected: true })).toBeVisible();
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('names the deliverable a tab is waiting for', async () => {
    await renderTicketing('/admin/ticketing/statuses');

    expect(await screen.findByText('Statuses arrives with M1-02.')).toBeInTheDocument();
  });
});
