import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Business hours tab against the fixture (`AdminTicketingBusinessHours`,
 * M3-01): the brand's week, a range that cannot be saved, a department
 * override, and holidays that save as they are added.
 */

const renderHours = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    initialEntries: ['/admin/ticketing/business-hours'],
  });

  await screen.findByRole('heading', { name: 'Business hours', level: 2 });

  return { ...rendered, ticketing: apis.ticketing };
};

describe('the Business hours tab', () => {
  it('draws the brand week Sunday to Thursday, with the weekend closed', async () => {
    await renderHours();

    expect(screen.getByRole('switch', { name: 'Sunday open' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Friday open' })).not.toBeChecked();
    expect(screen.getAllByText('Closed all day').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('refuses to save a range that ends before it starts, and says where', async () => {
    const { user } = await renderHours();

    await user.click(screen.getByRole('switch', { name: 'Saturday open' }));
    // A time input takes a whole value at once; jsdom cannot type into one.
    fireEvent.change(screen.getAllByLabelText('Saturday closes')[0] as HTMLInputElement, {
      target: { value: '08:00' },
    });

    expect(await screen.findByText('The range ends before it starts.')).toBeVisible();
    expect(screen.getByText(/Fix the Saturday range in the brand hours to save/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a department override with the week and recomputes', async () => {
    const { user, ticketing } = await renderHours();

    await user.click(screen.getByRole('button', { name: 'Hours for Billing' }));
    await user.click(screen.getByRole('radio', { name: 'Use its own hours' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Business hours saved/)).toBeVisible();
    const saved = await ticketing.businessHours('any');
    expect(saved.departments.find((row) => row.name === 'Billing')?.override).toMatchObject({
      timezone: 'Asia/Riyadh',
    });
  });

  it('adds a holiday once it has a name, and deletes one', async () => {
    const { user } = await renderHours();
    const form = screen.getByRole('form', { name: 'Add a holiday' });

    await user.click(within(form).getByRole('button', { name: 'Add holiday' }));
    expect(await within(form).findByText('Name the holiday to add it.')).toBeVisible();

    await user.type(within(form).getByLabelText(/^Name/), 'Saudi National Day');
    await user.click(within(form).getByRole('button', { name: 'Add holiday' }));
    expect(await screen.findByText('Holiday Saudi National Day added')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete Founding Day' }));
    expect(await screen.findByText('Holiday Founding Day deleted')).toBeVisible();
  });

  it('copies Sunday onto the other open days and discards back to the stored week', async () => {
    const { user } = await renderHours();

    await user.click(screen.getByRole('button', { name: 'Add a range to Sunday' }));
    await user.click(screen.getByRole('button', { name: 'Copy Sunday to weekdays' }));
    expect(screen.getAllByLabelText('Monday opens')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getAllByLabelText('Monday opens')).toHaveLength(1);
  });
});
