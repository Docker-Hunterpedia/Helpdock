import type {
  PresenceMap,
  PresenceStatus,
  Session,
  SettablePresenceStatus,
} from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_BRANDS, MOCK_USER } from '../auth/mock-api.js';
import { SessionProvider } from '../auth/session.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import type { RealtimeClient, RealtimeListener } from './client.js';
import { RealtimeListeners } from './client.js';
import { RealtimeProvider, usePresence, useRealtime } from './realtime-provider.tsx';

const BRAND = MOCK_BRANDS[0]?.id ?? '';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
/**
 * Short enough that the watcher's real timer fires well inside `waitFor`'s
 * budget. Fake timers would not help: the watcher is armed in a mount effect,
 * so installing them afterwards leaves that timeout on the real clock.
 *
 * Only the away-timer tests ask for it. Every other test runs with a window
 * longer than any test run, because a timer that can fire during a test about
 * something else is a race, and on a slow machine it loses.
 */
const IDLE_MS = 20;
const NEVER_IDLE_MS = 600_000;

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

  announce(userId: string, status: PresenceStatus, brandId = BRAND): void {
    this.listeners.presenceChanged({ userId, brandId, status });
  }
}

function Probe(): ReactNode {
  const { connection, status, setStatus } = useRealtime();
  const presence = usePresence(BRAND);

  return (
    <div>
      <output data-testid="connection">{connection}</output>
      <output data-testid="status">{status}</output>
      <output data-testid="others">{JSON.stringify(presence)}</output>
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

const renderProbe = async (client: TestClient, idleMs = NEVER_IDLE_MS) =>
  renderApp(
    <SessionProvider session={await session()}>
      <RealtimeProvider client={client} idleMs={idleMs}>
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

  describe('the away timer', () => {
    it('sets away after the idle window and back to online on the next keypress', async () => {
      const { user } = await renderProbe(client, IDLE_MS);
      client.announce(MOCK_USER.id, 'online');
      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('online'));

      // The window between mounting and getting here is not ours to bound, and
      // the timer only restarts on a sign of life. This is that sign, so the
      // idle window that follows starts from a point the test chose.
      await user.keyboard('x');

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('away'));
      expect(client.set).toEqual(['away']);

      await user.keyboard('a');

      await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('online'));
      expect(client.set).toEqual(['away', 'online']);
    });

    it('leaves someone who is already offline alone', async () => {
      await renderProbe(client, IDLE_MS);

      // Long enough for the watcher to have fired had it been going to.
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 5));

      expect(client.set).toEqual([]);
      expect(screen.getByTestId('status')).toHaveTextContent('offline');
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
