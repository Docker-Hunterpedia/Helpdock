import type { Session, TicketViewingActivity } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { MOCK_BRANDS } from '../../auth/mock-api.js';
import { SessionProvider } from '../../auth/session.tsx';
import { MOCK_COLLEAGUE_ID, MockRealtimeClient } from '../../realtime/mock-client.js';
import { RealtimeProvider } from '../../realtime/realtime-provider.tsx';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_REFUND } from '../../tickets/mock-api.js';
import { useTicketRoom } from './use-ticket-realtime.js';

/**
 * The collision half of the ticket room (M1-09): this browser says "replying"
 * the moment its composer has something in it, and hears the same of others.
 */

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const SELF = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

function Probe(): ReactNode {
  const [activity, setActivity] = useState<TicketViewingActivity>('viewing');
  const { viewers } = useTicketRoom(BRAND, MOCK_TICKET_REFUND, SELF, activity);

  return (
    <div>
      <output data-testid="viewers">{JSON.stringify(viewers)}</output>
      <button type="button" onClick={() => setActivity('replying')}>
        type
      </button>
      <button type="button" onClick={() => setActivity('viewing')}>
        clear
      </button>
    </div>
  );
}

const session = async (): Promise<Session> => {
  const found = await (await signedInMockApis()).auth.me();
  if (found === null) {
    throw new Error('the fixture did not produce a session');
  }

  return found;
};

const renderProbe = async (client: MockRealtimeClient) =>
  renderApp(
    <SessionProvider session={await session()}>
      <RealtimeProvider client={client}>
        <Probe />
      </RealtimeProvider>
    </SessionProvider>,
  );

describe('useTicketRoom', () => {
  it('says "replying" at once when the composer fills, and "viewing" when it empties', async () => {
    const client = new MockRealtimeClient();
    const { user } = await renderProbe(client);
    await waitFor(() => expect(client.announcedActivity).toEqual(['viewing']));

    await user.click(screen.getByRole('button', { name: 'type' }));
    await waitFor(() => expect(client.announcedActivity.at(-1)).toBe('replying'));

    await user.click(screen.getByRole('button', { name: 'clear' }));
    await waitFor(() => expect(client.announcedActivity.at(-1)).toBe('viewing'));
  });

  it('hears who else is replying', async () => {
    const client = new MockRealtimeClient();
    await renderProbe(client);

    client.emitTicketViewing({
      brandId: BRAND,
      ticketId: MOCK_TICKET_REFUND,
      activity: 'replying',
      userId: MOCK_COLLEAGUE_ID,
    });

    await waitFor(() =>
      expect(screen.getByTestId('viewers')).toHaveTextContent(
        JSON.stringify([{ userId: MOCK_COLLEAGUE_ID, activity: 'replying' }]),
      ),
    );
  });
});
