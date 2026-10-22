import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/session.tsx';
import type { ActivityReportResult, RealtimeClient, RealtimeListener } from '../realtime/client.js';
import { RealtimeListeners } from '../realtime/client.js';
import { RealtimeProvider } from '../realtime/realtime-provider.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { IDLE_RETURN_NOTICE_MS, IdleReturnNotice } from './idle-return-notice.tsx';

const SENTENCE =
  "You were set to away while idle. You're back now, and new tickets can be assigned to you again.";

class ReportingClient implements RealtimeClient {
  readonly listeners = new RealtimeListeners();
  answer: ActivityReportResult | null = { status: 'online', idleEnded: true };

  start(): void {
    this.listeners.connection('connected');
  }
  stop(): void {}
  presence() {
    return Promise.resolve({});
  }
  setPresence() {
    return Promise.resolve();
  }
  reportActivity() {
    return Promise.resolve(this.answer);
  }
  joinRoom() {
    return () => {};
  }
  announceViewing(): void {}
  subscribe(listener: RealtimeListener) {
    return this.listeners.add(listener);
  }
}

const render = async (client: ReportingClient) => {
  const { auth } = await signedInMockApis();
  const session = await auth.me();
  if (session === null) {
    throw new Error('the fixture did not produce a session');
  }

  return renderApp(
    <SessionProvider session={session}>
      <RealtimeProvider client={client}>
        <IdleReturnNotice />
      </RealtimeProvider>
    </SessionProvider>,
  );
};

describe('IdleReturnNotice (M14-18)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says it once, in a polite live region that takes no focus', async () => {
    await render(new ReportingClient());

    const notice = await screen.findByText(SENTENCE);

    const region = notice.closest('[aria-live]');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(document.body).toHaveFocus();
  });

  it('is an empty region, with no status role, until there is something to say', async () => {
    const client = new ReportingClient();
    client.answer = { status: 'online', idleEnded: false };

    const { container } = await render(client);

    expect(container.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });

  it('goes at the close button', async () => {
    const { user } = await render(new ReportingClient());
    await screen.findByText(SENTENCE);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });

  it('goes by itself after ten seconds, unless the pointer is on it', async () => {
    await render(new ReportingClient());
    const sentence = await screen.findByText(SENTENCE);
    const surface = sentence.parentElement as HTMLElement;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.mouseEnter(surface);
    await act(async () => {
      vi.advanceTimersByTime(IDLE_RETURN_NOTICE_MS * 3);
    });
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();

    fireEvent.mouseLeave(surface);
    await act(async () => {
      vi.advanceTimersByTime(IDLE_RETURN_NOTICE_MS - 1);
    });
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });
});
