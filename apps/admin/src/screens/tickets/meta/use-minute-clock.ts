import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

/**
 * A clock that moves once a minute (M10-08): as fine as a countdown in hours
 * needs, and as often as the ReplyWindowStrip may change what it draws. The
 * strip is a `role="status"`, so it must not rewrite itself every second; its
 * countdown is `aria-hidden`, and a screen reader hears the strip when its
 * state changes.
 *
 * It does not run while `enabled` is false, so a ticket that is not on a Meta
 * channel holds no timer.
 */
export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, MINUTE_MS);

    return () => {
      clearInterval(timer);
    };
  }, [enabled]);

  return now;
}
