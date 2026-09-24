import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Feedback tab against the fixture (`AdminTicketingFeedback`, M1-12): the
 * three toggles, one save, and a composer toggle that means nothing while time
 * tracking is off.
 */

const renderFeedback = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    initialEntries: ['/admin/ticketing/feedback'],
  });

  await screen.findByRole('form', { name: 'Feedback and time settings' });

  return { ...rendered, ticketing: apis.ticketing };
};

const box = (name: RegExp) => screen.getByRole('checkbox', { name });

describe('the Feedback tab', () => {
  it('starts from the brand’s settings: CSAT on, time tracking off', async () => {
    await renderFeedback();

    expect(box(/Ask for a rating/)).toBeChecked();
    expect(box(/Track time on tickets/)).not.toBeChecked();
    expect(box(/Start the timer/)).toBeDisabled();
  });

  it('saves the three toggles together and says so', async () => {
    const { user, ticketing } = await renderFeedback();

    await user.click(box(/Ask for a rating/));
    await user.click(box(/Track time on tickets/));
    await user.click(box(/Start the timer/));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Feedback settings saved')).toBeVisible();
    expect((await ticketing.brand('any')).settings).toMatchObject({
      csatEnabled: false,
      timeTrackingEnabled: true,
      timerStartsWithComposer: true,
    });
  });

  it('puts the form back as stored on Discard, and has nothing to save until something changes', async () => {
    const { user } = await renderFeedback();
    const save = screen.getByRole('button', { name: 'Save changes' });

    expect(save).toBeDisabled();
    await user.click(box(/Ask for a rating/));
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(box(/Ask for a rating/)).toBeChecked();
    expect(save).toBeDisabled();
  });
});
