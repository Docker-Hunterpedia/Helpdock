import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The SLAs tab against the fixture (`AdminTicketingSLAs`, M3-02): the policy
 * list in order, the editor, a target of 0 that stops the save, escalation
 * actions, a new policy and a delete, and the settings for every policy.
 */

const renderSlas = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    initialEntries: ['/admin/ticketing/slas'],
  });

  await screen.findByRole('form', { name: 'SLA policy' });

  return { ...rendered, ticketing: apis.ticketing };
};

const editor = () => screen.getByRole('form', { name: 'SLA policy' });

describe('the SLAs tab', () => {
  it('lists the policies in order and opens the first', async () => {
    await renderSlas();

    const list = screen.getByRole('list', { name: 'SLA policies' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Onboarding on-call'),
      expect.stringContaining('Support and Billing'),
    ]);
    expect(within(editor()).getByDisplayValue('Onboarding on-call')).toBeVisible();
    expect(screen.getByText(/A ticket no policy matches has no SLA clocks/)).toBeVisible();
  });

  it('refuses a target of 0 and says how many fields need attention', async () => {
    const { user } = await renderSlas();
    await user.click(screen.getByRole('button', { name: /^\d\s*Support and Billing$/ }));

    const low = within(editor()).getByLabelText('Resolution target for Low');
    fireEvent.change(low, { target: { value: '0' } });

    expect(within(editor()).getByText('Enter a target above 0.')).toBeVisible();
    expect(within(editor()).getByText('1 field needs attention')).toBeVisible();
    await user.click(within(editor()).getByRole('button', { name: 'Save policy' }));
    expect(screen.queryByText(/Policy Support and Billing saved/)).toBeNull();
  });

  it('saves a changed target and an added step action', async () => {
    const { user, ticketing } = await renderSlas();
    await user.click(screen.getByRole('button', { name: /^\d\s*Support and Billing$/ }));

    fireEvent.change(within(editor()).getByLabelText('First response target for High'), {
      target: { value: '3' },
    });
    const steps = within(editor()).getAllByRole('button', { name: 'Add action' });
    await user.click(steps[0] as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: 'Raise priority' }));
    await user.click(within(editor()).getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText(/Policy Support and Billing saved/)).toBeVisible();
    const saved = (await ticketing.slaPolicies('any')).policies.find(
      (policy) => policy.name === 'Support and Billing',
    );
    expect(saved?.targets.high.firstResponseMinutes).toBe(180);
    expect(saved?.escalation[0]?.actions.map((action) => action.type)).toEqual([
      'notify',
      'raise_priority',
    ]);
  });

  it('creates a new policy once it has a name, and deletes it', async () => {
    const { user, ticketing } = await renderSlas();

    await user.click(screen.getByRole('button', { name: 'New policy' }));
    await user.click(within(editor()).getByRole('button', { name: 'Save policy' }));
    expect(within(editor()).getByText('Name the policy to save it.')).toBeVisible();

    await user.type(within(editor()).getByLabelText(/Policy name/), 'Everything else');
    await user.click(within(editor()).getByRole('button', { name: 'Save policy' }));
    expect(
      await within(screen.getByRole('list', { name: 'SLA policies' })).findByText(
        'Everything else',
      ),
    ).toBeVisible();

    await user.click(within(editor()).getByRole('button', { name: 'Delete policy' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete policy' }),
    );
    expect(await screen.findByText('Policy Everything else deleted')).toBeVisible();
    expect((await ticketing.slaPolicies('any')).policies).toHaveLength(2);
  });

  it('saves the settings for every policy as they change', async () => {
    const { user, ticketing } = await renderSlas();

    await user.click(screen.getByRole('switch', { name: /An AI auto-reply counts/ }));
    expect(await screen.findByText('SLA settings saved')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Count reopens too' }));

    expect((await ticketing.brand('any')).settings).toMatchObject({
      aiCountsAsFirstResponse: false,
      slaCountReopens: true,
    });
    expect(screen.getByText('Awaiting customer')).toBeVisible();
  });

  it('moves a policy with the arrow keys on its handle', async () => {
    const { user, ticketing } = await renderSlas();

    screen.getByRole('button', { name: 'Reorder Support and Billing' }).focus();
    await user.keyboard('{ArrowUp}');

    expect(await screen.findByText('Policy order saved')).toBeVisible();
    expect((await ticketing.slaPolicies('any')).policies[0]?.name).toBe('Support and Billing');
  });
});
