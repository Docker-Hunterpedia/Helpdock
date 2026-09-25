import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_CLOSED, MOCK_TICKET_REFUND } from '../../tickets/mock-api.js';

/**
 * M1-12 in the ticket workspace: the Time card, the Log time dialog behind the
 * header's ⋯ menu, the per-reply timer, and the survey's state on the ticket.
 */

const wideViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const openTicket = async (
  ticketId: string,
  feedback: { timeTrackingEnabled?: boolean; timerStartsWithComposer?: boolean } = {},
) => {
  const apis = await signedInMockApis();
  await apis.ticketing.updateFeedback('brand', {
    timeTrackingEnabled: false,
    ...feedback,
  });
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    uploader: apis.uploader,
    initialEntries: [`/tickets/${ticketId}`],
  });

  await screen.findByRole('complementary', { name: 'Ticket details' });

  return { ...rendered, tickets: apis.tickets };
};

const timeCard = async (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Time' });

beforeEach(wideViewport);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('time tracking off', () => {
  it('draws no Time card and offers no "Log time…" in the ⋯ menu', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);

    expect(screen.queryByRole('region', { name: 'Time' })).toBeNull();
    // The menu still opens: M1-11's "Mark as spam" shares it.
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Mark as spam' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Log time…' })).toBeNull();
  });
});

describe('time tracking on', () => {
  it('logs time from the header menu’s dialog and totals it on the card', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND, { timeTrackingEnabled: true });
    expect(within(await timeCard()).getByText('No time logged yet.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Log time…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log time' });
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Hours' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Hours' }), '1');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Minutes' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Minutes' }), '25');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Called the carrier');
    await user.click(within(dialog).getByRole('button', { name: 'Log 1h 25m' }));

    const card = await timeCard();
    expect(await within(card).findByText('1h 25m total')).toBeVisible();
    expect(within(card).getByText(/Called the carrier/)).toBeVisible();
  });

  it('refuses a dialog that adds up to nothing', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND, { timeTrackingEnabled: true });

    await user.click(within(await timeCard()).getByRole('button', { name: 'Add time manually' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log time' });
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Minutes' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Minutes' }), '0');

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Minutes 0–59, hours 0–24. The total must be above zero.',
    );
    expect(within(dialog).getByRole('button', { name: 'Log time' })).toBeDisabled();
  });

  it('deletes an entry the viewer logged', async () => {
    const { user, tickets } = await openTicket(MOCK_TICKET_REFUND, { timeTrackingEnabled: true });
    await tickets.logTime('brand', MOCK_TICKET_REFUND, { seconds: 600 });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Log time…' }));
    await user.click(await screen.findByRole('button', { name: 'Log 30m' }));
    const card = await timeCard();
    await within(card).findByText('40m total');

    await user.click(
      within(card).getAllByRole('button', { name: 'Delete entry' })[0] as HTMLElement,
    );

    expect(await within(card).findByText('10m total')).toBeVisible();
  });

  it('starts the timer when the composer is opened, and sends its time with the reply', async () => {
    const { user, tickets } = await openTicket(MOCK_TICKET_REFUND, {
      timeTrackingEnabled: true,
      timerStartsWithComposer: true,
    });
    const card = await timeCard();
    expect(within(card).getByRole('timer')).toHaveAccessibleName('Timer paused, 0s');

    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    expect(within(card).getByRole('timer')).toHaveAccessibleName(/^Timer running/);

    // A second, so the timer has something to send.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'On it.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await within(card).findByText(/with reply/);
    const { entries } = await tickets.timeEntries('brand', MOCK_TICKET_REFUND);
    expect(entries[0]?.messageId).not.toBeNull();
    expect(within(card).getByRole('timer')).toHaveAccessibleName('Timer paused, 0s');
  });
});

describe('the survey on the ticket', () => {
  it('shows a rated survey’s score and comment', async () => {
    await openTicket(MOCK_TICKET_CLOSED);

    expect(await screen.findByText('Rated 4 of 5')).toBeVisible();
    expect(screen.getByText('Sorted quickly, thank you.')).toBeVisible();
  });

  it('shows a pending survey with its link to share once the ticket closes', async () => {
    const { user } = await openTicket(MOCK_TICKET_REFUND);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const details = screen.getByRole('complementary', { name: 'Ticket details' });
    await user.click(within(details).getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Closed' }));
    await user.click(await screen.findByRole('button', { name: 'Copy survey link' }));

    expect(screen.getByText('Survey not sent yet')).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/csat\/[A-Za-z0-9_-]{43}\./));
    expect(await screen.findByText('Survey link copied')).toBeVisible();
  });
});
