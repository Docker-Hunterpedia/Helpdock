import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MOCK_WEB_FORM, MockChannelsApi } from '../../../channels/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { updateFrom, withShown } from './web-form-tab.tsx';

/**
 * `Admin/Channels · Web form` against the fixture (M4-09, artboard
 * `AdminWebForm`): the hosted form card with its field table, and the "After it
 * is sent" card with routing, CAPTCHA and the thank-you messages.
 */

const renderWebForm = async (channelsApi = new MockChannelsApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    channelsApi,
    initialEntries: ['/admin/channels/web-form'],
  });
  await screen.findByRole('heading', { name: 'Hosted form' });
  return { ...rendered, channelsApi };
};

const section = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('Channels › Web form', () => {
  it('opens by its url as the fourth tab, with the public address to copy and open', async () => {
    const { user } = await renderWebForm();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    expect(screen.getByRole('tab', { name: 'Web form' })).toHaveAttribute('aria-selected', 'true');
    const hosted = section('Hosted form');
    expect(within(hosted).getByLabelText('Public address')).toHaveValue(MOCK_WEB_FORM.publicUrl);
    expect(within(hosted).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      MOCK_WEB_FORM.publicUrl,
    );

    await user.click(within(hosted).getByRole('button', { name: 'Copy the form address' }));
    expect(writeText).toHaveBeenCalledWith(MOCK_WEB_FORM.publicUrl);
    expect(await screen.findByText('Address copied')).toBeVisible();
  });

  it('keeps Email and Message on, and drops Required when a field is hidden', async () => {
    const { user, channelsApi } = await renderWebForm();
    const hosted = section('Hosted form');

    expect(within(hosted).getByRole('checkbox', { name: 'Show Email' })).toBeDisabled();
    expect(within(hosted).getByRole('checkbox', { name: 'Message is required' })).toBeChecked();

    await user.click(within(hosted).getByRole('checkbox', { name: 'Show Product' }));
    expect(within(hosted).getByRole('checkbox', { name: 'Product is required' })).not.toBeChecked();
    expect(within(hosted).getByRole('checkbox', { name: 'Product is required' })).toBeDisabled();

    await user.click(within(hosted).getByRole('checkbox', { name: 'Show Plan' }));
    await user.click(within(hosted).getByRole('checkbox', { name: 'Plan is required' }));
    await user.click(within(hosted).getByRole('checkbox', { name: 'The form is on' }));
    await user.click(within(hosted).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Web form saved')).toBeVisible();
    const saved = await channelsApi.webForm();
    expect(saved.enabled).toBe(false);
    expect(saved.fields.find((field) => field.field === 'custom:plan')).toMatchObject({
      shown: true,
      required: true,
    });
    expect(saved.fields.find((field) => field.field === 'custom:product')).toMatchObject({
      shown: false,
      required: false,
    });
  });

  it('moves a field with the arrow keys on its handle, and Discard puts it back', async () => {
    const { user } = await renderWebForm();
    const hosted = section('Hosted form');
    const names = () =>
      within(hosted)
        .getAllByRole('button', { name: /^Reorder / })
        .map((button) => button.getAttribute('aria-label'));

    within(hosted).getByRole('button', { name: 'Reorder Subject' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(names().slice(0, 3)).toEqual(['Reorder Name', 'Reorder Subject', 'Reorder Email']);

    await user.click(within(hosted).getByRole('button', { name: 'Discard' }));
    expect(names().slice(0, 3)).toEqual(['Reorder Name', 'Reorder Email', 'Reorder Subject']);
  });

  it('routes to a department, and saves the thank-you messages', async () => {
    const { user, channelsApi } = await renderWebForm();
    const after = section('After it is sent');

    await user.click(within(after).getByRole('combobox', { name: 'Opens tickets in' }));
    await user.click(await screen.findByRole('option', { name: 'Billing' }));
    const english = within(after).getByLabelText('Thank-you message · English');
    await user.clear(english);
    await user.type(english, 'Got it: {{{{ticket.number}}');
    await user.click(within(after).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Web form saved')).toBeVisible();
    const saved = await channelsApi.webForm();
    expect(saved.departmentId).not.toBeNull();
    expect(saved.thankYou.en).toBe('Got it: {{ticket.number}}');
    expect(within(section('What the customer sees')).getByText(/Got it:/)).toHaveTextContent(
      /Got it: [A-Z]+-1043/,
    );
  });

  it('refuses an empty thank-you message', async () => {
    const { user } = await renderWebForm();
    const after = section('After it is sent');

    await user.clear(
      within(after).getByLabelText(/Thank-you message · /, { selector: '[lang="ar"]' }),
    );
    await user.click(within(after).getByRole('button', { name: 'Save changes' }));

    expect(within(after).getByText('Write a thank-you message.')).toBeVisible();
  });

  it('warns when CAPTCHA is on but the Widget tab has no keys', async () => {
    const channelsApi = new MockChannelsApi();
    vi.spyOn(channelsApi, 'webForm').mockResolvedValue({
      ...MOCK_WEB_FORM,
      captcha: { enabled: true, ready: false, provider: null },
    });
    await renderWebForm(channelsApi);

    expect(screen.getByText(/No CAPTCHA keys are set on the Widget tab yet/)).toBeVisible();
  });

  it('says so when the settings cannot be loaded', async () => {
    const channelsApi = new MockChannelsApi();
    vi.spyOn(channelsApi, 'webForm').mockRejectedValue(new Error('down'));
    const apis = await signedInMockApis();
    renderApp(<AppRoutes />, {
      authApi: apis.auth,
      staffApi: apis.staff,
      ticketingApi: apis.ticketing,
      channelsApi,
      initialEntries: ['/admin/channels/web-form'],
    });

    expect(await screen.findByText(/The web form could not be loaded/)).toBeVisible();
  });
});

describe('updateFrom and withShown', () => {
  it('turns the stored settings into the request that saves them unchanged', () => {
    const update = updateFrom(MOCK_WEB_FORM);

    expect(update).toMatchObject({ enabled: true, captchaEnabled: true, departmentId: null });
    expect(update.fields[0]).toEqual({ field: 'name', shown: true, required: false });
  });

  it('never hides a locked field', () => {
    const email = MOCK_WEB_FORM.fields.find((field) => field.field === 'email');
    expect(email === undefined ? null : withShown(email, false)).toEqual(email);
  });
});
