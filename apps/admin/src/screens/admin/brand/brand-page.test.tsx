import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import {
  activeDeletion,
  fakeSystemApi,
  pendingDeletion,
  SESSION_BRAND,
} from '../system/fixtures.js';
import { type SystemApi, SystemApiError } from '../system/system-api.js';

/**
 * The Danger zone tab against the fixture: what the form shows, what it sends,
 * and what it refuses to send; and brand deletion (M8-07).
 */

const renderBrand = async (
  path = '/admin/brand/danger',
  systemApi: SystemApi = fakeSystemApi(),
) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    systemApi,
    initialEntries: [path],
  });

  // The first render pulls in the whole app; on a busy machine it takes more than a second.
  await screen.findByRole('heading', { name: 'Data retention' }, { timeout: 10_000 });

  return rendered;
};

const rowFor = (label: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(label) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${label}`);
  }

  return row;
};

describe('the Brand page', () => {
  it('opens the Danger zone tab by its path', async () => {
    await renderBrand();

    expect(screen.getByRole('tab', { name: 'Danger zone' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows each window with how many rows the next run would take', async () => {
    await renderBrand('/admin/brand/danger');

    expect(within(rowFor('Closed tickets and their messages')).getByText('12 rows')).toBeVisible();
    expect(within(rowFor('Spam tickets')).getByText('62 rows')).toBeVisible();
    expect(within(rowFor('AI call logs')).getByText('Not counted yet')).toBeInTheDocument();
    expect(screen.getByText(/74 rows purged/)).toBeVisible();
  });

  it('keeps Save asleep until something changes', async () => {
    await renderBrand();

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('saving', () => {
  it('sends the whole form, with "Forever" for closed tickets', async () => {
    const { user, ticketingApi } = await renderBrand();
    const update = vi.spyOn(ticketingApi, 'updateRetention');

    await user.click(screen.getByRole('combobox', { name: 'Closed tickets retention' }));
    await user.click(await screen.findByRole('option', { name: 'Forever' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Data retention saved.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ closedTickets: { kind: 'never' }, auditLogDays: 730 }),
    );
    expect(
      within(rowFor('Closed tickets and their messages')).getByText('Not counted yet'),
    ).toBeInTheDocument();
  });

  it('refuses an audit log shorter than 90 days, and says why', async () => {
    const { user, ticketingApi } = await renderBrand();
    const update = vi.spyOn(ticketingApi, 'updateRetention');

    const days = screen.getByRole('spinbutton', { name: 'Audit log retention days' });
    await user.clear(days);
    await user.type(days, '30');

    expect(screen.getByText('Enter a whole number of days from 90 to 3650.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('puts the saved values back on Discard', async () => {
    const { user } = await renderBrand();

    const spam = screen.getByRole('spinbutton', { name: 'Spam tickets retention days' });
    await user.clear(spam);
    await user.type(spam, '7');
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(spam).toHaveValue(30);
  });

  it('says so when the save fails', async () => {
    const { user, ticketingApi } = await renderBrand();
    vi.spyOn(ticketingApi, 'updateRetention').mockRejectedValue(new Error('boom'));

    const spam = screen.getByRole('spinbutton', { name: 'Spam tickets retention days' });
    await user.clear(spam);
    await user.type(spam, '14');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('The retention settings could not be saved. Try again.'),
    ).toBeInTheDocument();
  });
});

describe('deleting the brand (M8-07)', () => {
  it('asks for the ticket prefix, which is what the api checks, before it will delete', async () => {
    const deleteBrand = vi.fn(async (brandId: string) => pendingDeletion(brandId, Date.now()));
    const { user } = await renderBrand('/admin/brand/danger', fakeSystemApi({ deleteBrand }));

    const card = screen.getByRole('region', { name: 'Delete this brand' });
    const submit = within(card).getByRole('button', { name: 'Delete brand' });
    const confirm = within(card).getByRole('textbox', { name: 'Type HD to confirm' });
    expect(submit).toBeDisabled();

    await user.type(confirm, 'Helpdock');
    expect(submit).toBeDisabled();

    await user.clear(confirm);
    await user.type(confirm, 'HD');
    await user.click(submit);

    expect(deleteBrand).toHaveBeenCalledWith(SESSION_BRAND, 'HD');
    expect(await screen.findByText(/^Scheduled for deletion on/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Delete this brand' })).not.toBeInTheDocument();
  });

  it('says why when the api refuses the prefix', async () => {
    const { user } = await renderBrand(
      '/admin/brand/danger',
      fakeSystemApi({
        deleteBrand: async () => {
          throw new SystemApiError('the api answered 400', 400);
        },
      }),
    );

    await user.type(screen.getByRole('textbox', { name: 'Type HD to confirm' }), 'HD');
    await user.click(screen.getByRole('button', { name: 'Delete brand' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That is not this brand's ticket prefix.",
    );
  });

  it('shows the banner on every tab during the grace, read-only, and restores', async () => {
    const restoreBrand = vi.fn(async (brandId: string) => activeDeletion(brandId));
    const { user } = await renderBrand(
      '/admin/brand/danger',
      fakeSystemApi({
        brandDeletion: async (brandId) => pendingDeletion(brandId, Date.now()),
        restoreBrand,
      }),
    );

    expect(await screen.findByText(/^Scheduled for deletion on/)).toBeVisible();
    await waitFor(() => {
      expect(
        screen.getByRole('spinbutton', { name: 'Spam tickets retention days' }),
      ).toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(restoreBrand).toHaveBeenCalledWith(SESSION_BRAND);
    expect(await screen.findByText('Helpdock is restored.')).toBeInTheDocument();
    expect(screen.queryByText(/^Scheduled for deletion on/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Spam tickets retention days' })).toBeEnabled();
  });
});
