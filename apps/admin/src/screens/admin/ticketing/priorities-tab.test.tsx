import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { AuthError } from '../../../auth/api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { FieldValidationError } from '../../../ticketing/field-errors.js';
import type { MockTicketingApi } from '../../../ticketing/mock-api.js';

/**
 * The Priorities page against the fixture (`Admin/Ticketing-Priorities`,
 * M1-02): eight fields, one save, a duplicate found before the api is asked,
 * and a refused save that keeps what was typed.
 */

const renderPriorities = async (ticketingApi?: MockTicketingApi) => {
  const apis = await signedInMockApis();
  const ticketing = ticketingApi ?? apis.ticketing;
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: ticketing,
    initialEntries: ['/settings/inbox/priorities'],
  });

  await screen.findByRole('form', { name: 'Priority names' });
  await screen.findByRole('textbox', { name: 'High in English' });

  return { ...rendered, ticketing };
};

const field = (name: string) => screen.getByRole('textbox', { name });
const save = () => screen.getByRole('button', { name: 'Save' });
const discard = () => screen.getByRole('button', { name: 'Discard' });

describe('the Priorities page', () => {
  it('lists the four priorities with the default names as placeholders and nothing to save', async () => {
    await renderPriorities();

    expect(screen.getAllByRole('rowheader')).toHaveLength(4);
    expect(field('High in English')).toHaveAttribute('placeholder', 'High');
    expect(field('High in English')).toHaveValue('');
    expect(field('Urgent in Arabic')).toHaveAttribute('placeholder', 'عاجلة');
    expect(save()).toBeDisabled();
    expect(discard()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Low to its default name' })).toBeDisabled();
  });

  it('names each input for its row and language, in the direction of its language', async () => {
    await renderPriorities();

    expect(field('High in English')).toHaveAttribute('dir', 'ltr');
    expect(field('High in English')).toHaveAttribute('lang', 'en');
    expect(field('High in Arabic')).toHaveAttribute('dir', 'rtl');
    expect(field('High in Arabic')).toHaveAttribute('lang', 'ar');
    expect(field('High in English')).toHaveAttribute('maxlength', '24');
  });

  it('renames, saves all rows at once, says so, and keeps the default in view under the pill', async () => {
    const { user, ticketing } = await renderPriorities();

    await user.type(field('High in English'), ' P2 ');
    await user.type(field('Urgent in English'), 'P1');
    const row = screen.getByRole('rowheader', { name: /P2/ });
    expect(within(row).getByText('Default: High')).toBeVisible();
    await user.click(save());

    expect(await screen.findByText('Priority names saved')).toBeVisible();
    expect((await ticketing.brand('any')).settings.priorityLabels).toEqual({
      high: { en: 'P2' },
      urgent: { en: 'P1' },
    });
    await waitFor(() => {
      expect(save()).toBeDisabled();
    });
  });

  it('resets a row to its defaults without saving, and Discard puts the form back', async () => {
    const { user, ticketing } = await renderPriorities();
    await user.type(field('Low in English'), 'Minor');
    await user.type(field('Low in Arabic'), 'ثانوية');

    await user.click(screen.getByRole('button', { name: 'Reset Low to its default name' }));

    expect(field('Low in English')).toHaveValue('');
    expect(field('Low in Arabic')).toHaveValue('');
    expect(save()).toBeDisabled();

    await user.type(field('Low in English'), 'Minor');
    await user.click(discard());
    expect(field('Low in English')).toHaveValue('');
    expect((await ticketing.brand('any')).settings.priorityLabels).toEqual({});
  });

  it('puts a duplicate under the field edited last, and Save moves focus there without asking the api', async () => {
    const { user, ticketing } = await renderPriorities();
    const update = vi.spyOn(ticketing, 'updatePriorityLabels');

    await user.type(field('High in English'), 'urgent');

    const error = await screen.findByText('Urgent already uses this name');
    expect(field('High in English')).toHaveAttribute('aria-invalid', 'true');
    expect(field('High in English')).toHaveAccessibleDescription('Urgent already uses this name');
    expect(error).toBeVisible();

    await user.click(field('Low in English'));
    await user.click(save());

    expect(update).not.toHaveBeenCalled();
    expect(field('High in English')).toHaveFocus();
  });

  it('keeps what was typed and shows a banner when the save fails', async () => {
    const { user, ticketing } = await renderPriorities();
    vi.spyOn(ticketing, 'updatePriorityLabels').mockRejectedValue(new AuthError('unavailable'));

    await user.type(field('Medium in English'), 'Normal');
    await user.click(save());

    expect(
      await screen.findByText('Could not save the priority names. Nothing was changed. Try again.'),
    ).toBeVisible();
    expect(field('Medium in English')).toHaveValue('Normal');
    expect(save()).toBeEnabled();
  });

  it('puts a field error the api returns under its field', async () => {
    const { user, ticketing } = await renderPriorities();
    vi.spyOn(ticketing, 'updatePriorityLabels').mockRejectedValue(
      new FieldValidationError([{ path: 'medium.en', message: 'Use up to 24 characters' }]),
    );

    await user.type(field('Medium in English'), 'Normal');
    await user.click(save());

    expect(await screen.findByText('Use 1 to 24 characters on one line.')).toBeVisible();
    expect(field('Medium in English')).toHaveAttribute('aria-invalid', 'true');
  });
});
