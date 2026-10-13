import type { MetaPlatform, ReplyWindowView } from '@helpdock/schemas';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import { type StripState, stripState } from './reply-window.js';
import { ReplyWindowStrip } from './reply-window-strip.tsx';
import { useMinuteClock } from './use-minute-clock.js';

/**
 * The ReplyWindowStrip in each of its states (DESIGN §6.3, `Admin/Ticket-Meta`
 * panel 4) and its countdown. The clock is fixed at 10:31 local on 11 October
 * 2026, which is also what the Meta ticket fixture is measured from.
 */

const NOW = new Date(2026, 9, 11, 10, 31, 0);
const MINUTE = 60_000;

const at = (day: number, hour: number, minute: number): string =>
  new Date(2026, 9, day, hour, minute).toISOString();

const state = (window: ReplyWindowView, now = NOW.getTime()): StripState =>
  stripState(window, now, null);

const renderStrip = (
  value: StripState,
  platform: MetaPlatform = 'whatsapp',
  customerName = 'Daniel Reyes',
) =>
  renderApp(
    <ReplyWindowStrip
      id="meta-strip"
      state={value}
      platform={platform}
      customerName={customerName}
      now={NOW.getTime()}
    />,
  );

const strip = (): HTMLElement => screen.getByRole('status');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('ReplyWindowStrip', () => {
  it('says the window is open, how long is left and when it closes, naming the rule at the end', () => {
    renderStrip(state({ state: 'open', closesAt: at(12, 9, 25) }));

    expect(strip()).toHaveTextContent(
      'Reply window open · 22h 54m left · closes tomorrow at 09:25WhatsApp · 24 hours after the customer’s last message',
    );
    expect(strip().querySelector('svg.lucide-clock')).not.toBeNull();
  });

  it('is the one role="status", with its id for Send to be described by', () => {
    renderStrip(state({ state: 'open', closesAt: at(12, 9, 25) }));

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(strip()).toHaveAttribute('id', 'meta-strip');
  });

  it('keeps the countdown out of what is read and puts the closing time in a <time>', () => {
    renderStrip(state({ state: 'open', closesAt: at(12, 9, 25) }));

    const countdown = within(strip()).getByText(/22h 54m/);
    expect(countdown.closest('[aria-hidden="true"]')).not.toBeNull();
    const closes = within(strip()).getByText('tomorrow at 09:25');
    expect(closes.tagName).toBe('TIME');
    expect(closes).toHaveAttribute('dateTime', at(12, 9, 25));
    expect(closes.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('turns to the warning in the last hour and says what to do', () => {
    const closing = state({ state: 'open', closesAt: at(11, 11, 9) });
    renderStrip(closing);

    expect(closing.kind).toBe('closing');
    expect(strip()).toHaveTextContent(
      'Reply window closing · 38m left · closes today at 11:09. Send now, or the customer must write first.',
    );
    // The warning tone is the warning edge, not the neutral one, and the icon stays a clock.
    expect(strip().querySelector('svg.lucide-clock')).not.toBeNull();
    expect(strip().querySelector('svg.lucide-ban')).toBeNull();
  });

  it('names the Human Agent days, who may use them, and the platform’s 7 days', () => {
    renderStrip(state({ state: 'human_agent', closesAt: at(16, 10, 2) }), 'messenger');

    expect(strip()).toHaveTextContent(
      'Human Agent window · 4d 23h left · closes Friday at 10:02. Only a person’s reply may use it; AI and rule replies stopped at 24 hours.Messenger · 7 days',
    );
    expect(strip().querySelector('svg.lucide-user-check')).not.toBeNull();
  });

  it('says closed with a ban, when it closed and that the platform accepts no reply (WhatsApp)', () => {
    renderStrip(state({ state: 'closed', closedAt: at(11, 9, 25) }));

    expect(strip()).toHaveTextContent(
      'Reply window closed · It closed 1 hour ago, today at 09:25. WhatsApp accepts no reply until Daniel Reyes writes again.',
    );
    expect(strip().querySelector('svg.lucide-ban')).not.toBeNull();
    // No template button until M10-09 ships it, and no counting caption.
    expect(within(strip()).queryByRole('button')).toBeNull();
    expect(strip()).not.toHaveTextContent('internal note');
  });

  it('adds that an internal note is still possible on Messenger and Instagram', () => {
    renderStrip(state({ state: 'closed', closedAt: at(4, 9, 36) }), 'instagram', 'Sara M.');

    expect(strip()).toHaveTextContent(
      'Reply window closed · It closed 7 days ago, Oct 4 at 09:36. Instagram accepts no reply until Sara M. writes again. You can still add an internal note.',
    );
  });

  it('says so when the customer never wrote, instead of a time it does not have', () => {
    renderStrip(state({ state: 'closed', closedAt: null }), 'messenger', 'the customer');

    expect(strip()).toHaveTextContent(
      'Reply window closed · the customer has not written to this account yet. Messenger accepts no reply until the customer writes again.',
    );
    expect(within(strip()).queryByRole('time')).toBeNull();
  });

  it('adds a second line when the api refused a reply the strip still called open', () => {
    const refused = stripState({ state: 'open', closesAt: at(12, 9, 25) }, NOW.getTime(), {
      closedAt: at(11, 10, 31),
    });
    renderStrip(refused);

    expect(refused).toMatchObject({ kind: 'closed', refused: true });
    expect(strip()).toHaveTextContent(
      'Not sent: the window closed today at 10:31 while you were writing. Your text is kept below; it can go out once Daniel Reyes writes again.',
    );
    // Both lines name the instant the window closed, each in a <time>.
    const times = within(strip()).getAllByText('today at 10:31', { selector: 'time' });
    expect(times).toHaveLength(2);
    expect(times.every((time) => time.getAttribute('datetime') === at(11, 10, 31))).toBe(true);
  });

  it('is in Arabic, with the times and the countdown in Latin digits', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderStrip(state({ state: 'open', closesAt: at(12, 9, 25) }));

    expect(strip()).toHaveTextContent('نافذة الرد مفتوحة');
    expect(strip()).toHaveTextContent('22h 54m');
    expect(strip().textContent).not.toMatch(/[٠-٩۰-۹]/);
    expect(within(strip()).getByText(/غدًا في 09:25/).tagName).toBe('TIME');
  });
});

describe('stripState', () => {
  const open: ReplyWindowView = { state: 'open', closesAt: at(12, 9, 25) };

  it('is open until the last hour, closing in it, and closed from the instant it ends', () => {
    expect(stripState(open, new Date(2026, 9, 12, 8, 24).getTime(), null).kind).toBe('open');
    expect(stripState(open, new Date(2026, 9, 12, 8, 25).getTime(), null).kind).toBe('closing');
    expect(stripState(open, new Date(2026, 9, 12, 9, 24, 59).getTime(), null).kind).toBe('closing');
    expect(stripState(open, new Date(2026, 9, 12, 9, 25).getTime(), null)).toEqual({
      kind: 'closed',
      closedAt: at(12, 9, 25),
      refused: false,
    });
  });

  it('runs a Human Agent window to its end and never calls it closing', () => {
    const extended: ReplyWindowView = { state: 'human_agent', closesAt: at(12, 9, 25) };

    expect(stripState(extended, new Date(2026, 9, 12, 9, 0).getTime(), null).kind).toBe(
      'humanAgent',
    );
    expect(stripState(extended, new Date(2026, 9, 12, 9, 25).getTime(), null).kind).toBe('closed');
  });

  it('takes the refusal over the window, and its time over the window’s', () => {
    expect(
      stripState({ state: 'closed', closedAt: at(11, 9, 25) }, NOW.getTime(), { closedAt: null }),
    ).toEqual({ kind: 'closed', closedAt: at(11, 9, 25), refused: true });
    expect(stripState(open, NOW.getTime(), { closedAt: at(11, 10, 31) })).toEqual({
      kind: 'closed',
      closedAt: at(11, 10, 31),
      refused: true,
    });
  });
});

describe('the countdown', () => {
  /** What `useTicketMeta` does: one clock, once a minute, read against the api's window. */
  function Live({ window }: { readonly window: ReplyWindowView }) {
    const now = useMinuteClock(true);

    return (
      <ReplyWindowStrip
        id="meta-strip"
        state={stripState(window, now, null)}
        platform="whatsapp"
        customerName="Daniel Reyes"
        now={now}
      />
    );
  }

  const tick = (minutes: number): void => {
    act(() => {
      vi.advanceTimersByTime(minutes * MINUTE);
    });
  };

  it('moves once a minute and not before', () => {
    renderApp(<Live window={{ state: 'open', closesAt: at(12, 9, 25) }} />);
    expect(strip()).toHaveTextContent('22h 54m left');

    tick(0.99);
    expect(strip()).toHaveTextContent('22h 54m left');

    tick(0.02);
    expect(strip()).toHaveTextContent('22h 53m left');

    tick(60);
    expect(strip()).toHaveTextContent('21h 53m left');
  });

  it('turns to the warning when the last hour starts, and to closed at the instant it ends, without a request', () => {
    renderApp(<Live window={{ state: 'open', closesAt: at(11, 11, 40) }} />);
    expect(strip()).toHaveTextContent('Reply window open · 1h 09m left');

    tick(9);
    expect(strip()).toHaveTextContent('Reply window closing · 1h left');

    tick(1);
    expect(strip()).toHaveTextContent('Reply window closing · 59m left');

    tick(58);
    expect(strip()).toHaveTextContent('Reply window closing · 1m left');

    tick(1);
    expect(strip()).toHaveTextContent('Reply window closed · It closed');
    expect(strip().querySelector('svg.lucide-ban')).not.toBeNull();
  });

  it('is the same element throughout, so a screen reader hears the strip when its state changes', () => {
    renderApp(<Live window={{ state: 'open', closesAt: at(11, 11, 40) }} />);
    const before = strip();

    tick(5);

    expect(strip()).toBe(before);
  });

  it('stops the clock when the strip goes away', () => {
    const { unmount } = renderApp(<Live window={{ state: 'open', closesAt: at(12, 9, 25) }} />);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
