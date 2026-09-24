import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTicketTimer } from './use-ticket-timer.js';

/**
 * The per-reply timer with the clock under the test's control: it counts wall
 * time while running, keeps what it counted across a pause, and hands it over
 * once.
 */

let now = 1_000_000;
const clock = () => now;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  act(() => {
    now += ms;
    vi.advanceTimersByTime(ms);
  });
};

describe('useTicketTimer', () => {
  it('counts while running and stops counting while paused', () => {
    const { result } = renderHook(() => useTicketTimer('ticket-1', clock));

    act(() => {
      result.current.start();
    });
    advance(90_000);
    act(() => {
      result.current.pause();
    });
    advance(60_000);

    expect(result.current).toMatchObject({ seconds: 90, running: false });
  });

  it('adds a second run to the first', () => {
    const { result } = renderHook(() => useTicketTimer('ticket-1', clock));

    act(() => {
      result.current.start();
    });
    advance(30_000);
    act(() => {
      result.current.pause();
    });
    act(() => {
      result.current.start();
    });
    advance(15_000);

    expect(result.current.seconds).toBe(45);
  });

  it('hands over what it counted once, and starts again from zero', () => {
    const { result } = renderHook(() => useTicketTimer('ticket-1', clock));
    act(() => {
      result.current.start();
    });
    advance(42_000);

    let taken = 0;
    act(() => {
      taken = result.current.take();
    });

    expect(taken).toBe(42);
    expect(result.current).toMatchObject({ seconds: 0, running: false });
  });

  it('starts from zero on another ticket', () => {
    const { result, rerender } = renderHook(({ id }) => useTicketTimer(id, clock), {
      initialProps: { id: 'ticket-1' },
    });
    act(() => {
      result.current.start();
    });
    advance(20_000);

    rerender({ id: 'ticket-2' });

    expect(result.current).toMatchObject({ seconds: 0, running: false });
  });
});
