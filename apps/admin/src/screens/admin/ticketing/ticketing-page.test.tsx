import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The page around the settings: that every one is a link of the Inbox group,
 * that a setting is a url, and that one whose deliverable has not landed says
 * which one it is waiting for rather than pretending to be empty.
 */

const renderTicketing = async (path = '/settings/inbox') => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: [path],
  });

  await screen.findByRole('heading', { level: 1 });

  return rendered;
};

describe('the Inbox settings', () => {
  it('offers every setting M1 will fill as a link of the Inbox group', async () => {
    await renderTicketing();
    const nav = screen.getByRole('navigation', { name: 'Settings' });

    for (const label of [
      'Departments',
      'Statuses',
      'Priorities',
      'Tags',
      'Custom fields',
      'Templates',
      'Views',
      'Assignment',
      'Business hours',
      'SLA policies',
      'Spam',
      'Feedback',
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('says which brand it is describing', async () => {
    await renderTicketing();

    expect(
      await screen.findByText(/Helpdock brand · how tickets are shaped and routed/),
    ).toBeInTheDocument();
  });

  it.each([
    ['names no tab', '/settings/inbox'],
    ['names a tab nobody has', '/settings/inbox/nonsense'],
    ['names it outright', '/settings/inbox/departments'],
  ])('selects Departments when the url %s', async (_case, path) => {
    await renderTicketing(path);

    expect(
      within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('link', {
        name: 'Departments',
        current: 'page',
      }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Departments');
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('names the deliverable a tab is waiting for', async () => {
    await renderTicketing('/settings/inbox/priorities');

    expect(await screen.findByText('Priorities arrives with M1-02.')).toBeInTheDocument();
  });

  it('draws the Views tab rather than a placeholder, since M1-05 filled it', async () => {
    await renderTicketing('/settings/inbox/views');

    expect(await screen.findByRole('button', { name: 'Add view' })).toBeInTheDocument();
  });

  it('draws the Statuses tab rather than a placeholder, since M1-08 filled it', async () => {
    await renderTicketing('/settings/inbox/statuses');

    expect(await screen.findByRole('button', { name: 'Edit Open' })).toBeInTheDocument();
  });

  it.each([
    ['/settings/inbox/tags', 'Add tag'],
    ['/settings/inbox/custom-fields', 'Add ticket field'],
    ['/settings/inbox/templates', 'Add template'],
  ])('draws %s rather than a placeholder, since M1-06 filled it', async (route, control) => {
    await renderTicketing(route);

    expect(await screen.findByRole('button', { name: control })).toBeInTheDocument();
  });

  it('draws the Assignment tab rather than a placeholder, since M1-07 filled it', async () => {
    await renderTicketing('/settings/inbox/assignment');

    expect(await screen.findByRole('button', { name: 'Edit Support' })).toBeInTheDocument();
  });
});
