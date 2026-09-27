import type { Session } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { MOCK_BRANDS } from '../auth/mock-api.js';
import { SessionProvider } from '../auth/session.tsx';
import { MockNotificationsApi } from '../notifications/mock-api.js';
import { MockRealtimeClient } from '../realtime/mock-client.js';
import { RealtimeProvider } from '../realtime/realtime-provider.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { MOCK_TICKET_REFUND } from '../tickets/mock-api.js';
import { NotificationBell } from './notification-bell.tsx';

/**
 * The bell and its panel (M3-07). The count is in the bell's name as well as
 * on it; opening a row marks it read and goes to its ticket; a socket frame
 * for this brand refreshes the count.
 */

const BRAND = MOCK_BRANDS[0]?.id ?? '';

const session = async (): Promise<Session> => {
  const found = await (await signedInMockApis()).auth.me();
  if (found === null) {
    throw new Error('the fixture did not produce a session');
  }

  return found;
};

const Where = (): ReactNode => <output data-testid="where">ticket</output>;

const renderBell = async ({
  api = new MockNotificationsApi(),
  client = new MockRealtimeClient(),
} = {}) => {
  const rendered = renderApp(
    <SessionProvider session={await session()}>
      <RealtimeProvider client={client}>
        <Routes>
          <Route path="/tickets/:ticketId" element={<Where />} />
          <Route path="*" element={<NotificationBell />} />
        </Routes>
      </RealtimeProvider>
    </SessionProvider>,
    { notificationsApi: api, initialEntries: ['/tickets'] },
  );

  return { ...rendered, api, client };
};

const bell = (unread: number) =>
  screen.findByRole('button', {
    name: unread === 0 ? 'Notifications' : `Notifications, ${String(unread)} unread`,
  });

describe('NotificationBell', () => {
  it('says how many are unread, in its name as well as on it', async () => {
    await renderBell();

    expect(await bell(3)).toHaveTextContent('3');
  });

  it('opens the panel with the rows grouped by day, and marks them all read', async () => {
    const { user } = await renderBell();
    await user.click(await bell(3));

    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const list = within(panel).getByRole('list', { name: 'Notifications' });
    expect(within(list).getByText('SLA breach · first response')).toBeInTheDocument();
    expect(within(list).getByText('Omar Nasser mentioned you')).toBeInTheDocument();
    expect(within(list).getByText('Today')).toBeInTheDocument();
    expect(within(list).getAllByText('Unread')).toHaveLength(3);

    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(within(list).queryAllByText('Unread')).toHaveLength(0));
    within(panel).getByRole('button', { name: 'All' }).focus();
    await user.keyboard('{Escape}');
    expect(await bell(0)).toBeInTheDocument();
  });

  it('filters to the unread, and says so when there are none', async () => {
    const { user, api } = await renderBell();
    await api.markAllRead(BRAND);
    await user.click(await bell(3));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });

    await user.click(within(panel).getByRole('button', { name: 'Unread' }));

    expect(await within(panel).findByText('Nothing unread.')).toBeInTheDocument();
  });

  it('opens the ticket a row is about, and marks it read', async () => {
    const { user, api } = await renderBell();
    await user.click(await bell(3));
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });

    await user.click(within(panel).getByText('SLA breach · first response'));

    expect(await screen.findByTestId('where')).toBeInTheDocument();
    const after = await api.list(BRAND, 'all');
    expect(after.items.find((item) => item.ticketId === MOCK_TICKET_REFUND)?.readAt).not.toBeNull();
  });

  it('shows that nothing has happened in the last 30 days', async () => {
    const { user } = await renderBell({ api: new MockNotificationsApi({ items: [] }) });
    await user.click(await bell(0));

    expect(
      await screen.findByRole('heading', { name: 'You are all caught up' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Notification settings' })[0]).toHaveAttribute(
      'href',
      '/me/notifications',
    );
  });

  it('re-reads the count when the socket says there is something new for this brand', async () => {
    const api = new MockNotificationsApi({ items: [] });
    const { client } = await renderBell({ api });
    await bell(0);

    const [fresh] = (await new MockNotificationsApi().list(BRAND, 'unread')).items;
    if (fresh === undefined) {
      throw new Error('the fixture has an unread row');
    }
    const withOne = new MockNotificationsApi({ items: [fresh] });
    api.list = (brandId, filter) => withOne.list(brandId, filter);

    client.emitNotificationCreated({ brandId: 'another-brand', notificationId: fresh.id });
    client.emitNotificationCreated({ brandId: BRAND, notificationId: fresh.id });

    expect(await bell(1)).toBeInTheDocument();
  });

  it('says the list could not be loaded', async () => {
    const api = new MockNotificationsApi();
    api.list = () => Promise.reject(new Error('down'));
    const { user } = await renderBell({ api });
    await user.click(await bell(0));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Notifications could not be loaded. Try again in a moment.',
    );
  });
});
