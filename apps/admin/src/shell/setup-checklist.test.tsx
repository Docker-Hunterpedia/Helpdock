import type { Session } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import { MOCK_BRANDS, type MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import type { MockStaffApi } from '../staff/mock-api.js';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { SIDEBAR_STORAGE_KEY } from './sidebar-collapse.js';

const FINISHED = MOCK_BRANDS[1]?.id ?? '';
const REFUSED = MOCK_BRANDS[2]?.id ?? '';

const asProps = ({ auth, staff }: AdminApis) => ({ authApi: auth, staffApi: staff });

const open = async (
  apis: AdminApis,
  changes: Partial<Session> & { role?: Session['user']['role'] } = {},
) => {
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('expected a session');
  }
  const { role, ...sessionChanges } = changes;
  const changed: Session = {
    ...session,
    ...sessionChanges,
    user: { ...session.user, ...(role === undefined ? {} : { role }) },
  };
  (apis.auth as MockAuthApi).me = async () => changed;

  const rendered = renderApp(<AppRoutes />, { ...asProps(apis), initialEntries: ['/tickets'] });
  await screen.findByRole('navigation', { name: 'Main' });

  return rendered;
};

const entry = () => screen.findByRole('button', { name: 'Get set up, 3 of 9 done' });

describe('the setup checklist entry (M14-13)', () => {
  it('shows an Admin how far along the brand is', async () => {
    await open(await signedInMockApis());

    const button = await entry();
    expect(button).toHaveTextContent('Get set up');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['teamLeader', 'agent', 'viewer'] as const)('is not drawn for a %s', async (role) => {
    const apis = await signedInMockApis();
    const read = vi.spyOn(apis.staff, 'setupChecklist');
    await open(apis, { role });

    expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('is not drawn once the required steps are done, for anyone', async () => {
    await open(await signedInMockApis(), { currentBrandId: FINISHED });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
    });
  });

  it('is not drawn when the api refuses the checklist', async () => {
    const apis = await signedInMockApis();
    const read = vi.spyOn(apis.staff, 'setupChecklist');
    await open(apis, { currentBrandId: REFUSED });

    await waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
  });

  it('is not drawn on the collapsed rail, which has no room for it', async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    const apis = await signedInMockApis();
    await open(apis);

    expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
  });

  it('opens a panel of the nine steps, with a link only on the ones still to do', async () => {
    const { user } = await open(await signedInMockApis());

    await user.click(await entry());

    const panel = await screen.findByRole('dialog', { name: 'Get set up' });
    expect(within(panel).getByText('3 of 9 done')).toBeInTheDocument();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(9);
    expect(
      within(panel).queryByRole('link', { name: /Connect a channel/ }),
    ).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('link')).toHaveLength(6);
    expect(
      within(panel).getByRole('link', { name: 'Go to: Create an SLA policy' }),
    ).toHaveAttribute('href', '/admin/ticketing/slas');
    expect(
      within(panel).getByRole('link', { name: 'Go to: Receive your first ticket' }),
    ).toHaveAttribute('href', '/tickets');
    // Done steps say so in words, not only with a tick and a line through them.
    expect(within(panel).getAllByText('Done')).toHaveLength(3);
    expect(within(panel).getByText('optional')).toBeInTheDocument();
  });

  it('closes the panel when a step’s link is followed', async () => {
    const { user } = await open(await signedInMockApis());
    await user.click(await entry());

    await user.click(await screen.findByRole('link', { name: 'Go to: Create an SLA policy' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Get set up' })).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('heading', { name: 'Ticketing', level: 1 })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the entry', async () => {
    const { user } = await open(await signedInMockApis());
    const button = await entry();

    await user.click(button);
    await screen.findByRole('dialog', { name: 'Get set up' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Get set up' })).not.toBeInTheDocument();
    });
    expect(button).toHaveFocus();
  });

  it('reads the steps again when it opens, and says so once every required one is done', async () => {
    const apis = await signedInMockApis();
    const { user } = await open(apis);
    await user.click(await entry());
    await screen.findByRole('dialog', { name: 'Get set up' });

    const staff = apis.staff as MockStaffApi;
    const brandId = MOCK_BRANDS[0]?.id ?? '';
    for (const step of ['slaPolicy', 'assignment', 'reply', 'article', 'firstTicket'] as const) {
      staff.completeSetupStep(brandId, step);
    }
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: /^Get set up/ }));

    expect(
      await screen.findByText('Helpdock is set up. This checklist hides itself for everyone.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide this checklist' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
    });
  });

  it('hides itself for the person who asks, and stays hidden', async () => {
    const apis = await signedInMockApis();
    const { user } = await open(apis);
    await user.click(await entry());

    await user.click(await screen.findByRole('button', { name: 'Hide this checklist' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Get set up/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: 'Get set up' })).not.toBeInTheDocument();
    expect((await apis.staff.setupChecklist(MOCK_BRANDS[0]?.id ?? '')).dismissed).toBe(true);
  });

  it('keeps the checklist and says so when hiding it fails', async () => {
    const apis = await signedInMockApis();
    vi.spyOn(apis.staff, 'dismissSetupChecklist').mockRejectedValue(new Error('offline'));
    const { user } = await open(apis);
    await user.click(await entry());

    await user.click(await screen.findByRole('button', { name: 'Hide this checklist' }));

    expect(
      await screen.findByText('The checklist could not be hidden. Try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Get set up' })).toBeInTheDocument();
  });
});
