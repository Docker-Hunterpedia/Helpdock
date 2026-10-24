import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { AuthError } from '../../auth/api.js';
import { MockBrowserPush } from '../../notifications/browser-push.js';
import { MOCK_EMAIL_STATE_STORAGE, MockNotificationsApi } from '../../notifications/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { toWallClock } from '../help-center/time.js';

/**
 * The Email schedule card of Your account › Notifications (M14-11,
 * `Admin/Account-Notifications-Schedule`): the four schedules, the digest hour,
 * Pause, the test email, and the line that says what is stopping email.
 */

const FIRST_PAINT_MS = 5_000;

/** The mock view's `digestTimeZone`: the zone the card works the presets out in. */
const VIEW_ZONE = 'Asia/Riyadh';

/** The day and hour an instant reads as in the view's zone, whatever zone the runner is in. */
const inViewZone = (at: Date): { day: string; hour: string } => {
  const { date, time } = toWallClock(at.toISOString(), VIEW_ZONE);

  return { day: date, hour: time.slice(0, 2) };
};

/** The calendar day `days` after today in the view's zone. */
const dayAfterToday = (days: number): string => {
  const [y, m, d] = inViewZone(new Date()).day.split('-').map(Number) as [number, number, number];

  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const preset = (state: Record<string, unknown>): void => {
  window.localStorage.setItem(MOCK_EMAIL_STATE_STORAGE, JSON.stringify(state));
};

const renderTab = async (api = new MockNotificationsApi({ pushConfigured: true })) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    notificationsApi: api,
    browserPush: new MockBrowserPush(),
    initialEntries: ['/settings/account/notifications'],
  });
  await screen.findByRole('heading', { name: 'Email schedule' }, { timeout: FIRST_PAINT_MS });

  return { ...rendered, api };
};

const card = () => screen.getByRole('region', { name: 'Email schedule' });

afterEach(() => {
  window.localStorage.clear();
});

describe('the schedules', () => {
  it('offers the four, with Right away chosen, and names the hour’s zone', async () => {
    await renderTab();
    const group = within(card()).getByRole('radiogroup');

    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.id.split('-').pop()),
    ).toEqual(['immediate', 'hourly', 'daily', 'off']);
    expect(within(group).getByRole('radio', { name: /^Right away/ })).toBeChecked();
    expect(within(card()).getByLabelText('Hour of the daily digest')).toHaveValue('8');
    expect(within(card()).getByText('Asia/Riyadh')).toBeInTheDocument();
  });

  it('saves a chosen schedule only on Save, and Discard puts the saved one back', async () => {
    const { user, api } = await renderTab();
    const save = within(card()).getByRole('button', { name: 'Save schedule' });
    expect(save).toBeDisabled();

    await user.click(within(card()).getByRole('radio', { name: /^Hourly digest/ }));
    await user.click(within(card()).getByRole('button', { name: 'Discard schedule changes' }));
    expect(within(card()).getByRole('radio', { name: /^Right away/ })).toBeChecked();

    await user.click(within(card()).getByRole('radio', { name: /^Hourly digest/ }));
    await user.click(save);

    expect(await screen.findByText('Email schedule saved.')).toBeInTheDocument();
    expect((await api.preferences()).emailDelivery.schedule).toBe('hourly');
  });

  it('chooses Daily when the hour is changed, and saves the hour with it', async () => {
    const { user, api } = await renderTab();

    await user.selectOptions(within(card()).getByLabelText('Hour of the daily digest'), '17:00');

    expect(within(card()).getByRole('radio', { name: /Daily digest/ })).toBeChecked();
    await user.click(within(card()).getByRole('button', { name: 'Save schedule' }));
    await screen.findByText('Email schedule saved.');
    expect((await api.preferences()).emailDelivery).toMatchObject({
      schedule: 'daily',
      digestHour: 17,
    });
  });

  it('says a save failed and keeps the choice', async () => {
    const api = new MockNotificationsApi({ pushConfigured: true });
    api.updateSettings = () => Promise.reject(new Error('down'));
    const { user } = await renderTab(api);

    await user.click(within(card()).getByRole('radio', { name: /^Off/ }));
    await user.click(within(card()).getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText('That did not work. Nothing was changed.')).toBeInTheDocument();
    expect(within(card()).getByRole('radio', { name: /^Off/ })).toBeChecked();
  });

  it('says email is off once the Off schedule is saved', async () => {
    preset({ schedule: 'off' });
    await renderTab();

    expect(within(card()).getByRole('status')).toHaveTextContent(
      'Email is off. The bell and push still reach you.',
    );
  });
});

describe('Pause', () => {
  it('pauses for an hour from the menu and says until when, then resumes', async () => {
    const { user, api } = await renderTab();

    await user.click(within(card()).getByRole('button', { name: 'Pause notifications' }));
    const menu = await screen.findByRole('menu', { name: 'Pause email and push' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.firstChild?.textContent),
    ).toEqual(['For 1 hour', 'Until tomorrow 09:00', 'For 1 week', 'Until a date…']);
    await user.click(within(menu).getByRole('menuitem', { name: /For 1 hour/ }));

    expect(await within(card()).findByRole('status')).toHaveTextContent(
      /Paused until \d\d:\d\d\. Email and push resume then; the bell keeps everything\./,
    );
    const paused = (await api.preferences()).emailDelivery.pausedUntil;
    expect(Date.parse(paused ?? '') - Date.now()).toBeGreaterThan(3_500_000);

    await user.click(within(card()).getByRole('button', { name: 'Resume now' }));

    expect(await screen.findByText('Email and push are back on.')).toBeInTheDocument();
    expect((await api.preferences()).emailDelivery.pausedUntil).toBeNull();
  });

  it('pauses until 09:00 tomorrow in the reader’s time zone', async () => {
    const { user, api } = await renderTab();

    await user.click(within(card()).getByRole('button', { name: 'Pause notifications' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Until tomorrow 09:00' }));
    await within(card()).findByText(/^Paused until /);

    const until = new Date((await api.preferences()).emailDelivery.pausedUntil ?? '');
    expect(inViewZone(until)).toEqual({ day: dayAfterToday(1), hour: '09' });
  });

  it('pauses until a chosen date, refusing a day outside the year', async () => {
    const { user, api } = await renderTab();
    await user.click(within(card()).getByRole('button', { name: 'Pause notifications' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Until a date…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause until a date' });
    const date = within(dialog).getByLabelText('Resume on');

    await user.clear(date);
    await user.type(date, '2099-01-01');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose a day within a year from today.',
    );
    expect(within(dialog).getByRole('button', { name: 'Pause' })).toBeDisabled();

    const value = dayAfterToday(14);
    await user.clear(date);
    await user.type(date, value);
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));

    await within(await screen.findByRole('region', { name: 'Email schedule' })).findByText(
      /^Paused until /,
    );
    const until = new Date((await api.preferences()).emailDelivery.pausedUntil ?? '');
    expect(inViewZone(until)).toEqual({ day: value, hour: '09' });
  });
});

describe('the status line', () => {
  it('says when the person unsubscribed and turns email back on, keeping the same choices', async () => {
    preset({ unsubscribedAt: '2026-10-03T08:00:00.000Z', schedule: 'daily', digestHour: 6 });
    const { user, api } = await renderTab();

    expect(within(card()).getByRole('status')).toHaveTextContent(
      'You unsubscribed on 3 Oct. The bell, push and security emails still reach you.',
    );
    expect(within(card()).getByRole('radio', { name: /Daily digest/ })).toBeChecked();

    await user.click(within(card()).getByRole('button', { name: 'Turn email back on' }));

    expect(await screen.findByText('Email is back on.')).toBeInTheDocument();
    expect((await api.preferences()).emailDelivery).toMatchObject({
      unsubscribedAt: null,
      schedule: 'daily',
      digestHour: 6,
    });
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('says an install without outgoing email cannot send, and disables the test email', async () => {
    preset({ smtp: false });
    await renderTab();

    expect(within(card()).getByRole('status')).toHaveTextContent(
      "This install can't send email yet",
    );
    expect(within(card()).getByRole('button', { name: 'Send me a test email' })).toBeDisabled();
  });
});

describe('the test email', () => {
  it('asks for one to the person’s own address and says where it is going', async () => {
    const { user, api } = await renderTab();

    await user.click(within(card()).getByRole('button', { name: 'Send me a test email' }));

    expect(
      await screen.findByText('A test email is on its way to lina@helpdock.com.'),
    ).toBeInTheDocument();
    expect(api.testEmails).toBe(1);
  });

  it.each([
    [
      new AuthError('rate-limited', { status: 429 }),
      "That's enough test emails for now. Try again later.",
    ],
    [new AuthError('unavailable', { status: 409 }), "This install can't send email yet."],
    [new Error('down'), 'That did not work. Nothing was changed.'],
  ])('names why it did not go (%#)', async (error, message) => {
    const api = new MockNotificationsApi({ pushConfigured: true });
    api.testEmail = () => Promise.reject(error);
    const { user } = await renderTab(api);

    await user.click(within(card()).getByRole('button', { name: 'Send me a test email' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});

describe('the matrix beneath', () => {
  it('captions the three kinds that can cut the wait as Urgent', async () => {
    await renderTab();

    for (const [row, urgent] of [
      ['Mentioned in a note', true],
      ['SLA breach', true],
      ['Escalation', true],
      ['Assigned to me', false],
      ['Reply on my tickets', false],
      ['SLA warning', false],
    ] as const) {
      const header = screen.getByRole('rowheader', { name: new RegExp(`^${row}`) });
      expect(within(header).queryByText('Urgent') !== null).toBe(urgent);
    }
  });
});
