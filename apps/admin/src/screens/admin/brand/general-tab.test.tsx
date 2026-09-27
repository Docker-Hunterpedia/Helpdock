import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/** Brand › General against the fixture: the Identity card and what it sends. */

const renderGeneral = async () => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: ['/admin/brand'],
  });
  await screen.findByRole('heading', { name: 'Identity' }, { timeout: 10_000 });
  return rendered;
};

describe('Brand › General', () => {
  it('is where /admin/brand opens, with the prefix read-only', async () => {
    await renderGeneral();

    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Ticket prefix')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves the name, the language and the time zone', async () => {
    const { user, ticketingApi } = await renderGeneral();
    const update = vi.spyOn(ticketingApi, 'updateBrand');
    const name = screen.getByLabelText('Brand name');

    await user.clear(name);
    await user.type(name, 'Acme Support');
    await user.selectOptions(screen.getByLabelText('Default language'), 'ar');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Brand saved.')).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: 'Acme Support', defaultLocale: 'ar' }),
    );
  });

  it('refuses an empty name, and discards back to what was saved', async () => {
    const { user } = await renderGeneral();
    const name = screen.getByLabelText('Brand name');
    const saved = (name as HTMLInputElement).value;

    await user.clear(name);

    expect(screen.getByText("Enter the brand's name.")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(name).toHaveValue(saved);
  });

  it('says so when the brand cannot be saved', async () => {
    const { user, ticketingApi } = await renderGeneral();
    vi.spyOn(ticketingApi, 'updateBrand').mockRejectedValue(new Error('down'));

    await user.type(screen.getByLabelText('Brand name'), ' Co');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('The brand could not be saved. Try again.')).toBeInTheDocument();
  });
});
