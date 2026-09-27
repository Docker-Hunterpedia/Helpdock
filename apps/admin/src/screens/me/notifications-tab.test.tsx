import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockBrowserPush } from '../../notifications/browser-push.js';
import { MockNotificationsApi } from '../../notifications/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { PUSH_SUBSCRIPTION_STORAGE } from './notifications-tab.tsx';

/**
 * Your account › Notifications (M3-07): the matrix saves only on Save, Discard
 * puts it back, the push column follows the install, and the push card walks
 * through its four states.
 */

const renderTab = async ({
  api = new MockNotificationsApi({ pushConfigured: true }),
  push = new MockBrowserPush(),
  path = '/me/notifications',
} = {}) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    notificationsApi: api,
    browserPush: push,
    initialEntries: [path],
  });
  await screen.findByRole('heading', { name: 'What you are told about, and where' });

  return { ...rendered, api, push };
};

afterEach(() => {
  window.localStorage.clear();
});

describe('Your account', () => {
  it('opens Security from /me, with the three tabs', async () => {
    const { auth, staff } = await signedInMockApis();
    renderApp(<AppRoutes />, { authApi: auth, staffApi: staff, initialEntries: ['/me'] });

    await screen.findByRole('heading', { name: 'Your account', level: 1 });
    const tabs = within(screen.getByRole('tablist', { name: 'Your account' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Security',
      'Notifications',
      'Email signature',
    ]);
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a place for the email signature', async () => {
    const { auth, staff } = await signedInMockApis();
    renderApp(<AppRoutes />, {
      authApi: auth,
      staffApi: staff,
      initialEntries: ['/me/signature'],
    });

    expect(
      await screen.findByText('Your email signature arrives with the email channel.'),
    ).toBeInTheDocument();
  });

  it('sends an unknown tab to Security', async () => {
    const { auth, staff } = await signedInMockApis();
    renderApp(<AppRoutes />, { authApi: auth, staffApi: staff, initialEntries: ['/me/nothing'] });

    expect(await screen.findByRole('tab', { name: 'Security' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('the preference matrix', () => {
  it('shows the defaults, names each box, and says where email goes', async () => {
    await renderTab();

    expect(screen.getByRole('checkbox', { name: 'Assigned to me, email' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'SLA warning, email' })).not.toBeChecked();
    expect(screen.getByText(/Emails go to lina@helpdock.com in English/)).toBeInTheDocument();
    expect(screen.getByText('Someone writes @Lina in an internal note')).toBeInTheDocument();
  });

  it('saves only on Save, and Discard puts the saved state back', async () => {
    const { user, api } = await renderTab();
    const box = screen.getByRole('checkbox', { name: 'SLA warning, email' });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.click(box);
    expect(box).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(box).not.toBeChecked();

    await user.click(box);
    await user.click(save);

    expect(await screen.findByText('Notification settings saved.')).toBeInTheDocument();
    expect((await api.preferences()).preferences.sla_warning.email).toBe(true);
  });

  it('says a save failed and keeps what was chosen', async () => {
    const api = new MockNotificationsApi({ pushConfigured: true });
    api.updatePreferences = () => Promise.reject(new Error('down'));
    const { user } = await renderTab({ api });

    await user.click(screen.getByRole('checkbox', { name: 'Reply on my tickets, email' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('That did not work. Nothing was changed.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Reply on my tickets, email' })).toBeChecked();
  });

  it('disables the push column on an install without VAPID keys, and says why', async () => {
    await renderTab({ api: new MockNotificationsApi({ pushConfigured: false }) });

    expect(screen.getByRole('checkbox', { name: 'SLA breach, browser push' })).toBeDisabled();
    expect(screen.getByText('Not set up on this install')).toBeInTheDocument();
  });

  it('says the settings could not be loaded', async () => {
    const api = new MockNotificationsApi();
    api.preferences = () => Promise.reject(new Error('down'));
    const { auth, staff } = await signedInMockApis();
    renderApp(<AppRoutes />, {
      authApi: auth,
      staffApi: staff,
      notificationsApi: api,
      initialEntries: ['/me/notifications'],
    });

    expect(
      await screen.findByText(
        'Your notification settings could not be loaded. Try again in a moment.',
      ),
    ).toBeInTheDocument();
  });
});

describe('browser push on this browser', () => {
  it('turns on, sends a test, and turns off', async () => {
    const { user, api, push } = await renderTab();
    expect(screen.getByText('Not enabled')).toBeInTheDocument();
    expect(screen.getByText('· Chrome on macOS')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Turn on for this browser' }));

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(await push.subscribed()).toBe(true);
    expect(window.localStorage.getItem(PUSH_SUBSCRIPTION_STORAGE)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(api.testPushes).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Not enabled')).toBeInTheDocument();
    expect(await push.subscribed()).toBe(false);
    expect((await api.preferences()).push.subscriptions).toEqual([]);
  });

  it('says the browser blocked it when the prompt is refused', async () => {
    const { user } = await renderTab({ push: new MockBrowserPush({ answer: 'denied' }) });

    await user.click(screen.getByRole('button', { name: 'Turn on for this browser' }));

    expect(await screen.findByText('Blocked by the browser')).toBeInTheDocument();
  });

  it('says a browser that cannot receive push cannot', async () => {
    await renderTab({ push: new MockBrowserPush({ permission: 'unsupported' }) });

    expect(screen.getByText('Not available in this browser')).toBeInTheDocument();
  });

  it('says so when turning on fails for another reason', async () => {
    const api = new MockNotificationsApi({ pushConfigured: true });
    api.subscribe = () => Promise.reject(new Error('down'));
    const { user } = await renderTab({ api });

    await user.click(screen.getByRole('button', { name: 'Turn on for this browser' }));

    expect(
      await screen.findByText('Browser push could not be turned on. Try again in a moment.'),
    ).toBeInTheDocument();
  });
});
