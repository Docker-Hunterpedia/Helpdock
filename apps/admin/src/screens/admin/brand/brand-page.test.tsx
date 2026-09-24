import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Danger zone tab against the fixture: what the form shows, what it sends,
 * and what it refuses to send.
 */

const renderBrand = async (path = '/admin/brand') => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: [path],
  });

  await screen.findByRole('heading', { name: 'Data retention' });

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
  it('opens on the Danger zone tab', async () => {
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
