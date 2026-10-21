import type {
  PresenceMap,
  PresenceStatus,
  Session,
  SettablePresenceStatus,
} from '@helpdock/schemas';
import { act, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_BRANDS, MOCK_USER } from '../auth/mock-api.js';
import { SessionProvider } from '../auth/session.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import type { ActivityReportResult, RealtimeClient, RealtimeListener } from './client.js';
import { RealtimeListeners } from './client.js';
import { RealtimeProvider, usePresence, useRealtime } from './realtime-provider.tsx';

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
/** A client a test drives: it never opens anything and announces on demand. */
class TestClient implements RealtimeClient {
  readonly rooms = new Set<string>();
  readonly announced: string[] = [];

  joinRoom(room: string): () => void {
    this.rooms.add(room);

    return () => {
      this.rooms.delete(room);
    };
  }

  announceViewing(ticketId: string): void {
    this.announced.push(ticketId);
  }

  readonly listeners = new RealtimeListeners();
  readonly started: string[] = [];
  readonly set: SettablePresenceStatus[] = [];
  stopped = 0;
  snapshot: PresenceMap = {};

  subscribe(listener: RealtimeListener): () => void {
    return this.listeners.add(listener);
  }

  start(brandId: string): void {
    this.started.push(brandId);
    this.listeners.connection('connected');
  }

  stop(): void {
    this.stopped += 1;
  }

  presence(): Promise<PresenceMap> {
    return Promise.resolve(this.snapshot);
  }

  setPresence(status: SettablePresenceStatus): Promise<void> {
    this.set.push(status);
    return Promise.resolve();
  }

  /** What the next activity report answers; a test chooses it. */
  reportAnswer: ActivityReportResult | null = null;
  reports = 0;
  failReports = false;

  reportActivity(): Promise<ActivityReportResult | null> {
    this.reports += 1;
    return this.failReports
      ? Promise.reject(new Error('socket closed'))
      : Promise.resolve(this.reportAnswer);
  }

  announce(userId: string, status: PresenceStatus, brandId = BRAND): void {
    this.listeners.presenceChanged({ userId, brandId, status });
  }
}

function Probe(): ReactNode {
  const { connection, status, setStatus, idleReturned, dismissIdleReturn } = useRealtime();
  const presence = usePresence(BRAND);

  return (
    <div>
      <output data-testid="connection">{connection}</output>
      <output data-testid="status">{status}</output>
      <output data-testid="others">{JSON.stringify(presence)}</output>
      <output data-testid="returned">{String(idleReturned)}</output>
      <button type="button" onClick={dismissIdleReturn}>
        dismiss
      </button>
      <button type="button" onClick={() => setStatus('away')}>
        away
      </button>
    </div>
  );
}

const session = async (): Promise<Session> => {
  const { auth } = await signedInMockApis();
  const found = await auth.me();
  if (found === null) {
    throw new Error('the fixture did not produce a session');
  }

  return found;
};

const renderProbe = async (client: TestClient) =>
  renderApp(
    <SessionProvider session={await session()}>
      <RealtimeProvider client={client}>
        <Probe />
      </RealtimeProvider>
    </SessionProvider>,
  );

describe('RealtimeProvider', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new TestClient();
  });

  it('joins the current brand and reports the connection', async () => {
    await renderProbe(client);

    expect(client.started).toEqual([BRAND]);
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));
  });

  it('renders the REST map first and then applies events to it', async () => {
    client.snapshot = { [OMAR]: 'away' };
    await renderProbe(client);

    await waitFor(() =>
      expect(screen.getByTestId('others')).toHaveTextContent(JSON.stringify({ [OMAR]: 'away' })),
    );

    client.announce(OMAR, 'online');
    await waitFor(() =>
      expect(screen.getByTestId('others')).toHaveTextContent(JSON.stringify({ [OMAR]: 'online' })),
    );
  });

  it('lets an event that arrived first win over the snapshot behind it', async () => {
    // The snapshot is a moment older than the event by the time it resolves;
    // overwriting with it would show a stale status.
    client.snapshot = { [MOCK_USER.id]: 'online' };
    await renderProbe(client);
    client.announce(MOCK_USER.id, 'away');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('away'));
  });

  it('ignores presence for a brand this tab is not watching', async () => {
    await renderProbe(client);
    client.announce(OMAR, 'online', MOCK_BRANDS[1]?.id ?? '');

    await waitFor(() => expect(screen.getByTestId('others')).toHaveTextContent('{}'));
  });

  it('is offline until the server says otherwise', async () => {
    await renderProbe(client);

    expect(screen.getByTestId('status')).toHaveTextContent('offline');
  });

  it('sends the toggle and shows it immediately, without waiting for the round trip', async () => {
    const { user } = await renderProbe(client);
    client.announce(MOCK_USER.id, 'online');

    await user.click(screen.getByRole('button', { name: 'away' }));

    expect(client.set).toEqual(['away']);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('away'));
  });

  it('puts nothing on the wire for a status this person is already in', async () => {
    const { user } = await renderProbe(client);
    client.announce(MOCK_USER.id, 'online');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('online'));

    // The account menu and the away timer can reach the same conclusion; the
    // second one to do so must not cost a round trip.
    await user.click(screen.getByRole('button', { name: 'away' }));
    await user.click(screen.getByRole('button', { name: 'away' }));

    expect(client.set).toEqual(['away']);
  });

  it('stops the client when the screen goes away', async () => {
    const { unmount } = await renderProbe(client);

    unmount();

    expect(client.stopped).toBe(1);
  });

  describe('activity reports (M14-18)', () => {
    const keypress = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });

    it('reports once on mount, and applies the status the server answers with', async () => {
      client.reportAnswer = { status: 'away', idleEnded: false };

      await renderProbe(client);

      await waitFor(() => expect(client.reports).toBe(1));
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('away'));
      expect(screen.getByTestId('returned')).toHaveTextContent('false');
    });

    it('raises the return notice only when a report ended an idle away', async () => {
      client.reportAnswer = { status: 'online', idleEnded: true };

      await renderProbe(client);

      await waitFor(() => expect(screen.getByTestId('returned')).toHaveTextContent('true'));
      expect(screen.getByTestId('status')).toHaveTextContent('online');
    });

    it('lets the notice be dismissed, and does not bring it back on its own', async () => {
      client.reportAnswer = { status: 'online', idleEnded: true };
      const { user } = await renderProbe(client);
      await waitFor(() => expect(screen.getByTestId('returned')).toHaveTextContent('true'));

      await user.click(screen.getByRole('button', { name: 'dismiss' }));
      client.reportAnswer = { status: 'online', idleEnded: false };
      await keypress();

      expect(screen.getByTestId('returned')).toHaveTextContent('false');
    });

    it("no longer sets itself away: that is the server's call now", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        await renderProbe(client);
        act(() => client.announce(MOCK_USER.id, 'online'));

        await act(async () => {
          vi.advanceTimersByTime(6 * 60 * 60_000);
        });

        expect(client.set).toEqual([]);
        expect(screen.getByTestId('status')).toHaveTextContent('online');
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives a report lost to a closed socket, and a connection that is not there yet', async () => {
      client.failReports = true;
      await renderProbe(client);
      await waitFor(() => expect(client.reports).toBe(1));

      client.failReports = false;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        await act(async () => {
          vi.advanceTimersByTime(61_000);
        });
        await keypress();
        expect(client.reports).toBe(2);
        expect(screen.getByTestId('status')).not.toHaveTextContent('away');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('useRealtime', () => {
  it('says what is missing rather than answering with nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderApp(<Probe />)).toThrow('useRealtime needs a <RealtimeProvider> above it');

    error.mockRestore();
  });
});
