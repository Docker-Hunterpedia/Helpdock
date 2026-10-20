import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MOCK_BRANDS } from '../auth/mock-api.js';
import { SessionProvider } from '../auth/session.tsx';
import { MockRealtimeClient } from '../realtime/mock-client.js';
import { RealtimeProvider } from '../realtime/realtime-provider.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { MockNotificationsApi } from './mock-api.js';
import { useNotificationList } from './use-notifications.js';

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const OTHER_BRAND = '01937f5e-7e53-7000-8000-0000000000ff';
const NOTIFICATION = '01937f5e-7e53-7000-8000-000000000001';

function Probe() {
  const all = useNotificationList('all');
  const unread = useNotificationList('unread');
  return (
    <>
      <output data-testid="all">{all.data?.unreadCount}</output>
      <output data-testid="unread">{unread.data?.unreadCount}</output>
    </>
  );
}

describe('notification realtime query invalidation', () => {
  it.each(['created', 'read'] as const)(
    'refreshes both filters on %s, only for the current brand',
    async (event) => {
      const session = await (await signedInMockApis()).auth.me();
      if (session === null) throw new Error('fixture did not produce a session');
      const api = new MockNotificationsApi();
      const list = vi.spyOn(api, 'list');
      const client = new MockRealtimeClient();
      renderApp(
        <SessionProvider session={session}>
          <RealtimeProvider client={client}>
            <Probe />
          </RealtimeProvider>
        </SessionProvider>,
        { notificationsApi: api },
      );
      await waitFor(() => {
        expect(screen.getByTestId('all')).toHaveTextContent('3');
        expect(screen.getByTestId('unread')).toHaveTextContent('3');
      });
      const emit = (brandId: string) => {
        const frame = { brandId, notificationId: NOTIFICATION };
        if (event === 'read') client.emitNotificationRead(frame);
        else client.emitNotificationCreated(frame);
      };
      await api.markAllRead(BRAND);
      list.mockClear();
      await act(async () => emit(OTHER_BRAND));
      expect(list).not.toHaveBeenCalled();
      expect(screen.getByTestId('all')).toHaveTextContent('3');
      act(() => emit(BRAND));
      await waitFor(() => {
        expect(screen.getByTestId('all')).toHaveTextContent('0');
        expect(screen.getByTestId('unread')).toHaveTextContent('0');
      });
    },
  );
});
