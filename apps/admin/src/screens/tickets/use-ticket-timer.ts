import { useCallback, useEffect, useState } from 'react';

/**
 * The per-reply timer of the Time card (M1-12), kept in the browser.
 *
 * It is client-side on purpose: nothing is logged until the agent sends a reply
 * or presses Log, so a timer that is started and abandoned costs the server
 * nothing, and the api never has to know a timer exists. It measures wall time
 * between start and pause, so a tab that was throttled in the background still
 * counts the minutes it was open for.
 *
 * It belongs to one ticket: opening another starts from zero.
 */

export interface TicketTimer {
  /** Whole seconds counted so far. */
  readonly seconds: number;
  readonly running: boolean;
  start(): void;
  pause(): void;
  /** Stops the timer, resets it, and returns what it had counted. */
  take(): number;
}

interface TimerState {
  /** What earlier runs counted. */
  readonly bankedMs: number;
  /** When the current run began, or null while paused. */
  readonly startedAt: number | null;
}

const IDLE: TimerState = { bankedMs: 0, startedAt: null };
const TICK_MS = 1000;

const elapsedMs = (state: TimerState, now: number): number =>
  state.bankedMs + (state.startedAt === null ? 0 : now - state.startedAt);

export function useTicketTimer(ticketId: string, clock: () => number = Date.now): TicketTimer {
  const [state, setState] = useState<TimerState>(IDLE);
  const [now, setNow] = useState(clock);
  const [owner, setOwner] = useState(ticketId);

  // A different ticket is a different piece of work. Reset while rendering,
  // which React re-runs at once, rather than in an effect that would paint the
  // old ticket's count on the new ticket for a frame.
  if (owner !== ticketId) {
    setOwner(ticketId);
    setState(IDLE);
  }

  useEffect(() => {
    if (state.startedAt === null) {
      return;
    }

    const interval = setInterval(() => {
      setNow(clock());
    }, TICK_MS);

    return () => {
      clearInterval(interval);
    };
  }, [state.startedAt, clock]);

  const start = useCallback(() => {
    const at = clock();
    setNow(at);
    setState((held) => (held.startedAt === null ? { ...held, startedAt: at } : held));
  }, [clock]);

  const pause = useCallback(() => {
    const at = clock();
    setNow(at);
    setState((held) =>
      held.startedAt === null ? held : { bankedMs: elapsedMs(held, at), startedAt: null },
    );
  }, [clock]);

  const take = useCallback((): number => {
    const counted = Math.floor(elapsedMs(state, clock()) / 1000);
    setState(IDLE);

    return counted;
  }, [state, clock]);

  return {
    seconds: Math.floor(elapsedMs(state, Math.max(now, state.startedAt ?? 0)) / 1000),
    running: state.startedAt !== null,
    start,
    pause,
    take,
  };
}
