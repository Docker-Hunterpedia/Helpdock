import { NOTIFICATION_SOUND_DEFAULTS } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockBrowserPush } from '../../notifications/browser-push.js';
import { MockNotificationsApi } from '../../notifications/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';

/**
 * The Sounds card of Your account › Notifications (M14-25,
 * `Admin/Account-Notifications-Sounds`): a Switch per event, off by default,
 * saved as soon as it moves, the reminder under the first, a Play button each.
 */

const FIRST_PAINT_MS = 5_000;

const heard: string[] = [];

class FakeAudio {
  currentTime = 0;
  preload = '';

  constructor(readonly src: string) {}

  addEventListener(): void {}

  pause(): void {}

  async play(): Promise<void> {
    heard.push(this.src.split('/').pop() ?? this.src);
  }
}

const renderCard = async (api = new MockNotificationsApi({ pushConfigured: true })) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    notificationsApi: api,
    browserPush: new MockBrowserPush(),
    initialEntries: ['/settings/account/notifications'],
  });
  await screen.findByRole('heading', { name: 'Sounds' }, { timeout: FIRST_PAINT_MS });

  return { ...rendered, api, card: () => screen.getByRole('region', { name: 'Sounds' }) };
};

const LABELS = [
  'A live chat is waiting for an agent',
  'A new conversation',
  'A customer replied',
  'Assigned to me or mentioned',
];

beforeEach(() => {
  heard.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the Sounds card', () => {
  it('lists the four events, each with its own switch, all off', async () => {
    const { card } = await renderCard();

    for (const label of LABELS) {
      expect(within(card()).getByRole('switch', { name: label })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(within(card()).getByRole('button', { name: `Play: ${label}` })).toBeInTheDocument();
    }
    expect(
      within(card()).getByText('Off by default. Follows you to other browsers.'),
    ).toBeInTheDocument();
    expect(within(card()).getByText(/may block sound in background tabs/)).toBeInTheDocument();
  });

  it('saves a switch as soon as it moves, and another browser reads the same choice', async () => {
    const { user, api, card, unmount } = await renderCard();

    await user.click(within(card()).getByRole('switch', { name: 'A customer replied' }));

    await waitFor(async () =>
      expect((await api.preferences()).sounds).toEqual({
        ...NOTIFICATION_SOUND_DEFAULTS,
        customerReply: true,
      }),
    );
    unmount();

    // A second browser opens the same account: the choice comes from the server.
    const other = await renderCard(api);
    expect(
      within(other.card()).getByRole('switch', { name: 'A customer replied' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(other.card()).getByRole('switch', { name: 'A new conversation' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the reminder off and disabled until the waiting-chat sound is on', async () => {
    const { user, api, card } = await renderCard();
    const reminder = within(card()).getByRole('checkbox', {
      name: 'Remind me every minute while it waits',
    });
    expect(reminder).toBeDisabled();

    await user.click(
      within(card()).getByRole('switch', { name: 'A live chat is waiting for an agent' }),
    );
    expect(reminder).toBeEnabled();
    await user.click(reminder);

    await waitFor(async () =>
      expect((await api.preferences()).sounds).toMatchObject({
        waitingChat: true,
        waitingChatReminder: true,
      }),
    );
  });

  it('plays the sound of the button that is pressed, switch on or off', async () => {
    const { user, card } = await renderCard();

    await user.click(within(card()).getByRole('button', { name: 'Play: A new conversation' }));
    await user.click(
      within(card()).getByRole('button', { name: 'Play: Assigned to me or mentioned' }),
    );

    expect(heard).toEqual(['new-conversation.wav', 'assigned-or-mentioned.wav']);
  });

  it('says so and puts the switch back when the change cannot be saved', async () => {
    const api = new MockNotificationsApi({ pushConfigured: true });
    const { user, card } = await renderCard(api);
    api.updateSettings = () => Promise.reject(new Error('down'));

    await user.click(within(card()).getByRole('switch', { name: 'A new conversation' }));

    expect(await screen.findByText('The sound setting could not be saved.')).toBeInTheDocument();
    expect(within(card()).getByRole('switch', { name: 'A new conversation' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
